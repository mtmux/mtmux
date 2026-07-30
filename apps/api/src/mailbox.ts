import crypto from "node:crypto";
import { MAX_PEERS_PER_SLOT, type PairingServerMessage } from "@repo/protocol";

/**
 * Pending pairings, keyed by mailbox and indexed by slot.
 *
 * The broker's entire knowledge of a pairing lives here, and it is deliberately
 * thin: a two-digit slot, opaque blobs in flight, and timers. There is no
 * password, no hash of one, and no mapping from a mailbox to an IP — a
 * subpoena or a heap dump should yield nothing worth having.
 *
 * `MailboxStore` is an interface with an in-memory implementation because the
 * wire protocol never assumes locality. Swapping in Redis or Durable Objects
 * later is a matter of reimplementing this file.
 */

export const MAILBOX_TTL_MS = 3 * 60 * 1000;

/**
 * Live mailboxes allowed on one slot.
 *
 * A slot is two digits and deliberately shared, so honest collisions happen and
 * the number cannot be one. But it must be small: a claim is fanned out to
 * every live mailbox on the slot, so `M` mailboxes seeded with `M` different
 * guessed secrets buy an attacker `M` parallel tries against each victim claim
 * — odds of `M / 10^6` per pairing, for the price of `M` POSTs. Capping at two
 * keeps honest collisions working and squatting worthless.
 *
 * Shared with the claimants through `@repo/protocol`, which is what lets them
 * refuse a broker that offers more peers than this.
 */
export const MAX_MAILBOXES_PER_SLOT = MAX_PEERS_PER_SLOT;

/**
 * Live mailboxes across every slot. Bounds the store's memory; the per-IP
 * mailbox limiter is what stops one client getting near it.
 */
export const MAX_LIVE_MAILBOXES = 10_000;

/**
 * How long a POSTed claim holds a mailbox before its socket must attach.
 *
 * A claim reserves the mailboxes it was fanned out to, and only *burns* them
 * once it proves itself by opening its WebSocket. Without the reservation two
 * claims could race the same mailbox and each get a guess; without the lapse a
 * bare POST would take a code out of circulation for its whole TTL. The window
 * only has to cover POST → upgrade on a live connection.
 */
export const OFFER_TTL_MS = 10 * 1000;

/** Where broker-generated messages go once a socket is attached. */
export type Sink = (message: PairingServerMessage) => void;

export type Mailbox = {
  readonly id: string;
  readonly slot: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Set once a claim has *proved itself* by attaching its socket. A mailbox is
   * burned by exactly one claim in its lifetime; that single-shot rule is what
   * caps an attacker at one 1-in-10,000 guess per code.
   *
   * Deliberately not set at POST time. An unauthenticated POST costs nothing,
   * so burning on it let one request retire every pairing on a slot — a
   * service-wide outage with no crypto and no protocol participation.
   */
  claimedBy: string | null;
  /**
   * Claim this mailbox has been fanned out to but which has not yet attached a
   * socket. Routing follows this as well as `claimedBy`, so the holder can
   * answer immediately; liveness does not, so the mailbox is not offered to a
   * second claim while one is in flight.
   */
  offeredTo: string | null;
  /** When an unproven offer lapses and the mailbox is offerable again. */
  offerExpiresAt: number;
  /** Opaque handle shared with the claimant for this conversation. */
  peer: string | null;
  sink: Sink | null;
  /** Messages produced before a socket attached. Bounded by the TTL. */
  pending: PairingServerMessage[];
};

export type Claim = {
  readonly id: string;
  readonly slot: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  sink: Sink | null;
  pending: PairingServerMessage[];
  /** peer handle → mailbox id, for routing replies back. */
  readonly peers: Map<string, string>;
};

export interface MailboxStore {
  /**
   * Open a mailbox on a slot, or null when the slot or the store is full.
   * A null is the caller's cue to draw a fresh slot and try again.
   */
  createMailbox(slot: string, now?: number): Mailbox | null;
  getMailbox(id: string, now?: number): Mailbox | null;
  /**
   * Every mailbox on a slot that is live, unburned, and not already in flight
   * with another claim.
   */
  liveMailboxesForSlot(slot: string, now?: number): Mailbox[];
  /** Fan a claim out to a mailbox without yet spending its single guess. */
  offerMailbox(
    mailbox: Mailbox,
    claimId: string,
    peer: string,
    now?: number,
  ): void;
  /**
   * Spend the guess. Called when a claim attaches its socket, which is the
   * first point at which it has done anything an attacker cannot do for free.
   */
  burnOffer(mailbox: Mailbox, claimId: string): void;
  /** The claim a mailbox is talking to, proven or merely offered. */
  claimIdFor(mailbox: Mailbox, now?: number): string | null;
  destroyMailbox(id: string): void;

  createClaim(slot: string, now?: number): Claim;
  getClaim(id: string, now?: number): Claim | null;
  destroyClaim(id: string): void;

  /** Deliver to a sink, buffering if the socket has not attached yet. */
  deliver(target: Mailbox | Claim, message: PairingServerMessage): void;
  /** Attach a socket and flush anything buffered for it. */
  attach(target: Mailbox | Claim, sink: Sink): void;

  sweep(now?: number): void;
  /** Diagnostics only — counts, never contents. */
  stats(): { mailboxes: number; claims: number };
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(16).toString("base64url")}`;
}

/**
 * Cap on buffered messages per target. A conversation is a handful of small
 * messages; anything more is a bug or an attempt to use the broker as storage.
 */
const MAX_PENDING = 16;

export function createMailboxStore(
  ttlMs: number = MAILBOX_TTL_MS,
): MailboxStore {
  const mailboxes = new Map<string, Mailbox>();
  const claims = new Map<string, Claim>();
  /** slot → mailbox ids. Kept alongside so fan-out is not a full scan. */
  const bySlot = new Map<string, Set<string>>();

  function expired(entry: { expiresAt: number }, now: number): boolean {
    return entry.expiresAt <= now;
  }

  function removeMailbox(id: string): void {
    const mailbox = mailboxes.get(id);
    if (!mailbox) return;
    mailboxes.delete(id);
    const slotSet = bySlot.get(mailbox.slot);
    if (slotSet) {
      slotSet.delete(id);
      if (slotSet.size === 0) bySlot.delete(mailbox.slot);
    }
  }

  return {
    createMailbox(slot, now = Date.now()) {
      // Expire before counting, so a slot is never reported full on the
      // strength of mailboxes that have already timed out.
      let liveOnSlot = 0;
      for (const mailboxId of [...(bySlot.get(slot) ?? [])]) {
        const existing = mailboxes.get(mailboxId);
        if (!existing || expired(existing, now)) removeMailbox(mailboxId);
        else liveOnSlot += 1;
      }
      if (liveOnSlot >= MAX_MAILBOXES_PER_SLOT) return null;
      if (mailboxes.size >= MAX_LIVE_MAILBOXES) return null;

      const mailbox: Mailbox = {
        id: id("mbx"),
        slot,
        createdAt: now,
        expiresAt: now + ttlMs,
        claimedBy: null,
        offeredTo: null,
        offerExpiresAt: 0,
        peer: null,
        sink: null,
        pending: [],
      };
      mailboxes.set(mailbox.id, mailbox);
      let slotSet = bySlot.get(slot);
      if (!slotSet) {
        slotSet = new Set();
        bySlot.set(slot, slotSet);
      }
      slotSet.add(mailbox.id);
      return mailbox;
    },

    getMailbox(id, now = Date.now()) {
      const mailbox = mailboxes.get(id);
      if (!mailbox) return null;
      if (expired(mailbox, now)) {
        removeMailbox(id);
        return null;
      }
      return mailbox;
    },

    liveMailboxesForSlot(slot, now = Date.now()) {
      const slotSet = bySlot.get(slot);
      if (!slotSet) return [];
      const live: Mailbox[] = [];
      for (const mailboxId of [...slotSet]) {
        const mailbox = mailboxes.get(mailboxId);
        if (!mailbox || expired(mailbox, now)) {
          removeMailbox(mailboxId);
          continue;
        }
        // One claim per mailbox, ever.
        if (mailbox.claimedBy !== null) continue;
        // An offer that never attached a socket lapses, and the mailbox
        // returns to circulation rather than being lost for its whole TTL.
        if (mailbox.offeredTo !== null) {
          if (mailbox.offerExpiresAt > now) continue;
          mailbox.offeredTo = null;
          mailbox.offerExpiresAt = 0;
          mailbox.peer = null;
        }
        live.push(mailbox);
      }
      return live;
    },

    offerMailbox(mailbox, claimId, peer, now = Date.now()) {
      mailbox.offeredTo = claimId;
      mailbox.offerExpiresAt = now + OFFER_TTL_MS;
      mailbox.peer = peer;
    },

    burnOffer(mailbox, claimId) {
      // Only the claim the mailbox is actually talking to can spend its guess.
      if (mailbox.offeredTo !== claimId) return;
      mailbox.claimedBy = claimId;
    },

    claimIdFor(mailbox, now = Date.now()) {
      if (mailbox.claimedBy !== null) return mailbox.claimedBy;
      if (mailbox.offeredTo !== null && mailbox.offerExpiresAt > now) {
        return mailbox.offeredTo;
      }
      return null;
    },

    destroyMailbox: removeMailbox,

    createClaim(slot, now = Date.now()) {
      const claim: Claim = {
        id: id("clm"),
        slot,
        createdAt: now,
        expiresAt: now + ttlMs,
        sink: null,
        pending: [],
        peers: new Map(),
      };
      claims.set(claim.id, claim);
      return claim;
    },

    getClaim(id, now = Date.now()) {
      const claim = claims.get(id);
      if (!claim) return null;
      if (expired(claim, now)) {
        claims.delete(id);
        return null;
      }
      return claim;
    },

    destroyClaim(id) {
      claims.delete(id);
    },

    deliver(target, message) {
      if (target.sink) {
        target.sink(message);
        return;
      }
      // The CLI POSTs its claim and only then opens the socket, so fan-out can
      // legitimately beat the connection. Buffering removes that race.
      if (target.pending.length < MAX_PENDING) target.pending.push(message);
    },

    attach(target, sink) {
      target.sink = sink;
      const buffered = target.pending.splice(0);
      for (const message of buffered) sink(message);
    },

    sweep(now = Date.now()) {
      for (const [mailboxId, mailbox] of mailboxes) {
        if (expired(mailbox, now)) removeMailbox(mailboxId);
      }
      for (const [claimId, claim] of claims) {
        if (expired(claim, now)) claims.delete(claimId);
      }
    },

    stats() {
      return { mailboxes: mailboxes.size, claims: claims.size };
    },
  };
}

/** Opaque per-conversation handle. */
export function newPeerHandle(): string {
  return `peer-${crypto.randomBytes(12).toString("base64url")}`;
}

import crypto from "node:crypto";
import { MAX_PEERS_PER_SLOT, type PairingServerMessage } from "@repo/protocol";

/**
 * Pending pairings, keyed by mailbox and indexed by slot.
 *
 * The broker's entire knowledge of a pairing lives here, and it is deliberately
 * thin: a three-digit slot, opaque blobs in flight, and timers. There is no
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
 * A slot is three digits and deliberately shared, so honest collisions happen and
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
 *
 * The binding limit is `SLOT_COUNT × MAX_MAILBOXES_PER_SLOT`, which the
 * three-digit slot takes from 200 to 4000 in the typed space, with 20,000 scan
 * slots behind it. Two digits was the real ceiling on the whole service —
 * about 100 concurrent `mtmux start`s, since each consumes a typed mailbox and
 * a scan one — and the reason the slot had to widen.
 */
export const MAX_LIVE_MAILBOXES = 10_000;

/**
 * How long a claim lives before its socket must attach.
 *
 * A claim now reserves nothing: fan-out happens when the socket attaches, so a
 * POST that never connects has taken no mailbox out of circulation and there is
 * nothing to lapse. What remains is bookkeeping — an unattached claim is an
 * object in a map, and a POST flood should not be able to park them for three
 * minutes. Fifteen seconds covers POST → upgrade on any live connection, and
 * `extendClaim` gives the claim the full mailbox TTL the moment it attaches, so
 * a slow exchange is never cut short.
 */
export const CLAIM_ATTACH_TTL_MS = 15 * 1000;

/** Where broker-generated messages go once a socket is attached. */
export type Sink = (message: PairingServerMessage) => void;

export type Mailbox = {
  readonly id: string;
  readonly slot: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Set once, by the claim that this mailbox was fanned out to when that claim
   * attached its socket. A mailbox is claimed by exactly one claim in its
   * lifetime; that single-shot rule is what caps an attacker at one
   * 1-in-1,000,000 guess per code.
   *
   * There is deliberately no intermediate "offered" state. Fan-out and claim
   * are now the same instant — an attaching socket is the first thing a
   * claimant does that a flood of anonymous POSTs cannot — so there is no
   * window in which a mailbox is spoken for but not yet spent, and therefore no
   * way to hold a code hostage without spending a guess on it.
   */
  claimedBy: string | null;
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
  /**
   * Two clocks: `CLAIM_ATTACH_TTL_MS` from creation, then the full mailbox TTL
   * from the moment a socket attaches. Mutable for exactly that reason.
   */
  expiresAt: number;
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
  /** Every mailbox on a slot that is live and unclaimed. Never mutates. */
  liveMailboxesForSlot(slot: string, now?: number): Mailbox[];
  /**
   * Spend the guess: bind a mailbox to a claim, once and only once.
   *
   * Returns whether this claim won. A boolean rather than a void makes the
   * single-shot rule testable, and makes the contract a compare-and-set that a
   * Redis or Durable Objects store can implement honestly.
   */
  claimMailbox(mailbox: Mailbox, claimId: string, peer: string): boolean;
  destroyMailbox(id: string): void;

  createClaim(slot: string, now?: number): Claim;
  getClaim(id: string, now?: number): Claim | null;
  /** Give an attached claim the full mailbox TTL. */
  extendClaim(claim: Claim, now?: number): void;
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
        live.push(mailbox);
      }
      return live;
    },

    claimMailbox(mailbox, claimId, peer) {
      if (mailbox.claimedBy !== null) return false;
      mailbox.claimedBy = claimId;
      mailbox.peer = peer;
      return true;
    },

    destroyMailbox: removeMailbox,

    createClaim(slot, now = Date.now()) {
      const claim: Claim = {
        id: id("clm"),
        slot,
        createdAt: now,
        expiresAt: now + CLAIM_ATTACH_TTL_MS,
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

    extendClaim(claim, now = Date.now()) {
      claim.expiresAt = now + ttlMs;
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

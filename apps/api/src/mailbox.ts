import crypto from "node:crypto";
import type { PairingServerMessage } from "@repo/protocol";

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

/** Where broker-generated messages go once a socket is attached. */
export type Sink = (message: PairingServerMessage) => void;

export type Mailbox = {
  readonly id: string;
  readonly slot: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Set once a claim has been offered. A mailbox accepts exactly one claim in
   * its lifetime; that single-shot rule is what caps an attacker at one
   * 1-in-10,000 guess per code.
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
  readonly expiresAt: number;
  sink: Sink | null;
  pending: PairingServerMessage[];
  /** peer handle → mailbox id, for routing replies back. */
  readonly peers: Map<string, string>;
};

export interface MailboxStore {
  createMailbox(slot: string, now?: number): Mailbox;
  getMailbox(id: string, now?: number): Mailbox | null;
  /** Every live, unclaimed mailbox on a slot. */
  liveMailboxesForSlot(slot: string, now?: number): Mailbox[];
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

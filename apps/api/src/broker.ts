import crypto from "node:crypto";
import { createLogger } from "@repo/logger";
import {
  PairClaimRequest,
  PairNewRequest,
  // Long enough to walk to the machine and read six digits; short enough that
  // a request nobody answers does not hold a slot on that machine forever.
  // Shared so the browser's countdown cannot drift from it.
  REQUEST_TTL_MS,
  tryDeserializePairingClientMessage,
  tryDeserializeRequestClientMessage,
  tryDeserializeTunnelClientMessage,
  type PairingServerMessage,
  type RequestServerMessage,
  type TunnelServerMessage,
} from "@repo/protocol";
import {
  deviceIdFor,
  hexToBytes,
  verifyChallenge,
  randomBytes,
  bytesToHex,
  generateSlot,
  generateQrSlot,
} from "@repo/crypto";
import {
  createMailboxStore,
  newPeerHandle,
  type Claim,
  type Mailbox,
  type MailboxStore,
} from "./mailbox.js";
import { createTunnelRegistry, type TunnelRegistry } from "./tunnel.js";
import { resolveTunnelIdSecret } from "./tunnel-id.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

const logger = createLogger("api:broker");

/**
 * How many slots to try before reporting the broker full.
 *
 * P(503) is the fill fraction to this power, so the difference between 8 and 12
 * is the difference between 17% and 6.9% of honest callers turned away when the
 * typed space is 80% full. The draws stay *random*: a deterministic "first free
 * slot" fallback would let an attacker who fills slots steer the next victim
 * onto a slot it knows, which is worth far more to it than a 503 costs us.
 */
const SLOT_DRAWS = 12;

/** Bucket key for limits that are deliberately not per-caller. */
const GLOBAL_KEY = "*";

/**
 * Seconds for a `Retry-After` on a busy broker, jittered.
 *
 * Every agent that gets a 503 reads the same number, so a fixed one brings them
 * all back at the same instant and re-creates the collision they were told to
 * wait out.
 */
function retryAfterSeconds(random: () => number = Math.random): number {
  return 3 + Math.floor(random() * 5);
}

/** A request is four messages; more than this is a bug or an abuse. */
const MAX_PENDING_REQUEST = 8;

/**
 * Bucket key for the per-slot claim limit.
 *
 * Read off the raw body before validation, because a malformed claim should
 * still be charged to whichever slot it names — otherwise the limit is dodged
 * by sending rubbish. An unreadable slot falls back to the global bucket.
 */
function slotKeyOf(rawBody: unknown): string {
  const slot = (rawBody as { slot?: unknown } | null)?.slot;
  return typeof slot === "string" ? `slot:${slot}` : GLOBAL_KEY;
}

/**
 * The pairing broker.
 *
 * Everything here is deliberately blind. The broker routes by a public
 * two-digit slot, copies opaque blobs between two sockets, and enforces
 * quotas. It never sees the four-digit secret, the derived keys, or a single
 * byte of terminal traffic — and it must stay that way, because a broker that
 * knew the whole code could run the PAKE against both sides at once and hand
 * an attacker a root shell.
 *
 * Logging follows from that: counts and outcomes only. No blob, ciphertext,
 * slot, mailbox id, or IP-to-mailbox mapping is ever written down.
 *
 * ## Why the two sockets are symmetric
 *
 * There are two roles here — the mailbox holder, who parks a slot and waits,
 * and the claimant, who quotes the slot — and they used to be hard-wired to
 * "browser" and "CLI" respectively. That made `mtmux start` unable to print a
 * code for a phone to scan: the CLI could only ever be the claimant.
 *
 * Nothing about brokering needs to know which end runs a terminal. So both
 * sockets now accept the same four client messages and route them to the
 * counterpart, and the direction of the pairing is entirely a matter of which
 * side opened the mailbox. That is one fewer thing the broker knows, which is
 * the direction this file should always move in.
 */

/** Minimal socket shape, so the logic is testable without real WebSockets. */
export type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type BrokerDeps = {
  store?: MailboxStore;
  tunnels?: TunnelRegistry;
  claimLimiter?: RateLimiter;
  mailboxLimiter?: RateLimiter;
  /** Claims per minute against one slot, regardless of source. */
  slotClaimLimiter?: RateLimiter;
  /** Claims per minute against the whole broker, regardless of source. */
  globalClaimLimiter?: RateLimiter;
  /** Per-IP ceiling on `/v1/discover`. */
  discoverLimiter?: RateLimiter;
  /** Per-IP ceiling on WebSocket upgrades. */
  upgradeLimiter?: RateLimiter;
  quotas?: { maxBytes: number; maxMinutes: number; maxStreams: number };
  /**
   * Ties a tunnel to an account, so plan limits mean something and usage can
   * be billed.
   *
   * Optional by design: with no database — every self-hosted install — this is
   * absent and tunnels are simply unmetered. Nothing here may ever be able to
   * *prevent* an anonymous pairing, only an over-quota account's.
   */
  metering?: Metering;
  now?: () => number;
};

export type Metering = {
  ownerOfDevice(publicKey: string): Promise<{ userId: string } | null>;
  checkTunnel(
    userId: string | null,
  ): Promise<{ allowed: boolean; reason?: string }>;
  recordUsage(userId: string, bytes: number, seconds: number): Promise<void>;
};

export type HttpResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type SocketHandle = {
  /** Feed one inbound text frame. */
  message(raw: string): void;
  /** The peer went away. */
  close(): void;
};

export function createBroker(deps: BrokerDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const store = deps.store ?? createMailboxStore();
  const quotas = deps.quotas ?? {
    maxBytes: 1024 ** 3,
    maxMinutes: 720,
    maxStreams: 16,
  };
  /**
   * Said out loud at boot, because the failure it describes is invisible.
   *
   * An `ephemeral` secret means every tunnel id changes on the next restart and
   * every paired browser is stranded — which looks, from the outside, exactly
   * like the network breaking for everyone at once. The source is an outcome,
   * not user data, so logging it keeps the "counts and outcomes only" rule.
   */
  const tunnels =
    deps.tunnels ??
    (() => {
      const { secret, source } = resolveTunnelIdSecret({
        onWarn: (message) => logger.warn(message),
      });
      logger.info({ source }, "Tunnel id secret resolved");
      return createTunnelRegistry(quotas, { idSecret: secret });
    })();
  const claimLimiter = deps.claimLimiter ?? createRateLimiter(5);
  const mailboxLimiter = deps.mailboxLimiter ?? createRateLimiter(10);
  /**
   * Adversary-independent ceilings.
   *
   * The per-IP limiter isolates one *client*; behind a CDN or a botnet it
   * isolates nobody. These two do not care who is asking. The per-slot ceiling
   * caps tries against any one code, and the global ceiling caps tries against
   * the service — which together is what makes "you cannot brute force this" a
   * budget rather than a hope.
   */
  const slotClaimLimiter = deps.slotClaimLimiter ?? createRateLimiter(12);
  const globalClaimLimiter = deps.globalClaimLimiter ?? createRateLimiter(600);
  const discoverLimiter = deps.discoverLimiter ?? createRateLimiter(30);
  /**
   * The upgrade path was the one door with no limit on it at all: every socket
   * route could be dialled as fast as a client could open connections, which
   * made the HTTP limits above bypassable for anything reachable over WS.
   */
  const upgradeLimiter = deps.upgradeLimiter ?? createRateLimiter(60);

  /**
   * Claim payloads, kept only long enough to fan them out and reply.
   *
   * Deleted when the claim's socket closes — but a claim whose socket never
   * attaches (the claimant crashed, or never had one) would otherwise keep its
   * entry forever, so the sweeper drops any whose claim the store has expired.
   */
  const claimPayloads = new Map<
    string,
    { share: string; ad: string; sid: string }
  >();

  /**
   * Requested pairings in flight, keyed by request id.
   *
   * Deliberately as thin as a mailbox: which tunnel to forward to, where to
   * send the reply, and a deadline. No commitment is retained after forwarding,
   * no ephemeral key is stored, and — this is the invariant — the mapping from
   * a request to the account or server that made it is never written to a log.
   */
  const requests = new Map<
    string,
    {
      readonly id: string;
      readonly deviceId: string;
      readonly expiresAt: number;
      /** Held until the commitment arrives, then forwarded verbatim. */
      readonly deviceLabel: string;
      readonly accountEmail: string;
      /** The machine is told about this request exactly once. */
      forwarded: boolean;
      /** Set once the browser opens `/v1/request/:id`. */
      browser: ((message: RequestServerMessage) => void) | null;
      pending: RequestServerMessage[];
    }
  >();

  /** One undecided request per machine, so approval cannot be spammed. */
  const pendingByDevice = new Map<string, string>();

  function liveRequest(requestId: string) {
    const request = requests.get(requestId);
    if (!request) return null;
    if (request.expiresAt <= now()) {
      dropRequest(requestId);
      return null;
    }
    return request;
  }

  function dropRequest(requestId: string): void {
    const request = requests.get(requestId);
    if (!request) return;
    requests.delete(requestId);
    if (pendingByDevice.get(request.deviceId) === requestId) {
      pendingByDevice.delete(request.deviceId);
    }
  }

  /** Deliver to the browser, buffering until its socket attaches. */
  function toBrowser(
    request: {
      browser: ((m: RequestServerMessage) => void) | null;
      pending: RequestServerMessage[];
    },
    message: RequestServerMessage,
  ): void {
    if (request.browser) {
      request.browser(message);
      return;
    }
    if (request.pending.length < MAX_PENDING_REQUEST) {
      request.pending.push(message);
    }
  }

  function pairSink(socket: Socket) {
    return (message: PairingServerMessage) => {
      socket.send(JSON.stringify(message));
    };
  }

  function tunnelSink(socket: Socket) {
    return (message: TunnelServerMessage) => {
      socket.send(JSON.stringify(message));
    };
  }

  /**
   * Attach an account to a freshly registered tunnel, and refuse it if that
   * account is over its plan.
   *
   * Runs after `tunnel:ready` rather than before it, so the common path — an
   * anonymous, self-hosted or simply unregistered machine — pays nothing, and
   * a database that is slow or down delays no one. The window this opens is
   * bounded and benign: an over-quota account gets a few streams through
   * before the block lands, which is the right way round for a limit whose
   * purpose is cost control rather than security.
   */
  async function meter(
    tunnel: { id: string; userId: string | null; blocked: string | null },
    publicKey: string,
  ): Promise<void> {
    if (!deps.metering) return;
    try {
      const owner = await deps.metering.ownerOfDevice(publicKey);
      // An unregistered machine is anonymous, and anonymous is unlimited.
      if (!owner) return;
      tunnel.userId = owner.userId;

      const decision = await deps.metering.checkTunnel(owner.userId);
      if (decision.allowed) return;

      tunnel.blocked = decision.reason ?? "Plan limit reached";
      logger.info("Tunnel blocked by plan limit");
      tunnels.close(tunnel.id, "quota-exceeded");
    } catch (err) {
      // Metering is an accounting concern. Failing it closed would take
      // paying customers offline over a database blip.
      logger.warn({ err }, "Could not meter tunnel; continuing unmetered");
    }
  }

  /** Fold a finished tunnel's totals into the owner's monthly usage. */
  async function settle(tunnel: {
    userId: string | null;
    bytes: number;
    createdAt: number;
  }): Promise<void> {
    if (!deps.metering || !tunnel.userId) return;
    try {
      const seconds = Math.max(
        0,
        Math.round((now() - tunnel.createdAt) / 1000),
      );
      await deps.metering.recordUsage(tunnel.userId, tunnel.bytes, seconds);
    } catch (err) {
      logger.warn({ err }, "Could not record tunnel usage");
    }
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  function pairNew(ip: string, rawBody?: unknown): HttpResult {
    if (!mailboxLimiter.take(ip, now())) {
      return {
        status: 429,
        body: { error: "Too many pairing codes requested" },
        headers: {
          "Retry-After": String(
            Math.ceil(mailboxLimiter.retryAfterMs(ip, now()) / 1000),
          ),
        },
      };
    }

    // An unreadable body is treated as an empty one rather than a 400: every
    // client up to 0.5 POSTs with no body at all, and all of them must keep
    // getting a typed slot. `typed` is the default forever, for that reason.
    const parsed = PairNewRequest.safeParse(rawBody ?? {});
    const space = parsed.success ? (parsed.data.space ?? "typed") : "typed";
    const draw = space === "scan" ? generateQrSlot : generateSlot;

    // A slot at capacity is a collision, not a failure: draw another. With a
    // small per-slot cap this converges immediately unless the space is
    // genuinely saturated, which is what the last `null` reports.
    let mailbox = null;
    for (let attempt = 0; attempt < SLOT_DRAWS && !mailbox; attempt += 1) {
      mailbox = store.createMailbox(draw(), now());
    }
    if (!mailbox) {
      logger.warn({ space }, "No slot available for a new mailbox");
      return {
        status: 503,
        body: { error: "Pairing is busy. Try again in a moment." },
        headers: { "Retry-After": String(retryAfterSeconds()) },
      };
    }

    logger.info({ space }, "Mailbox opened");
    return {
      status: 200,
      body: {
        mailboxId: mailbox.id,
        slot: mailbox.slot,
        expiresAt: mailbox.expiresAt,
        // A duration as well as a deadline, because `expiresAt` is on this
        // clock and the countdown runs on the caller's. See `mailboxTimeoutMs`.
        ttlMs: mailbox.expiresAt - mailbox.createdAt,
      },
    };
  }

  function pairClaim(ip: string, rawBody: unknown): HttpResult {
    // Three independent budgets, cheapest first. The per-IP window isolates one
    // client; the per-slot and global windows are what actually bound guessing,
    // because an attacker picks its own source addresses but cannot pick how
    // many claims the broker will answer.
    const limits: Array<[RateLimiter, string, string]> = [
      [claimLimiter, ip, "Too many pairing attempts"],
      [slotClaimLimiter, slotKeyOf(rawBody), "Too many attempts on that code"],
      [globalClaimLimiter, GLOBAL_KEY, "Pairing is busy. Try again shortly."],
    ];
    for (const [limiter, key, error] of limits) {
      if (limiter.take(key, now())) continue;
      return {
        status: 429,
        body: { error },
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil(limiter.retryAfterMs(key, now()) / 1000)),
          ),
        },
      };
    }

    const parsed = PairClaimRequest.safeParse(rawBody);
    if (!parsed.success) {
      return { status: 400, body: { error: "Malformed claim" } };
    }
    const { slot, share, ad, sid } = parsed.data;

    const claim = store.createClaim(slot, now());
    claimPayloads.set(claim.id, { share, ad, sid });

    // Fan out to every live mailbox on the slot. Slots are shared on purpose,
    // so they never run out; only the mailbox whose four-digit secret matches
    // will produce a confirmation that verifies.
    //
    // This *offers* rather than claims. The guess is only spent when the claim
    // attaches its socket — see `attachClaimSocket` — so a flood of bare POSTs
    // cannot retire a single honest pairing.
    const targets = store.liveMailboxesForSlot(slot, now());
    for (const mailbox of targets) {
      const peer = newPeerHandle();
      store.offerMailbox(mailbox, claim.id, peer, now());
      claim.peers.set(peer, mailbox.id);
      store.deliver(mailbox, {
        type: "pair:peer-share",
        peer,
        share,
        ad,
        sid,
      });
    }

    logger.info({ offered: targets.length }, "Claim fanned out");
    return {
      status: 200,
      // Both fields constant, and that is the whole point.
      //
      // A boolean was already better than a count, but it was still a free
      // liveness oracle: one unauthenticated POST, no socket, no crypto and no
      // guess spent, told the caller whether anything was live on that slot.
      // A hundred POSTs mapped the entire typed space, and an attacker could
      // then spend its real budget only where something was waiting.
      //
      // So the POST now says nothing at all, and the truth moved onto the
      // socket — where it costs a rate-limited WebSocket upgrade and *burns*,
      // which turns a sweep from free reconnaissance into the attack itself.
      // See `attachClaimSocket`.
      //
      // `waiting` must stay present and stay `true`: both clients branch on it
      // and would refuse to open a socket at all if it were false, and clients
      // up to 0.4.0 parse this response strictly, so `offered` cannot simply be
      // dropped either.
      body: { claimId: claim.id, waiting: true, offered: 1 },
    };
  }

  /**
   * A signed-in browser asks one of its own machines to let it in.
   *
   * The caller is authenticated by `server.ts` before this runs, and passes the
   * device id it already resolved from the account's server list — so a caller
   * cannot aim a request at a machine it does not own, and this function never
   * has to be trusted with that check.
   *
   * Logged as a count and an outcome. Writing down which account asked which
   * machine would be exactly the record the broker exists not to keep.
   */
  function pairRequest(
    deviceId: string,
    body: { deviceLabel: string; accountEmail: string },
  ): HttpResult {
    const tunnel = tunnels.byDevice(deviceId, now());
    if (!tunnel) {
      return {
        status: 409,
        body: { error: "That machine is not online right now." },
      };
    }

    // One at a time. Otherwise a compromised session could bury a real request
    // under a hundred prompts, and approval fatigue does the attacker's work.
    const existing = pendingByDevice.get(deviceId);
    if (existing && liveRequest(existing)) {
      return {
        status: 409,
        body: { error: "That machine already has a request waiting." },
      };
    }

    const requestId = `req-${bytesToHex(randomBytes(12))}`;
    requests.set(requestId, {
      id: requestId,
      deviceId,
      expiresAt: now() + REQUEST_TTL_MS,
      deviceLabel: body.deviceLabel,
      accountEmail: body.accountEmail,
      forwarded: false,
      browser: null,
      pending: [],
    });
    pendingByDevice.set(deviceId, requestId);

    // Nothing reaches the machine yet. The browser must first commit to its
    // ephemeral key over the socket, and the commitment has to cover this id —
    // so the machine is only disturbed once there is something to disturb it
    // with, and it answers having seen a commitment and no key.
    logger.info("Access request opened");
    return {
      status: 200,
      body: { requestId, expiresAt: now() + REQUEST_TTL_MS },
    };
  }

  function discover(ip: string): HttpResult {
    if (!discoverLimiter.take(ip, now())) {
      return {
        status: 429,
        body: { error: "Too many requests" },
        headers: {
          "Retry-After": String(
            Math.max(
              1,
              Math.ceil(discoverLimiter.retryAfterMs(ip, now()) / 1000),
            ),
          ),
        },
      };
    }
    return { status: 200, body: { ip } };
  }

  /**
   * Liveness only.
   *
   * The live mailbox, claim and tunnel counts used to be here, which handed
   * anyone who could curl the broker a free read on how many pairings were in
   * flight — the same enumeration `offered` used to leak, without even needing
   * a claim. Operational counts belong on an authenticated or bound endpoint;
   * `stats()` still exposes them in-process for tests and diagnostics.
   */
  function health(): HttpResult {
    return {
      status: 200,
      body: { status: "ok", uptime: process.uptime() },
    };
  }

  // -------------------------------------------------------------------------
  // WS /v1/pair/:mailboxId — whoever opened the mailbox
  // -------------------------------------------------------------------------

  function attachMailboxSocket(
    mailboxId: string,
    socket: Socket,
  ): SocketHandle | null {
    const mailbox = store.getMailbox(mailboxId, now());
    if (!mailbox) {
      socket.send(JSON.stringify({ type: "pair:failed", reason: "expired" }));
      socket.close(1008, "Unknown or expired mailbox");
      return null;
    }
    if (mailbox.sink) {
      // One socket per mailbox: a second listener would be a second chance to
      // observe a claim.
      socket.close(1008, "Mailbox already attached");
      return null;
    }

    store.attach(mailbox, pairSink(socket));
    // `attach` flushes buffered messages first, so `pair:ready` is sent after
    // any claim that already arrived — harmless, and it keeps ordering simple.
    store.deliver(mailbox, {
      type: "pair:ready",
      mailboxId: mailbox.id,
      slot: mailbox.slot,
      expiresAt: mailbox.expiresAt,
    });

    let established = false;

    function claimFor(box: Mailbox): Claim | null {
      // Follows an offer as well as a burn: the holder is sent the claimant's
      // share the moment it is POSTed and answers straight away, which is
      // routinely before the claim's socket has attached.
      const claimId = store.claimIdFor(box, now());
      return claimId ? store.getClaim(claimId, now()) : null;
    }

    return {
      message(raw) {
        const parsed = tryDeserializePairingClientMessage(raw);
        if (!parsed.ok) {
          socket.close(1008, "Malformed message");
          return;
        }
        const msg = parsed.message;

        if (msg.type === "pair:close") {
          const claim = claimFor(mailbox);
          if (claim && mailbox.peer) {
            store.deliver(claim, {
              type: "pair:failed",
              peer: mailbox.peer,
              // Naming a peer means that conversation's key confirmation
              // failed, exactly as it does on the claim socket. A bare close is
              // the holder walking away.
              reason: msg.peer ? "confirmation-failed" : "peer-gone",
            });
          }
          // Either way the mailbox goes: one wrong guess burns the code, and a
          // holder that walked away has nothing left to offer.
          store.destroyMailbox(mailbox.id);
          socket.close(1000, "Closed");
          return;
        }

        // Everything else must reference the peer this mailbox was claimed by.
        if (!mailbox.peer || msg.peer !== mailbox.peer) {
          socket.close(1008, "Unknown peer");
          return;
        }
        const claim = claimFor(mailbox);
        if (!claim) {
          store.deliver(mailbox, {
            type: "pair:failed",
            peer: mailbox.peer,
            reason: "peer-gone",
          });
          return;
        }

        if (msg.type === "pair:share") {
          const payload = claimPayloads.get(claim.id);
          store.deliver(claim, {
            type: "pair:peer-share",
            peer: msg.peer,
            share: msg.share,
            ad: msg.ad,
            // Echo the claimant's own sid so both sides agree on the CPace
            // session id without the broker inventing one.
            sid: payload?.sid ?? "0".repeat(32),
          });
          return;
        }

        if (msg.type === "pair:confirm") {
          store.deliver(claim, {
            type: "pair:peer-confirm",
            peer: msg.peer,
            tag: msg.tag,
          });
          established = true;
          return;
        }

        // pair:establish — the last message of a successful pairing, sent by
        // whichever side ends the exchange. When the CLI holds the mailbox
        // (`mtmux start` printing a code for a phone) that is this socket.
        store.deliver(claim, {
          type: "pair:established",
          peer: msg.peer,
          sealedDescriptor: msg.sealedDescriptor,
        });
        established = true;
        store.destroyMailbox(mailbox.id);
        claim.peers.delete(msg.peer);
        logger.info("Pairing established");
      },

      close() {
        // `established` means this side has said its last word of the exchange
        // — the confirmation tag, or the sealed descriptor after it. Up to that
        // point a dropped socket is an abandoned pairing and the mailbox goes
        // with it; after it the counterpart may still owe a final message, so
        // only the sink is dropped and the mailbox can be re-attached.
        if (!established) store.destroyMailbox(mailbox.id);
        else mailbox.sink = null;
      },
    };
  }

  // -------------------------------------------------------------------------
  // WS /v1/claim/:claimId — whoever quoted the slot
  // -------------------------------------------------------------------------

  function attachClaimSocket(
    claimId: string,
    socket: Socket,
  ): SocketHandle | null {
    const claim = store.getClaim(claimId, now());
    if (!claim) {
      socket.send(JSON.stringify({ type: "pair:failed", reason: "expired" }));
      socket.close(1008, "Unknown or expired claim");
      return null;
    }
    if (claim.sink) {
      socket.close(1008, "Claim already attached");
      return null;
    }
    store.attach(claim, pairSink(socket));

    // Attaching is the first thing a claimant does that a flood of anonymous
    // POSTs cannot: it costs a real connection the broker has already counted.
    // So this is where the guess is spent, and from here the mailboxes this
    // claim was offered are single-shot exactly as before.
    for (const mailboxId of claim.peers.values()) {
      const offered = store.getMailbox(mailboxId, now());
      if (offered) store.burnOffer(offered, claim.id);
    }

    // Nothing was waiting on that slot. This is the answer the POST used to
    // give away for free; here it has cost an upgrade the limiter counted, and
    // the claim it arrived on is spent either way.
    if (claim.peers.size === 0) {
      // `peer-gone` rather than a new enum member, deliberately. `reason` is a
      // closed zod enum and both clients silently *drop* frames that fail to
      // parse — a new value would make every deployed client hang to its 30s
      // timeout instead of failing fast, which is a worse outcome than slightly
      // imprecise wording. "The other device stopped waiting for this code" is
      // true here in every sense that matters to the reader.
      socket.send(JSON.stringify({ type: "pair:failed", reason: "peer-gone" }));
      store.destroyClaim(claim.id);
      claimPayloads.delete(claim.id);
      socket.close(1000, "Nothing waiting on that slot");
      return null;
    }

    function mailboxFor(peer: string): Mailbox | null {
      const mailboxId = claim!.peers.get(peer);
      return mailboxId ? store.getMailbox(mailboxId, now()) : null;
    }

    return {
      message(raw) {
        const parsed = tryDeserializePairingClientMessage(raw);
        if (!parsed.ok) {
          socket.close(1008, "Malformed message");
          return;
        }
        const msg = parsed.message;

        if (msg.type === "pair:close") {
          // A claimant closing a specific peer means its key confirmation
          // failed. Destroy that mailbox: one wrong guess burns the code, which
          // is the entire guessing bound.
          if (msg.peer) {
            const mailbox = mailboxFor(msg.peer);
            if (mailbox) {
              store.deliver(mailbox, {
                type: "pair:failed",
                peer: msg.peer,
                reason: "confirmation-failed",
              });
              store.destroyMailbox(mailbox.id);
            }
            claim.peers.delete(msg.peer);
            return;
          }
          store.destroyClaim(claim.id);
          claimPayloads.delete(claim.id);
          socket.close(1000, "Closed");
          return;
        }

        const mailbox = mailboxFor(msg.peer);
        if (!mailbox) {
          store.deliver(claim, {
            type: "pair:failed",
            peer: msg.peer,
            reason: "peer-gone",
          });
          return;
        }

        if (msg.type === "pair:share") {
          // The claimant's first share travels in the POST body, so this is
          // only reached by a client that sends a second one. Forwarding it
          // costs the broker nothing and keeps the two sockets symmetric; a
          // peer that already has a CPace run in flight ignores it.
          store.deliver(mailbox, {
            type: "pair:peer-share",
            peer: msg.peer,
            share: msg.share,
            ad: msg.ad,
            // Always the claimant's own sid, so both ends agree on the CPace
            // session id without the broker inventing one.
            sid: claimPayloads.get(claim.id)?.sid ?? "0".repeat(32),
          });
          return;
        }

        if (msg.type === "pair:confirm") {
          store.deliver(mailbox, {
            type: "pair:peer-confirm",
            peer: msg.peer,
            tag: msg.tag,
          });
          return;
        }

        // pair:establish — the last message of a successful pairing. Reached
        // when the claimant is the side holding the descriptor, which is the
        // browser-first flow (`mtmux pair <code>`).
        store.deliver(mailbox, {
          type: "pair:established",
          peer: msg.peer,
          sealedDescriptor: msg.sealedDescriptor,
        });
        store.destroyMailbox(mailbox.id);
        claim.peers.delete(msg.peer);
        logger.info("Pairing established");
      },

      close() {
        // A claim that attached spent its guess, and burned every mailbox it
        // was offered. Whatever it did or failed to do afterwards, those codes
        // are dead — so say so.
        //
        // Without this, POST a claim, attach a socket and disconnect: the code
        // is permanently unclaimable and its holder never hears a thing. It
        // sits out the full three minutes and then counts that as *unattended*,
        // which is the counter meant to detect an abandoned terminal. A hundred
        // POSTs killed every typed pairing on the service, silently, and the
        // machines they killed responded by quietly giving up.
        //
        // A successful pairing removes its peer from `claim.peers` first, so
        // this cannot fire on the happy path.
        for (const [peer, mailboxId] of claim.peers) {
          const mailbox = store.getMailbox(mailboxId, now());
          if (!mailbox) continue;
          store.deliver(mailbox, {
            type: "pair:failed",
            peer,
            reason: "confirmation-failed",
          });
          store.destroyMailbox(mailbox.id);
        }
        store.destroyClaim(claim.id);
        claimPayloads.delete(claim.id);
      },
    };
  }

  // -------------------------------------------------------------------------
  // WS /v1/agent — the CLI's persistent tunnel
  // -------------------------------------------------------------------------

  function attachAgentSocket(socket: Socket): SocketHandle {
    const challenge = randomBytes(32);
    const send = tunnelSink(socket);
    send({ type: "tunnel:challenge", challenge: bytesToHex(challenge) });

    let tunnelId: string | null = null;

    return {
      message(raw) {
        const parsed = tryDeserializeTunnelClientMessage(raw);
        if (!parsed.ok) {
          socket.close(1008, "Malformed message");
          return;
        }
        const msg = parsed.message;

        if (tunnelId === null) {
          if (msg.type !== "tunnel:register") {
            socket.close(1008, "Must register first");
            return;
          }
          // Three things must all hold: the challenge is the one we issued,
          // the signature verifies under the offered key, and the device id is
          // that key's fingerprint. Checking the id last stops a caller
          // claiming someone else's identity with their own valid signature.
          const okChallenge = msg.challenge === bytesToHex(challenge);
          const publicKey = hexToBytes(msg.publicKey);
          const okSignature =
            okChallenge &&
            verifyChallenge(publicKey, challenge, hexToBytes(msg.signature));
          const okDeviceId =
            okSignature && deviceIdFor(publicKey) === msg.deviceId;

          if (!okDeviceId) {
            logger.warn("Agent registration rejected");
            socket.close(1008, "Registration failed");
            return;
          }

          const tunnel = tunnels.register(
            msg.deviceId,
            msg.publicKey,
            send,
            now(),
          );
          tunnelId = tunnel.id;
          send({ type: "tunnel:ready", tunnelId: tunnel.id });
          logger.info("Tunnel registered");
          // Deliberately not awaited: the tunnel is usable immediately, and an
          // accounts outage must not delay — or fail — a reconnect.
          void meter(tunnel, msg.publicKey);
          return;
        }

        const tunnel = tunnels.get(tunnelId, now());
        if (!tunnel) {
          socket.close(1000, "Tunnel gone");
          return;
        }

        if (msg.type === "stream:close") {
          tunnels.closeStream(tunnel, msg.streamId, msg.reason);
          return;
        }

        if (msg.type === "stream:frame") {
          if (!tunnels.charge(tunnel, msg.data.length)) {
            socket.close(1008, "Quota exceeded");
            return;
          }
          const stream = tunnel.streams.get(msg.streamId);
          // Frames for an unknown stream are dropped rather than fatal: a
          // close can legitimately race a frame already in flight.
          stream?.browser?.({
            type: "stream:frame",
            streamId: msg.streamId,
            data: msg.data,
          });
          return;
        }

        if (
          msg.type === "pair:request-ack" ||
          msg.type === "pair:approved" ||
          msg.type === "pair:denied"
        ) {
          const request = liveRequest(msg.requestId);
          // Only the machine the request was sent to may answer it. Without
          // this, any registered agent could approve another machine's request.
          if (!request || request.deviceId !== tunnel.deviceId) return;

          toBrowser(request, msg);
          // An approval or a refusal ends the request either way — a denial
          // burns it, so a refused prompt cannot simply be asked again.
          if (msg.type !== "pair:request-ack") dropRequest(msg.requestId);
          return;
        }

        // A second tunnel:register on a live socket.
        socket.close(1008, "Already registered");
      },

      close() {
        if (!tunnelId) return;
        // Read the totals before the registry forgets the tunnel.
        const tunnel = tunnels.get(tunnelId, now());
        if (tunnel) void settle(tunnel);
        tunnels.close(tunnelId, "agent-gone");
      },
    };
  }

  // -------------------------------------------------------------------------
  // WS /v1/request/:requestId — the browser that asked for access
  // -------------------------------------------------------------------------

  function attachRequestSocket(
    requestId: string,
    socket: Socket,
  ): SocketHandle | null {
    const request = liveRequest(requestId);
    if (!request) {
      socket.send(
        JSON.stringify({
          type: "pair:denied",
          requestId,
          reason: "unknown-request",
        }),
      );
      socket.close(1008, "Unknown or expired request");
      return null;
    }
    if (request.browser) {
      // One listener per request: a second would be a second chance to observe
      // the machine's reply.
      socket.close(1008, "Request already attached");
      return null;
    }

    request.browser = (message) => socket.send(JSON.stringify(message));
    // The CLI can answer before the browser's socket is up, so flush first.
    for (const message of request.pending.splice(0)) request.browser(message);

    return {
      message(raw) {
        const parsed = tryDeserializeRequestClientMessage(raw);
        if (!parsed.ok) {
          socket.close(1008, "Malformed message");
          return;
        }
        const msg = parsed.message;
        const live = liveRequest(requestId);
        if (!live) {
          socket.send(
            JSON.stringify({
              type: "pair:denied",
              requestId,
              reason: "timeout",
            }),
          );
          socket.close(1000, "Expired");
          return;
        }

        const tunnel = tunnels.byDevice(live.deviceId, now());
        if (!tunnel) {
          socket.send(
            JSON.stringify({
              type: "pair:denied",
              requestId,
              reason: "agent-gone",
            }),
          );
          dropRequest(requestId);
          return;
        }

        if (msg.type === "pair:commit") {
          // Exactly once. A second commitment would be a second chance to
          // choose a key, which is the one thing the commitment exists to stop.
          if (live.forwarded) return;
          live.forwarded = true;
          tunnel.agent({
            type: "pair:request",
            requestId,
            commitment: msg.commitment,
            deviceLabel: live.deviceLabel,
            accountEmail: live.accountEmail,
          });
          logger.info("Access request forwarded");
          return;
        }

        // pair:reveal — the key the commitment was over. Forwarded verbatim;
        // the broker cannot check it and must not pretend to.
        if (!live.forwarded) return;
        tunnel.agent(msg);
      },

      close() {
        // The browser walked away; the machine should stop prompting for it.
        const live = requests.get(requestId);
        if (live) live.browser = null;
        dropRequest(requestId);
      },
    };
  }

  // -------------------------------------------------------------------------
  // WS /v1/tunnel/:tunnelId — the browser
  // -------------------------------------------------------------------------

  function attachTunnelSocket(
    tunnelId: string,
    socket: Socket,
  ): SocketHandle | null {
    const tunnel = tunnels.get(tunnelId, now());
    if (!tunnel) {
      socket.send(
        JSON.stringify({ type: "tunnel:closed", reason: "agent-gone" }),
      );
      socket.close(1008, "Unknown tunnel");
      return null;
    }

    const send = tunnelSink(socket);
    const stream = tunnels.openStream(tunnel, send, now());
    if (!stream) {
      // The tunnel is already carrying its maximum. Refusing here is what keeps
      // a leaked tunnel id from being turned into unbounded loopback sockets on
      // the paired machine.
      logger.warn("Stream refused: tunnel at capacity");
      socket.send(
        JSON.stringify({ type: "tunnel:closed", reason: "quota-exceeded" }),
      );
      socket.close(1008, "Too many streams");
      return null;
    }
    // Tell the browser its stream id too, so both ends label frames the same.
    send({ type: "stream:open", streamId: stream.id });

    return {
      message(raw) {
        const parsed = tryDeserializeTunnelClientMessage(raw);
        if (!parsed.ok) {
          socket.close(1008, "Malformed message");
          return;
        }
        const msg = parsed.message;

        // Registration, and the three replies only a machine may send. This
        // socket is the *browser's* end of a tunnel: it has proved nothing
        // about which device it is, so it must never be able to approve a
        // request or answer for an agent.
        if (
          msg.type === "tunnel:register" ||
          msg.type === "pair:request-ack" ||
          msg.type === "pair:approved" ||
          msg.type === "pair:denied"
        ) {
          socket.close(1008, "Unexpected message");
          return;
        }
        if (msg.streamId !== stream.id) {
          socket.close(1008, "Unknown stream");
          return;
        }

        if (msg.type === "stream:close") {
          tunnels.closeStream(tunnel, stream.id, msg.reason);
          socket.close(1000, "Closed");
          return;
        }

        if (!tunnels.charge(tunnel, msg.data.length)) {
          socket.close(1008, "Quota exceeded");
          return;
        }
        tunnel.agent({
          type: "stream:frame",
          streamId: stream.id,
          data: msg.data,
        });
      },

      close() {
        const live = tunnels.get(tunnelId, now());
        if (live) tunnels.closeStream(live, stream.id, "browser-gone");
      },
    };
  }

  /**
   * Drop payloads whose claim the store no longer has.
   *
   * `store.sweep` has just expired the claims themselves, so a `getClaim` miss
   * here means the entry is unreachable — nothing can ever ask for its sid
   * again. Without this the map grows for the lifetime of the process on every
   * claim whose socket never attached.
   */
  function sweepClaimPayloads(): void {
    for (const claimId of [...claimPayloads.keys()]) {
      if (!store.getClaim(claimId, now())) claimPayloads.delete(claimId);
    }
  }

  /** Drop requests nobody decided, so a machine is not blocked forever. */
  function sweepRequests(): void {
    for (const requestId of [...requests.keys()]) liveRequest(requestId);
  }

  function sweepAll(): void {
    store.sweep(now());
    sweepClaimPayloads();
    sweepRequests();
    tunnels.sweep(now());
  }

  const sweeper = setInterval(sweepAll, 30_000);
  // Never hold the process open just to sweep in-memory maps.
  sweeper.unref?.();

  return {
    pairNew,
    pairClaim,
    pairRequest,
    discover,
    health,
    /** Whether this address may open another socket. See `upgradeLimiter`. */
    allowUpgrade: (ip: string) => upgradeLimiter.take(ip, now()),
    attachMailboxSocket,
    attachClaimSocket,
    attachAgentSocket,
    attachRequestSocket,
    attachTunnelSocket,
    stats: () => ({
      ...store.stats(),
      ...tunnels.stats(),
      /** Claims still holding a payload. Diagnostics and the leak test. */
      claimPayloads: claimPayloads.size,
    }),
    /** Run the periodic cleanup now. The interval is the only other caller. */
    sweep: sweepAll,
    shutdown: () => clearInterval(sweeper),
  };
}

export type Broker = ReturnType<typeof createBroker>;

/** Stable opaque id for logs that must not identify a user. */
export function anonymize(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}

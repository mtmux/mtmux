import crypto from "node:crypto";
import { createLogger } from "@repo/logger";
import {
  MIN_PAIR_CLI_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  PairClaimRequest,
  PairNewRequest,
  // Long enough to walk to the machine and read six digits; short enough that
  // a request nobody answers does not hold a slot on that machine forever.
  // Shared so the browser's countdown cannot drift from it.
  REQUEST_TTL_MS,
  tryDeserializePairingClientMessage,
  tryDeserializeRequestClientMessage,
  meetsProtocolFloor,
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

/** Bucket key for the per-slot claim limit. */
function slotKey(slot: string): string {
  return `slot:${slot}`;
}

/**
 * The pairing broker.
 *
 * Everything here is deliberately blind. The broker routes by a public
 * three-digit slot, copies opaque blobs between two sockets, and enforces
 * quotas. It never sees the six-digit secret, the derived keys, or a single
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
   * Oldest protocol this broker answers. Zero disables the floor entirely.
   *
   * A knob and not a constant, because a floor is a control over other
   * people's software: whoever runs a broker should decide what it refuses,
   * and a self-hoster whose users cannot upgrade on our schedule must be able
   * to turn it off.
   */
  minProtocolVersion?: number;
  /**
   * A line every client shows its user. The advisory half of the kill switch:
   * with it we can warn about a bad release without shipping one.
   */
  advisory?: string;
  /**
   * The CLI version this broker would like people on, for `/v1/version`.
   *
   * Absent by default. A self-hosted broker that pins its users to an older
   * CLI should not be made to advertise ours, and a broker that has no opinion
   * should say nothing rather than send everyone chasing a version it cannot
   * vouch for.
   */
  latestCli?: string;
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
  /**
   * Per-IP ceiling on the claim POST. Purely to bound claim-object allocation
   * — the POST no longer touches a mailbox, so this is not a guessing bound and
   * must never be mistaken for one.
   */
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
   *
   * Both are charged in `attachClaimSocket`, not on the POST. A claim only
   * becomes a guess when its socket attaches, so charging at POST spent the
   * budget on requests that never cost an attacker anything and let a flood of
   * them exhaust the ceiling that honest claimants share.
   *
   * The global number is derived, not chosen: an attacker must never be able to
   * sweep the slot space faster than codes are reissued, so
   * `rate × (MAILBOX_TTL_MS / 60_000) < SLOT_COUNT` — with 2000 slots and a
   * three-minute TTL, anything under 333/min. 200 leaves headroom either way.
   * The per-slot number is 4 because, with the claim atomic, the first attached
   * claim on a slot ends every pairing on it: nothing honest needs more.
   */
  const slotClaimLimiter = deps.slotClaimLimiter ?? createRateLimiter(4);
  const globalClaimLimiter = deps.globalClaimLimiter ?? createRateLimiter(200);
  const discoverLimiter = deps.discoverLimiter ?? createRateLimiter(30);
  /**
   * The upgrade path was the one door with no limit on it at all: every socket
   * route could be dialled as fast as a client could open connections, which
   * made the HTTP limits above bypassable for anything reachable over WS.
   */
  const upgradeLimiter = deps.upgradeLimiter ?? createRateLimiter(60);
  const minProtocolVersion = deps.minProtocolVersion ?? MIN_PROTOCOL_VERSION;
  const advisory = deps.advisory ?? "";
  const latestCli = deps.latestCli ?? "";

  /**
   * 426 for a caller that does not speak the current protocol, or null.
   *
   * Read off the raw body *before* validation and after the rate limiters. The
   * order matters both ways: after, so a version probe is budgeted like any
   * other request; before, so a 0.6.x client gets "upgrade" rather than
   * "malformed claim" — the schemas now require `v`, and a 400 would send the
   * reader looking for a typo in a code that is fine.
   */
  function upgradeRequired(
    rawBody: unknown,
  ): (HttpResult & { body: Record<string, unknown> }) | null {
    const declared = (rawBody as { v?: unknown } | null)?.v;
    const version =
      typeof declared === "number" || typeof declared === "string"
        ? Number(declared)
        : null;
    if (
      meetsProtocolFloor(
        Number.isFinite(version) ? version : null,
        minProtocolVersion,
      )
    ) {
      return null;
    }
    return {
      status: 426,
      body: {
        error:
          "This version of mtmux is too old to pair. Run: npm i -g mtmux@latest",
        minProtocol: minProtocolVersion,
        minCli: MIN_PAIR_CLI_VERSION,
      },
    };
  }

  /** The socket half of the same check, for the `upgrade` handler. */
  function socketVersionAccepted(declared: number | null): boolean {
    return meetsProtocolFloor(declared, minProtocolVersion);
  }

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

    const tooOld = upgradeRequired(rawBody);
    if (tooOld) return tooOld;

    // An unreadable body past the version gate is treated as an empty one
    // rather than a 400: `space` is optional and `typed` is its default
    // forever, so a caller that says nothing about it must still get a slot.
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
    // One budget here, and it is not a guessing bound. This POST fans nothing
    // out and touches no mailbox: it validates a body, mints a 128-bit claim id
    // and hands it back. All it can cost the broker is the claim object, so all
    // it is limited for is the claim object. The budgets that bound guessing
    // are charged in `attachClaimSocket`, where a claim has actually done
    // something an attacker cannot do for free.
    if (!claimLimiter.take(ip, now())) {
      return {
        status: 429,
        body: { error: "Too many pairing attempts" },
        headers: {
          "Retry-After": String(
            Math.max(1, Math.ceil(claimLimiter.retryAfterMs(ip, now()) / 1000)),
          ),
        },
      };
    }

    const tooOld = upgradeRequired(rawBody);
    if (tooOld) return tooOld;

    const parsed = PairClaimRequest.safeParse(rawBody);
    if (!parsed.success) {
      return { status: 400, body: { error: "Malformed claim" } };
    }
    const { slot, share, ad, sid } = parsed.data;

    const claim = store.createClaim(slot, now());
    claimPayloads.set(claim.id, { share, ad, sid });

    logger.info("Claim opened");
    return {
      status: 200,
      // A claim id and a deadline, and nothing else.
      //
      // `waiting` and `offered` are gone. Both were compatibility with clients
      // up to 0.4.0 and both had been pinned to constants, because a POST that
      // reported whether anything was live on a slot was a free liveness oracle
      // — a hundred of them mapped the whole typed space, and an attacker could
      // then spend its real budget only where something was waiting. Now the
      // POST could not answer that question even if it wanted to: it does not
      // look at the slot at all. The answer lives on the socket, where it costs
      // an upgrade, burns the claim, and is charged to both guessing budgets.
      // See `attachClaimSocket`.
      body: { claimId: claim.id, expiresAt: claim.expiresAt },
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

  /**
   * GET /v1/version — the kill switch's read side.
   *
   * `floor` is what this broker refuses below; `latest` is what it would like
   * clients to be on. `advisory` is the channel that lets an operator say
   * something urgent to every running CLI without shipping code — a doctor
   * check and `mtmux start` both read it. Empty by default: a broker with
   * nothing to say must say nothing, or the line stops being read.
   */
  function version(): HttpResult {
    return {
      status: 200,
      body: {
        protocol: PROTOCOL_VERSION,
        floor: minProtocolVersion,
        minCli: MIN_PAIR_CLI_VERSION,
        ...(latestCli ? { latest: latestCli } : {}),
        ...(advisory ? { advisory } : {}),
      },
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

    /**
     * The claim this mailbox was burned by, if the two still agree.
     *
     * Symmetric with `ownedMailbox` on the claim socket: the mailbox names a
     * claim, and the claim's routing table must still name this mailbox under
     * the same peer handle. Either half alone would let the holder keep talking
     * to a claim that has moved on, or to a conversation another claim owns.
     */
    function claimFor(box: Mailbox): Claim | null {
      if (!box.claimedBy || !box.peer) return null;
      const claim = store.getClaim(box.claimedBy, now());
      if (!claim) return null;
      return claim.peers.get(box.peer) === box.id ? claim : null;
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

    // The guessing budgets are charged here, and only here.
    //
    // Attaching is the first thing a claimant does that a flood of anonymous
    // POSTs cannot: it costs a real connection the broker has already counted
    // through `upgradeLimiter`. Charging at POST instead let free requests
    // exhaust the ceiling that honest claimants share, which turned the bound
    // that protects codes into a denial of service against them.
    const budgets: Array<[RateLimiter, string]> = [
      [slotClaimLimiter, slotKey(claim.slot)],
      [globalClaimLimiter, GLOBAL_KEY],
    ];
    for (const [limiter, key] of budgets) {
      if (limiter.take(key, now())) continue;
      socket.send(
        JSON.stringify({ type: "pair:failed", reason: "rate-limited" }),
      );
      // The claim goes with it: a refused attach has spent nothing, but leaving
      // the object alive would let one POST be retried against the limiter
      // until it happened to fit.
      store.destroyClaim(claim.id);
      claimPayloads.delete(claim.id);
      socket.close(1013, "Too many attempts");
      return null;
    }

    store.attach(claim, pairSink(socket));
    // A claim that has attached is in a live exchange, so it gets the full
    // mailbox TTL rather than the fifteen seconds it was minted with.
    store.extendClaim(claim, now());

    // Fan out *now*, not at POST time. Claiming a mailbox and being offered one
    // are the same instant, so there is no window in which a mailbox is spoken
    // for but unspent — which is what an unauthenticated POST used to be able
    // to hold open, and is the whole of C-2.
    const payload = claimPayloads.get(claim.id);
    if (payload) {
      for (const mailbox of store.liveMailboxesForSlot(claim.slot, now())) {
        const peer = newPeerHandle();
        // Compare-and-set. A mailbox is claimed once in its lifetime; a loser
        // simply is not part of this conversation.
        if (!store.claimMailbox(mailbox, claim.id, peer)) continue;
        claim.peers.set(peer, mailbox.id);
        store.deliver(mailbox, {
          type: "pair:peer-share",
          peer,
          share: payload.share,
          ad: payload.ad,
          sid: payload.sid,
        });
      }
    }
    logger.info({ peers: claim.peers.size }, "Claim fanned out");

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

    /**
     * The mailbox this claim owns under `peer`, or null.
     *
     * Belt and braces now that the offer window is gone: the routing table and
     * the mailbox must agree in both directions, so a claim can never act on a
     * mailbox that a different claim burned — including one it was routed to
     * before its own socket existed.
     */
    function ownedMailbox(peer: string): Mailbox | null {
      const mailboxId = claim!.peers.get(peer);
      if (!mailboxId) return null;
      const mailbox = store.getMailbox(mailboxId, now());
      if (!mailbox || mailbox.claimedBy !== claim!.id) return null;
      return mailbox;
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
            const mailbox = ownedMailbox(msg.peer);
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

        const mailbox = ownedMailbox(msg.peer);
        if (!mailbox) {
          store.deliver(claim, {
            type: "pair:failed",
            peer: msg.peer,
            reason: "peer-gone",
          });
          return;
        }

        if (msg.type === "pair:share") {
          // The claimant's share travels in the POST body and is fanned out
          // from there, so a second one on this socket is not a client we
          // support — and forwarding it is the only way a holder can ever see
          // two peer-shares for one peer, which is the shape a confused or
          // hostile claimant would need to run two CPace attempts on one
          // mailbox. Refuse it rather than keeping the sockets symmetric.
          socket.close(1008, "Share belongs in the claim body");
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
        for (const peer of [...claim.peers.keys()]) {
          const mailbox = ownedMailbox(peer);
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
    version,
    /** Whether this address may open another socket. See `upgradeLimiter`. */
    allowUpgrade: (ip: string) => upgradeLimiter.take(ip, now()),
    /** Whether a socket declaring this `?v=` clears the broker's floor. */
    socketVersionAccepted,
    /** The floor, for `/v1/version` and for the 426 body on a socket. */
    minProtocolVersion,
    /** 426 body for an HTTP caller that is too old, or null. */
    upgradeRequired,
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

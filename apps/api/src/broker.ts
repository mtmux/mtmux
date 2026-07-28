import crypto from "node:crypto";
import { createLogger } from "@repo/logger";
import {
  PairClaimRequest,
  tryDeserializePairingClientMessage,
  tryDeserializeTunnelClientMessage,
  type PairingServerMessage,
  type TunnelServerMessage,
} from "@repo/protocol";
import {
  deviceIdFor,
  hexToBytes,
  verifyChallenge,
  randomBytes,
  bytesToHex,
  generateSlot,
} from "@repo/crypto";
import {
  createMailboxStore,
  newPeerHandle,
  type Claim,
  type Mailbox,
  type MailboxStore,
} from "./mailbox.js";
import { createTunnelRegistry, type TunnelRegistry } from "./tunnel.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

const logger = createLogger("api:broker");

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
  const tunnels = deps.tunnels ?? createTunnelRegistry(quotas);
  const claimLimiter = deps.claimLimiter ?? createRateLimiter(5);
  const mailboxLimiter = deps.mailboxLimiter ?? createRateLimiter(10);

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

  function pairNew(ip: string): HttpResult {
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

    const mailbox = store.createMailbox(generateSlot(), now());
    logger.info("Mailbox opened");
    return {
      status: 200,
      body: {
        mailboxId: mailbox.id,
        slot: mailbox.slot,
        expiresAt: mailbox.expiresAt,
      },
    };
  }

  function pairClaim(ip: string, rawBody: unknown): HttpResult {
    if (!claimLimiter.take(ip, now())) {
      return {
        status: 429,
        body: { error: "Too many pairing attempts" },
        headers: {
          "Retry-After": String(
            Math.ceil(claimLimiter.retryAfterMs(ip, now()) / 1000),
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
    const targets = store.liveMailboxesForSlot(slot, now());
    for (const mailbox of targets) {
      const peer = newPeerHandle();
      mailbox.claimedBy = claim.id;
      mailbox.peer = peer;
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
      body: { claimId: claim.id, offered: targets.length },
    };
  }

  function discover(ip: string): HttpResult {
    return { status: 200, body: { ip } };
  }

  function health(): HttpResult {
    return {
      status: 200,
      body: {
        status: "ok",
        uptime: process.uptime(),
        ...store.stats(),
        ...tunnels.stats(),
      },
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
      return box.claimedBy ? store.getClaim(box.claimedBy, now()) : null;
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

        if (msg.type === "tunnel:register") {
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

  function sweepAll(): void {
    store.sweep(now());
    sweepClaimPayloads();
    tunnels.sweep(now());
  }

  const sweeper = setInterval(sweepAll, 30_000);
  // Never hold the process open just to sweep in-memory maps.
  sweeper.unref?.();

  return {
    pairNew,
    pairClaim,
    discover,
    health,
    attachMailboxSocket,
    attachClaimSocket,
    attachAgentSocket,
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

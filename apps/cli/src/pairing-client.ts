import WebSocket from "ws";
import {
  cpaceStart,
  deriveSessionKeys,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  generateSecret,
  parseCode,
  type SessionKeys,
} from "@repo/crypto";
import {
  PairClaimResponse,
  PairNewResponse,
  type SealedDescriptor,
} from "@repo/protocol";
import {
  AD_CLI,
  AD_PEER_MAX,
  PairingError,
  describeFailure,
  runExchange,
  type Derived,
  type Exchange,
  type PairingResult,
  type PairingSocket,
} from "./pairing-exchange.js";

/**
 * The CLI half of hosted pairing, in both directions.
 *
 * `pairWithCode` is the original: the user reads six digits off their phone and
 * types them here. `hostPairing` is the mirror image, which is what `mtmux
 * start` prints as a code and a QR — the CLI parks the mailbox and a browser
 * claims it, so nothing has to be typed on the machine at all.
 *
 * In both, the first two digits are the broker's routing slot and the last four
 * are the PAKE password. Whichever side generates the secret, it never leaves
 * that process — not to the broker, not hashed, not in a log line. 10⁶ is an
 * instant offline search, so a broker that learned the whole code could run the
 * PAKE against both ends at once and hand an attacker a shell.
 *
 * The exchange itself — fan-out across candidate peers, key confirmation,
 * sealing the descriptor — lives in `pairing-exchange.ts` and is shared, so the
 * two directions cannot drift apart.
 */

export type {
  PairingResult,
  PairingSocket,
  Attempt,
} from "./pairing-exchange.js";
export { PairingError } from "./pairing-exchange.js";

/** Claiming a code someone else is showing. */
export type ClaimTransport = {
  postClaim(body: unknown): Promise<{ claimId: string; offered: number }>;
  openClaimSocket(claimId: string): Promise<PairingSocket>;
};

/** Showing a code and waiting for someone to claim it. */
export type MailboxTransport = {
  postMailbox(): Promise<{
    mailboxId: string;
    slot: string;
    expiresAt: number;
  }>;
  openMailboxSocket(mailboxId: string): Promise<PairingSocket>;
};

/** Both halves. `httpTransport` implements all of it. */
export type PairingTransport = ClaimTransport & MailboxTransport;

/** How long a claimed pairing may sit half-finished before we give up. */
const CLAIM_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Claiming: `mtmux pair <code>`
// ---------------------------------------------------------------------------

export type PairOptions = {
  code: string;
  transport: ClaimTransport;
  /** Built once the key is known, so the CLI can seal it for this peer. */
  buildDescriptor: () => SealedDescriptor;
  /** Seals the descriptor under the session key. */
  seal: (
    keys: SessionKeys,
    descriptor: SealedDescriptor,
  ) => Promise<Uint8Array>;
  timeoutMs?: number;
};

export async function pairWithCode(opts: PairOptions): Promise<PairingResult> {
  const parsed = parseCode(opts.code);
  if (!parsed) {
    throw new PairingError(
      "That is not a six-digit pairing code.",
      "Open app.mtmux.com/pair on your phone and read the six digits.",
    );
  }
  const { slot, secret } = parsed;

  // The claimant picks the CPace session id, and is the initiator: the
  // transcript is ordered initiator-first, so our share leads it.
  const sid = randomBytes(16);
  const channelId = utf8ToBytes(slot);
  const cpace = cpaceStart(utf8ToBytes(secret), channelId, sid);

  const { claimId, offered } = await opts.transport.postClaim({
    slot,
    share: bytesToHex(cpace.share),
    ad: AD_CLI,
    sid: bytesToHex(sid),
  });

  if (offered === 0) {
    throw new PairingError(
      "No pairing is waiting for that code.",
      "Codes expire after three minutes. Reload the page for a new one.",
    );
  }

  const socket = await opts.transport.openClaimSocket(claimId);

  const hint =
    "Each code is good for one attempt. Reload the page for a new one.";
  return runExchange({
    socket,
    side: "claim",
    outstanding: offered,
    buildDescriptor: opts.buildDescriptor,
    seal: opts.seal,
    timeoutMs: opts.timeoutMs ?? CLAIM_TIMEOUT_MS,
    derive: (msg) => {
      if (msg.ad.length > AD_PEER_MAX) {
        return { reject: "oversized associated data" };
      }
      let isk: Uint8Array;
      try {
        isk = cpace.finish(hexToBytes(msg.share), {
          own: utf8ToBytes(AD_CLI),
          peer: utf8ToBytes(msg.ad),
          isInitiator: true,
        });
      } catch {
        // A share that is not a valid group element, or is the identity.
        return { reject: "invalid share" };
      }
      return {
        attempt: {
          peer: msg.peer,
          ownShare: cpace.share,
          peerAd: msg.ad,
          keys: deriveSessionKeys(
            isk,
            transcriptIr(
              cpace.share,
              utf8ToBytes(AD_CLI),
              hexToBytes(msg.share),
              utf8ToBytes(msg.ad),
            ),
          ),
        },
      };
    },
    errors: {
      noMatch: () => new PairingError("That code did not match.", hint),
      timedOut: () =>
        new PairingError(
          "Pairing timed out.",
          "Check that the page is still open, then try a fresh code.",
        ),
      lost: () =>
        new PairingError(
          "Lost the connection to the pairing service.",
          "Check your network and try again.",
        ),
      failed: (reason) => new PairingError(describeFailure(reason), hint),
    },
  }).result;
}

// ---------------------------------------------------------------------------
// Hosting: the code `mtmux start` prints
// ---------------------------------------------------------------------------

export type HostedPairing = {
  /** The six digits to display, and to encode in the QR. */
  code: string;
  slot: string;
  expiresAt: number;
  /** Resolves when a browser completes the handshake. */
  paired: Promise<PairingResult>;
  cancel(): void;
};

export type HostOptions = {
  /** Where the broker lives. Ignored when `transport` is supplied. */
  apiBase?: string;
  /** Injected by tests, and by anything that is not talking to a real broker. */
  transport?: MailboxTransport;
  /** Built once the key is known, so the CLI can seal it for this peer. */
  buildDescriptor: () => SealedDescriptor;
  seal: (
    keys: SessionKeys,
    descriptor: SealedDescriptor,
  ) => Promise<Uint8Array>;
  /**
   * Overrides the deadline, which otherwise tracks the mailbox's own expiry.
   * A hosted code is dead the moment the broker forgets its mailbox, so
   * matching that is almost always what you want.
   */
  timeoutMs?: number;
};

/**
 * Park a mailbox and wait for a browser to claim it.
 *
 * Re-arming is deliberately just calling this again with the same options:
 * nothing is carried between codes. Every call generates a fresh four-digit
 * secret, opens a fresh mailbox on a fresh slot, and takes a fresh socket, so a
 * spent code shares no state with its replacement — which is what makes "one
 * guess burns the code" survive re-arming.
 *
 *     let hosted = await hostPairing(opts);
 *     render(hosted.code);
 *     hosted.paired.then(onPaired).catch(async () => {
 *       hosted = await hostPairing(opts);   // same options, new code
 *       render(hosted.code);
 *     });
 */
export async function hostPairing(opts: HostOptions): Promise<HostedPairing> {
  // Generated here and only here. It is never transmitted, hashed or logged —
  // the broker mints the slot, and that is all it is ever told.
  const secret = generateSecret();

  if (!opts.transport && !opts.apiBase) {
    throw new PairingError("hostPairing needs an apiBase or a transport.");
  }
  const transport = opts.transport ?? httpTransport(opts.apiBase!);
  const { mailboxId, slot, expiresAt } = await transport.postMailbox();
  const socket = await transport.openMailboxSocket(mailboxId);
  const channelId = utf8ToBytes(slot);

  const hint = "Each code is good for one attempt — a new one is on its way.";
  const exchange: Exchange = runExchange({
    socket,
    side: "mailbox",
    // A mailbox accepts exactly one claim in its lifetime, so there is exactly
    // one peer to rule out before the code is spent and the caller re-arms.
    outstanding: 1,
    buildDescriptor: opts.buildDescriptor,
    seal: opts.seal,
    // The mailbox stops existing at `expiresAt`, so a deadline past it would
    // only mean waiting on a socket the broker has already given up on.
    timeoutMs: opts.timeoutMs ?? Math.max(0, expiresAt - Date.now()),
    derive: (msg): Derived => {
      if (msg.ad.length > AD_PEER_MAX) {
        return { reject: "oversized associated data" };
      }
      // The claimant chose the session id, so the CPace run can only start now
      // — one per peer, unlike the claiming direction where our share is fixed
      // before the first peer is known.
      const cpace = cpaceStart(
        utf8ToBytes(secret),
        channelId,
        hexToBytes(msg.sid),
      );
      const peerShare = hexToBytes(msg.share);
      let isk: Uint8Array;
      try {
        isk = cpace.finish(peerShare, {
          own: utf8ToBytes(AD_CLI),
          peer: utf8ToBytes(msg.ad),
          isInitiator: false,
        });
      } catch {
        return { reject: "invalid share" };
      }
      return {
        attempt: {
          peer: msg.peer,
          ownShare: cpace.share,
          peerAd: msg.ad,
          // Initiator-first, and here the *claimant* is the initiator — so the
          // peer's share leads the transcript. Getting this backwards derives
          // two different keys from one correct code, which looks exactly like
          // a wrong code.
          keys: deriveSessionKeys(
            isk,
            transcriptIr(
              peerShare,
              utf8ToBytes(msg.ad),
              cpace.share,
              utf8ToBytes(AD_CLI),
            ),
          ),
        },
      };
    },
    errors: {
      noMatch: () => new PairingError("That code did not match.", hint),
      timedOut: () =>
        new PairingError(
          "The pairing code expired before anyone used it.",
          "A fresh code is on its way.",
        ),
      lost: () =>
        new PairingError(
          "Lost the connection to the pairing service.",
          "Check your network — the code will be retried.",
        ),
      failed: (reason) => new PairingError(describeFailure(reason), hint),
    },
  });

  // A caller that re-arms will usually cancel a code it is no longer awaiting,
  // and in Node an unhandled rejection is fatal. This inert handler defuses
  // that; the promise handed back is the same one, so the caller's own
  // `await`/`.catch` still sees every rejection.
  exchange.result.catch(() => {});

  let cancelled = false;
  return {
    code: `${slot}${secret}`,
    slot,
    expiresAt,
    paired: exchange.result,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      // Tell the broker before dropping the socket: a peerless `pair:close`
      // destroys the mailbox now rather than leaving a dead code claimable for
      // the rest of its three minutes.
      try {
        socket.send({ type: "pair:close", reason: "cancelled" });
      } catch {
        // Socket already gone; the abort below is what matters.
      }
      exchange.abort(new PairingError("Pairing cancelled."));
    },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Default transport: real HTTP + WebSocket against the broker. */
export function httpTransport(apiBase: string): PairingTransport {
  function openSocket(path: string): Promise<PairingSocket> {
    const ws = new WebSocket(`${apiBase.replace(/^http/, "ws")}${path}`);
    return new Promise((resolve, reject) => {
      ws.once("error", reject);
      ws.once("open", () => {
        ws.removeAllListeners("error");
        resolve({
          send: (message) => ws.send(JSON.stringify(message)),
          onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
          onClose: (cb) => ws.on("close", cb),
          close: () => ws.close(),
        });
      });
    });
  }

  return {
    async postClaim(body) {
      const res = await fetch(`${apiBase}/v1/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        throw new PairingError(
          "Too many pairing attempts from this network.",
          "Wait a minute and try again.",
        );
      }
      if (!res.ok) {
        throw new PairingError(`Pairing service returned ${res.status}.`);
      }
      // Parsed rather than cast: a broker answering with something else is a
      // clearer failure here than an undefined claim id three lines later.
      return PairClaimResponse.parse(await res.json());
    },

    async postMailbox() {
      const res = await fetch(`${apiBase}/v1/pair/new`, { method: "POST" });
      if (res.status === 429) {
        throw new PairingError(
          "Too many pairing codes requested from this network.",
          "Wait a minute and try again.",
        );
      }
      if (!res.ok) {
        throw new PairingError(`Pairing service returned ${res.status}.`);
      }
      return PairNewResponse.parse(await res.json());
    },

    openClaimSocket: (claimId) => openSocket(`/v1/claim/${claimId}`),
    openMailboxSocket: (mailboxId) => openSocket(`/v1/pair/${mailboxId}`),
  };
}

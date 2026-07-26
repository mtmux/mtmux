import WebSocket from "ws";
import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  bytesToBase64Url,
  parseCode,
  type SessionKeys,
} from "@repo/crypto";
import {
  tryDeserializePairingServerMessage,
  type PairPeerShareMessage,
  type SealedDescriptor,
} from "@repo/protocol";

/**
 * The CLI half of hosted pairing.
 *
 * The user reads six digits off their phone and types them here. The first two
 * are the broker's routing slot; the last four are the PAKE password and never
 * leave this process. Because a slot is shared by many simultaneous pairings,
 * a claim is fanned out and several browsers may answer — this module runs a
 * CPace exchange against each and keeps the one whose key confirmation
 * verifies. All the others get closed, which destroys their mailboxes.
 */

const AD_CLI = "cli";
const AD_BROWSER_EXPECTED_MAX = 256;

export type PairingResult = {
  keys: SessionKeys;
  /** The browser's device identity, to persist for signed reconnects. */
  peerDeviceId: string | null;
  peerLabel: string;
};

export type PairingTransport = {
  postClaim(body: unknown): Promise<{ claimId: string; offered: number }>;
  openClaimSocket(claimId: string): Promise<PairingSocket>;
};

export type PairingSocket = {
  send(message: unknown): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

export class PairingError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

/** One in-flight CPace exchange with a single candidate mailbox. */
type Attempt = {
  peer: string;
  keys: SessionKeys;
  peerAd: string;
};

export type PairOptions = {
  code: string;
  transport: PairingTransport;
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
  const attempts = new Map<string, Attempt>();

  return await new Promise<PairingResult>((resolve, reject) => {
    let settled = false;
    /** Mailboxes still plausibly ours, so we know when every one has failed. */
    let outstanding = offered;

    const timer = setTimeout(() => {
      finish(
        new PairingError(
          "Pairing timed out.",
          "Check that the page is still open, then try a fresh code.",
        ),
      );
    }, opts.timeoutMs ?? 30_000);

    function finish(err: Error | null, result?: PairingResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(result!);
    }

    function giveUpOn(peer: string, reason: string) {
      attempts.delete(peer);
      socket.send({ type: "pair:close", peer, reason });
      outstanding -= 1;
      if (outstanding <= 0) {
        finish(
          new PairingError(
            "That code did not match.",
            "Each code is good for one attempt. Reload the page for a new one.",
          ),
        );
      }
    }

    socket.onClose(() => {
      finish(
        new PairingError(
          "Lost the connection to the pairing service.",
          "Check your network and try again.",
        ),
      );
    });

    socket.onMessage((raw) => {
      const parsedMsg = tryDeserializePairingServerMessage(raw);
      if (!parsedMsg.ok) return;
      const msg = parsedMsg.message;

      if (msg.type === "pair:failed") {
        if (msg.peer && attempts.has(msg.peer)) {
          attempts.delete(msg.peer);
          outstanding -= 1;
          if (outstanding <= 0) {
            finish(
              new PairingError(
                "That code did not match.",
                "Each code is good for one attempt. Reload the page for a new one.",
              ),
            );
          }
          return;
        }
        finish(new PairingError(describeFailure(msg.reason)));
        return;
      }

      if (msg.type === "pair:peer-share") {
        handlePeerShare(msg);
        return;
      }

      if (msg.type === "pair:peer-confirm") {
        void handlePeerConfirm(msg.peer, msg.tag);
      }
    });

    function handlePeerShare(msg: PairPeerShareMessage) {
      if (msg.ad.length > AD_BROWSER_EXPECTED_MAX) {
        giveUpOn(msg.peer, "oversized associated data");
        return;
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
        giveUpOn(msg.peer, "invalid share");
        return;
      }

      const keys = deriveSessionKeys(
        isk,
        transcriptIr(
          cpace.share,
          utf8ToBytes(AD_CLI),
          hexToBytes(msg.share),
          utf8ToBytes(msg.ad),
        ),
      );
      attempts.set(msg.peer, { peer: msg.peer, keys, peerAd: msg.ad });
    }

    async function handlePeerConfirm(peer: string, tag: string) {
      const attempt = attempts.get(peer);
      if (!attempt) return;

      // This is the moment of truth. A wrong four-digit guess produces a
      // different key, so the tag will not verify — and closing this peer
      // destroys the mailbox, which is what caps an attacker at one attempt.
      if (
        !verifyConfirmation(attempt.keys.confirm, "browser", hexToBytes(tag))
      ) {
        giveUpOn(peer, "confirmation failed");
        return;
      }

      socket.send({
        type: "pair:confirm",
        peer,
        tag: bytesToHex(confirmationTag(attempt.keys.confirm, "cli")),
      });

      try {
        const descriptor = opts.buildDescriptor();
        const sealed = await opts.seal(attempt.keys, descriptor);
        socket.send({
          type: "pair:establish",
          peer,
          sealedDescriptor: bytesToBase64Url(sealed),
        });
        finish(null, {
          keys: attempt.keys,
          peerDeviceId: null,
          peerLabel: attempt.peerAd || "browser",
        });
      } catch (err) {
        finish(
          new PairingError(
            `Could not complete pairing: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    }
  });
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "expired":
      return "That code has expired. Reload the page for a new one.";
    case "already-claimed":
      return "That code has already been used.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and try again.";
    case "peer-gone":
      return "The page stopped waiting for this code.";
    default:
      return "Pairing failed.";
  }
}

/** Default transport: real HTTP + WebSocket against the broker. */
export function httpTransport(apiBase: string): PairingTransport {
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
      return (await res.json()) as { claimId: string; offered: number };
    },

    openClaimSocket(claimId) {
      const url = `${apiBase.replace(/^http/, "ws")}/v1/claim/${claimId}`;
      const ws = new WebSocket(url);
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
    },
  };
}

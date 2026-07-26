import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  generateSecret,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  base64UrlToBytes,
  FrameOpener,
  type SessionKeys,
} from "@repo/crypto";
import {
  SealedDescriptor,
  tryDeserializePairingServerMessage,
} from "@repo/protocol";

/**
 * The browser half of hosted pairing.
 *
 * The broker hands out a public two-digit slot; this module generates the
 * four-digit secret locally with crypto.getRandomValues and never sends it
 * anywhere. Together they are the six digits on screen. The secret is the PAKE
 * password, so a broker that never learns it cannot impersonate either side.
 */

const AD_BROWSER = "browser";

export type PairingPhase =
  | "requesting"
  | "waiting"
  | "verifying"
  | "paired"
  | "failed";

export type PairingUpdate =
  | { phase: "waiting"; code: string; expiresAt: number }
  | { phase: "verifying" }
  | { phase: "paired"; keys: SessionKeys; descriptor: SealedDescriptor }
  | { phase: "failed"; message: string };

export type BrowserPairingOptions = {
  apiBase: string;
  onUpdate: (update: PairingUpdate) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  socketImpl?: (url: string) => WebSocket;
};

export type PairingHandle = { cancel(): void };

export function startPairing(opts: BrowserPairingOptions): PairingHandle {
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket = opts.socketImpl ?? ((url: string) => new WebSocket(url));

  // Generated here and only here. It is never transmitted, hashed or logged.
  const secret = generateSecret();
  let socket: WebSocket | null = null;
  let cancelled = false;
  let settled = false;

  function fail(message: string) {
    if (settled || cancelled) return;
    settled = true;
    socket?.close();
    opts.onUpdate({ phase: "failed", message });
  }

  void (async () => {
    let mailboxId: string;
    let slot: string;
    let expiresAt: number;
    try {
      const res = await doFetch(`${opts.apiBase}/v1/pair/new`, {
        method: "POST",
      });
      if (res.status === 429) {
        fail("Too many codes requested. Wait a minute and reload.");
        return;
      }
      if (!res.ok) {
        fail("The pairing service is unavailable. Try again shortly.");
        return;
      }
      ({ mailboxId, slot, expiresAt } = (await res.json()) as {
        mailboxId: string;
        slot: string;
        expiresAt: number;
      });
    } catch {
      fail("Could not reach the pairing service.");
      return;
    }
    if (cancelled) return;

    opts.onUpdate({
      phase: "waiting",
      code: `${slot}${secret}`,
      expiresAt,
    });

    const wsUrl = `${opts.apiBase.replace(/^http/, "ws")}/v1/pair/${mailboxId}`;
    socket = makeSocket(wsUrl);

    let keys: SessionKeys | null = null;
    let peerHandle: string | null = null;

    socket.onmessage = (event) => {
      const parsed = tryDeserializePairingServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:failed") {
        fail(describeFailure(msg.reason));
        return;
      }

      if (msg.type === "pair:peer-share") {
        peerHandle = msg.peer;
        opts.onUpdate({ phase: "verifying" });

        const cpace = cpaceStart(
          utf8ToBytes(secret),
          utf8ToBytes(slot),
          hexToBytes(msg.sid),
        );
        let isk: Uint8Array;
        try {
          isk = cpace.finish(hexToBytes(msg.share), {
            own: utf8ToBytes(AD_BROWSER),
            peer: utf8ToBytes(msg.ad),
            isInitiator: false,
          });
        } catch {
          fail("Pairing failed — the other side sent something invalid.");
          return;
        }

        keys = deriveSessionKeys(
          isk,
          transcriptIr(
            hexToBytes(msg.share),
            utf8ToBytes(msg.ad),
            cpace.share,
            utf8ToBytes(AD_BROWSER),
          ),
        );

        socket?.send(
          JSON.stringify({
            type: "pair:share",
            peer: msg.peer,
            share: bytesToHex(cpace.share),
            ad: AD_BROWSER,
          }),
        );
        socket?.send(
          JSON.stringify({
            type: "pair:confirm",
            peer: msg.peer,
            tag: bytesToHex(confirmationTag(keys.confirm, AD_BROWSER)),
          }),
        );
        return;
      }

      if (msg.type === "pair:peer-confirm") {
        if (!keys || msg.peer !== peerHandle) return;
        // A wrong code on the other machine produces a different key, so this
        // tag will not verify — and saying so destroys the mailbox, which is
        // what makes each code good for exactly one attempt.
        if (!verifyConfirmation(keys.confirm, "cli", hexToBytes(msg.tag))) {
          socket?.send(
            JSON.stringify({
              type: "pair:close",
              peer: msg.peer,
              reason: "confirmation failed",
            }),
          );
          fail("That code was entered incorrectly. Reload for a new one.");
        }
        return;
      }

      if (msg.type === "pair:established") {
        if (!keys) return;
        void unsealDescriptor(keys, msg.sealedDescriptor)
          .then((descriptor) => {
            if (settled || cancelled) return;
            settled = true;
            socket?.close();
            opts.onUpdate({ phase: "paired", keys: keys!, descriptor });
          })
          .catch(() => fail("Pairing failed — the reply could not be read."));
      }
    };

    socket.onclose = () => {
      if (!settled && !cancelled) {
        fail("Lost the connection to the pairing service.");
      }
    };
  })();

  return {
    cancel() {
      cancelled = true;
      socket?.close();
    },
  };
}

/**
 * Open the CLI's sealed connection descriptor.
 *
 * This is the first thing sealed under the pairing key, so a failure here means
 * the key is wrong — which the confirmation step should already have caught.
 */
export async function unsealDescriptor(
  keys: SessionKeys,
  sealed: string,
): Promise<SealedDescriptor> {
  const opener = new FrameOpener(keys.s2c, "s2c");
  const opened = await opener.open(base64UrlToBytes(sealed));
  return SealedDescriptor.parse(
    JSON.parse(new TextDecoder().decode(opened)) as unknown,
  );
}

function describeFailure(reason: string): string {
  switch (reason) {
    case "expired":
      return "This code expired. Reload for a new one.";
    case "already-claimed":
      return "This code has already been used. Reload for a new one.";
    case "confirmation-failed":
      return "The code was entered incorrectly. Reload for a new one.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and reload.";
    default:
      return "Pairing failed. Reload for a new code.";
  }
}

import {
  cpaceStart,
  deriveSessionKeys,
  confirmationTag,
  verifyConfirmation,
  transcriptIr,
  generateSecret,
  parseCode,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
  base64UrlToBytes,
  FrameOpener,
  type SessionKeys,
} from "@repo/crypto";
import {
  MAX_PEERS_PER_SLOT,
  SealedDescriptor,
  tryDeserializePairingServerMessage,
} from "@repo/protocol";

/**
 * The browser half of hosted pairing, in both directions.
 *
 * `startPairing` shows a code and waits: the browser holds the mailbox and
 * generates the four-digit secret locally with crypto.getRandomValues.
 * `joinPairing` is the mirror image, used when the terminal is the one showing
 * a code — a QR scan lands on /j with the six digits in the fragment and the
 * browser claims them.
 *
 * The secret is the PAKE password either way, and it is never sent anywhere:
 * not to the broker, not hashed, not in a URL the server would see. A broker
 * that never learns it cannot impersonate either side.
 *
 * ## The identity labels never swap
 *
 * `confirmationTag(key, "browser")` and `verifyConfirmation(key, "cli", …)` are
 * keyed to *who* each end is, not to which of them initiated the CPace run.
 * They stay put when the direction inverts. So do the frame direction tags:
 * `c2s` is always browser→CLI. Only the transcript ordering follows the
 * initiator, because CPace defines it that way.
 */

const AD_BROWSER = "browser";
const AD_CLI = "cli";

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

export type PairingHandle = { cancel(): void };

type SocketFactory = (url: string) => WebSocket;

type CommonOptions = {
  apiBase: string;
  onUpdate: (update: PairingUpdate) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  socketImpl?: SocketFactory;
};

export type BrowserPairingOptions = CommonOptions;

export type JoinPairingOptions = CommonOptions & {
  /** The six digits, however the user typed or scanned them. */
  code: string;
};

function wsBase(apiBase: string): string {
  return apiBase.replace(/^http/, "ws");
}

// ---------------------------------------------------------------------------
// Showing a code: /pair
// ---------------------------------------------------------------------------

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

    socket = makeSocket(`${wsBase(opts.apiBase)}/v1/pair/${mailboxId}`);

    let keys: SessionKeys | null = null;
    let peerHandle: string | null = null;

    socket.onmessage = (event) => {
      const parsed = tryDeserializePairingServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:ready") {
        // The broker confirming this socket is the one that will receive the
        // claim. The code is already on screen; what is worth taking is its
        // `expiresAt`, which is the mailbox's real deadline rather than the one
        // the POST reported before the socket existed.
        opts.onUpdate({
          phase: "waiting",
          code: `${slot}${secret}`,
          expiresAt: msg.expiresAt,
        });
        return;
      }

      if (msg.type === "pair:failed") {
        fail(describeFailure(msg.reason));
        return;
      }

      if (msg.type === "pair:peer-share") {
        peerHandle = msg.peer;
        opts.onUpdate({ phase: "verifying" });

        // The claimant chose the session id, and is the initiator — so its
        // share leads the transcript.
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
        if (!verifyConfirmation(keys.confirm, AD_CLI, hexToBytes(msg.tag))) {
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
        const settledKeys = keys;
        void unsealDescriptor(settledKeys, msg.sealedDescriptor)
          .then((descriptor) => {
            if (settled || cancelled) return;
            settled = true;
            socket?.close();
            opts.onUpdate({ phase: "paired", keys: settledKeys, descriptor });
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

// ---------------------------------------------------------------------------
// Claiming a code: /j
// ---------------------------------------------------------------------------

/** One in-flight CPace exchange with a single candidate mailbox. */
type Attempt = { keys: SessionKeys; peerAd: string };

/**
 * How long to wait for a straggling terminal before calling a code wrong.
 *
 * Long enough that a terminal on a slow link is not mistaken for a bad code,
 * short enough that a genuinely wrong code still fails promptly.
 */
const NO_MATCH_GRACE_MS = 3_000;

/**
 * Claim a code the terminal is showing.
 *
 * A slot is two digits and deliberately shared, so this claim is offered to
 * every live mailbox holding it and several may answer. Each gets its own CPace
 * run; the one whose confirmation tag verifies is the real terminal and the
 * rest are closed, which destroys their mailboxes. Answering is therefore no
 * evidence of anything — only a tag that verifies is.
 */
export function joinPairing(opts: JoinPairingOptions): PairingHandle {
  const doFetch = opts.fetchImpl ?? fetch;
  const makeSocket = opts.socketImpl ?? ((url: string) => new WebSocket(url));

  let socket: WebSocket | null = null;
  let cancelled = false;
  let settled = false;
  /**
   * Armed when the last known candidate is ruled out.
   *
   * Terminals answer independently over the network, so a decoy sharing the
   * slot can be ruled out before the real one has said anything — failing the
   * instant the counter hits zero would reject a correct code on a slow link.
   * A share arriving cancels the window.
   */
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  function clearGrace() {
    if (!graceTimer) return;
    clearTimeout(graceTimer);
    graceTimer = null;
  }

  function fail(message: string) {
    if (settled || cancelled) return;
    settled = true;
    clearGrace();
    socket?.close();
    opts.onUpdate({ phase: "failed", message });
  }

  const parsedCode = parseCode(opts.code);
  if (!parsedCode) {
    // Reported asynchronously so the caller sees it through `onUpdate` like
    // every other failure, rather than having to handle a throw as well.
    queueMicrotask(() => fail("That is not a six-digit pairing code."));
    return { cancel() {} };
  }
  const { slot, secret } = parsedCode;

  void (async () => {
    opts.onUpdate({ phase: "verifying" });

    // The claimant picks the session id and is the CPace initiator, so one
    // share serves every mailbox that answers.
    const sid = randomBytes(16);
    const cpace = cpaceStart(utf8ToBytes(secret), utf8ToBytes(slot), sid);

    let claimId: string;
    let waiting: boolean;
    try {
      const res = await doFetch(`${opts.apiBase}/v1/pair/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot,
          share: bytesToHex(cpace.share),
          ad: AD_BROWSER,
          sid: bytesToHex(sid),
        }),
      });
      if (res.status === 429) {
        fail("Too many attempts from this network. Wait a minute.");
        return;
      }
      if (!res.ok) {
        fail("The pairing service is unavailable. Try again shortly.");
        return;
      }
      ({ claimId, waiting } = (await res.json()) as {
        claimId: string;
        waiting: boolean;
      });
    } catch {
      fail("Could not reach the pairing service.");
      return;
    }
    if (cancelled) return;

    if (!waiting) {
      fail(
        "Nothing is waiting for that code. Check the digits, or get a new code from your terminal.",
      );
      return;
    }

    socket = makeSocket(`${wsBase(opts.apiBase)}/v1/claim/${claimId}`);

    const attempts = new Map<string, Attempt>();
    /**
     * Mailboxes that could still turn out to be the terminal.
     *
     * Counted from the shares that actually arrive rather than from a number
     * the broker promised, because the broker no longer reports one — a live
     * count on a slot was an enumeration oracle for anyone who could POST.
     * `seen` is what makes "all of them were ruled out" distinguishable from
     * "none has answered yet"; the latter is left to the timeout.
     */
    let outstanding = 0;
    let seen = 0;

    function send(message: unknown) {
      socket?.send(JSON.stringify(message));
    }

    function ruleOut(peer: string) {
      attempts.delete(peer);
      outstanding -= 1;
      if (seen === 0 || outstanding > 0) return;

      // Every peer that answered has been ruled out. Once as many have answered
      // as the broker is allowed to offer, nothing else can be coming.
      if (seen >= MAX_PEERS_PER_SLOT) {
        fail("That code did not match. Get a new one from your terminal.");
        return;
      }
      graceTimer ??= setTimeout(() => {
        fail("That code did not match. Get a new one from your terminal.");
      }, NO_MATCH_GRACE_MS);
    }

    /**
     * Rule a mailbox out *and* tell the broker, which destroys it. That is the
     * whole guessing bound: one wrong code costs the code, not one of ten
     * thousand tries.
     */
    function giveUpOn(peer: string, reason: string) {
      send({ type: "pair:close", peer, reason });
      ruleOut(peer);
    }

    socket.onmessage = (event) => {
      const parsed = tryDeserializePairingServerMessage(event.data as string);
      if (!parsed.ok) return;
      const msg = parsed.message;

      if (msg.type === "pair:ready") {
        // Only a mailbox holder is ever sent this; a claim socket receiving one
        // is a broker bug, and ignoring it is the right response either way.
        return;
      }

      if (msg.type === "pair:failed") {
        // A peer-scoped failure retires one mailbox; only a failure naming no
        // peer is about this socket and ends the attempt.
        if (msg.peer) ruleOut(msg.peer);
        else fail(describeFailure(msg.reason));
        return;
      }

      if (msg.type === "pair:peer-share") {
        // A second share for a conversation already under way is either a
        // confused terminal or someone hoping to restart it under a fresh
        // scalar. Neither is a reason to abandon the run in progress.
        if (attempts.has(msg.peer)) return;

        // The broker caps live mailboxes per slot, so more answers than that
        // means it is not playing by its own rules — the shape a broker would
        // take if it were fanning a code out to attackers to multiply their
        // guesses. Refuse rather than race them.
        // A straggler arrived, so "everyone has been ruled out" was wrong.
        clearGrace();

        seen += 1;
        if (seen > MAX_PEERS_PER_SLOT) {
          fail(
            "The pairing service offered more terminals than it should. " +
              "Stop, and get a new code.",
          );
          return;
        }
        outstanding += 1;

        let isk: Uint8Array;
        try {
          isk = cpace.finish(hexToBytes(msg.share), {
            own: utf8ToBytes(AD_BROWSER),
            peer: utf8ToBytes(msg.ad),
            isInitiator: true,
          });
        } catch {
          // Not a valid group element, or the identity.
          giveUpOn(msg.peer, "invalid share");
          return;
        }

        attempts.set(msg.peer, {
          peerAd: msg.ad,
          keys: deriveSessionKeys(
            isk,
            transcriptIr(
              cpace.share,
              utf8ToBytes(AD_BROWSER),
              hexToBytes(msg.share),
              utf8ToBytes(msg.ad),
            ),
          ),
        });
        return;
      }

      if (msg.type === "pair:peer-confirm") {
        const attempt = attempts.get(msg.peer);
        if (!attempt) return;

        // The moment of truth: a wrong four-digit guess produces a different
        // key, so this tag cannot verify.
        if (
          !verifyConfirmation(attempt.keys.confirm, AD_CLI, hexToBytes(msg.tag))
        ) {
          giveUpOn(msg.peer, "confirmation failed");
          return;
        }

        // Our own tag, so the terminal can finish and seal the descriptor.
        send({
          type: "pair:confirm",
          peer: msg.peer,
          tag: bytesToHex(confirmationTag(attempt.keys.confirm, AD_BROWSER)),
        });
        return;
      }

      if (msg.type === "pair:established") {
        const attempt = attempts.get(msg.peer);
        if (!attempt) return;
        void unsealDescriptor(attempt.keys, msg.sealedDescriptor)
          .then((descriptor) => {
            if (settled || cancelled) return;
            settled = true;
            socket?.close();
            opts.onUpdate({
              phase: "paired",
              keys: attempt.keys,
              descriptor,
            });
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
 * A fresh `FrameOpener` every time, deliberately. Several candidate mailboxes
 * can be in flight at once, and a failed trial decryption must not advance the
 * replay window of a schedule that turns out to be the real one.
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
      return "This code expired. Get a new one.";
    case "already-claimed":
      return "This code has already been used. Get a new one.";
    case "confirmation-failed":
      return "The code did not match. Get a new one.";
    case "rate-limited":
      return "Too many attempts. Wait a minute and try again.";
    default:
      return "Pairing failed. Get a new code.";
  }
}

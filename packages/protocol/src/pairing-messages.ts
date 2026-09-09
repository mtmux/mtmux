import { z } from "zod";
import { MAX_LABEL_LENGTH, sanitizeLabel } from "./display-label";
import { ProtocolVersionSchema } from "./version";

/**
 * Wire format for hosted pairing and the fallback tunnel.
 *
 * Deliberately a separate pair of discriminated unions from ClientMessage /
 * ServerMessage: these travel between the browser/CLI and `api.mtmux.com`,
 * never over the tmux relay socket, and folding them into the tmux protocol
 * would imply the relay understands pairing (it does not) and that the broker
 * understands terminals (it must not).
 *
 * Everything the broker sees here is either routing metadata or an opaque
 * blob. Nothing in this file lets it read a keystroke.
 */

/** Hex-encoded bytes of an exact length. */
const hex = (bytes: number) =>
  z
    .string()
    .regex(
      new RegExp(`^[0-9a-f]{${bytes * 2}}$`),
      `expected ${bytes} hex bytes`,
    );

/** Base64url blob with a sane upper bound, for sealed frames. */
const blob = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9_-]*$/, "expected base64url");

/**
 * The public routing half of the pairing code.
 *
 * Two digits for a code a human types, four for the one a QR carries. They are
 * separate spaces rather than one, because they are attacked differently: the
 * typed space is small enough to sweep, and every sweep that lands on a live
 * pairing costs its holder a code. Moving the QR out means a sweep of the typed
 * slots cannot touch a scanned pairing at all, and doubles how many typed
 * pairings the broker can hold at once.
 *
 * No namespacing is needed on the broker's side: slots are keyed on the exact
 * string, and "492" and "0492" are distinct keys of distinct lengths.
 */
export const SlotSchema = z.string().regex(/^(\d{3}|\d{4})$/);
/** Opaque broker-assigned identifiers. */
export const MailboxIdSchema = z.string().min(8).max(64);
export const TunnelIdSchema = z.string().min(8).max(64);
export const StreamIdSchema = z.string().min(1).max(64);

/** A single sealed frame's maximum size on the wire (1 MiB of plaintext). */
export const MAX_FRAME_BYTES = 1024 * 1024 + 1024;

/**
 * Live mailboxes the broker will keep on one slot, and therefore the most
 * peers a claimant should ever be offered.
 *
 * Shared rather than private to the broker because it is the claimant that
 * benefits from checking it. A broker fanning one claim out to many mailboxes
 * multiplies an attacker's guesses per pairing, so a claimant seeing more
 * answers than this is looking at a broker breaking its own contract and
 * should stop — the check costs nothing and does not depend on trusting it.
 */
export const MAX_PEERS_PER_SLOT = 2;

// ---------------------------------------------------------------------------
// Either end → broker (over WS /v1/pair/:mailboxId or WS /v1/claim/:claimId)
//
// These messages are deliberately direction-neutral. Pairing has two roles —
// the mailbox holder who parks a slot and waits, and the claimant who quotes it
// — and either can be the browser or the CLI: a phone opens app.mtmux.com/pair
// and the CLI claims it, or `mtmux start` prints a code and the phone claims
// that. Nothing below names which end runs a terminal, and nothing should.
// ---------------------------------------------------------------------------

/**
 * Opaque handle for the other end of one pairing attempt.
 *
 * A slot is shared by many simultaneous pairings, so a single claim is fanned
 * out to every live mailbox under it and may hear back from several. The peer
 * handle keeps those conversations apart. It is minted per attempt by the
 * broker and means nothing outside it.
 */
export const PeerHandleSchema = z.string().min(4).max(64);

/**
 * A CPace share. `share` is a ristretto255 element; the broker can do nothing
 * with it, because the four-digit secret never reaches the broker.
 */
export const PairShareMessage = z.object({
  type: z.literal("pair:share"),
  peer: PeerHandleSchema,
  share: hex(32),
  /** Associated data bound into the CPace transcript. */
  ad: z.string().max(256),
});

/** Key confirmation, proving this side derived the same key. */
export const PairConfirmMessage = z.object({
  type: z.literal("pair:confirm"),
  peer: PeerHandleSchema,
  tag: hex(32),
});

/**
 * The sealed connection descriptor, forwarded verbatim to the peer as
 * `pair:established`.
 *
 * Always sent by the CLI, but on whichever socket the CLI happens to hold: the
 * claim socket when the browser opened the mailbox, the mailbox socket when
 * `mtmux start` did. It is the last message of a successful pairing either way.
 */
export const PairEstablishMessage = z.object({
  type: z.literal("pair:establish"),
  peer: PeerHandleSchema,
  sealedDescriptor: blob(8192),
});

/**
 * Give up on one peer (bad confirmation, navigated away, expired).
 *
 * A close after a claim always destroys the mailbox. That is what makes a
 * wrong guess cost the attacker the whole code.
 */
export const PairCloseMessage = z.object({
  type: z.literal("pair:close"),
  peer: PeerHandleSchema.optional(),
  reason: z.string().max(256).optional(),
});

export const PairingClientMessage = z.discriminatedUnion("type", [
  PairShareMessage,
  PairConfirmMessage,
  PairEstablishMessage,
  PairCloseMessage,
]);

// ---------------------------------------------------------------------------
// Broker → either end
// ---------------------------------------------------------------------------

/**
 * The mailbox is live and holding the given slot.
 *
 * Sent once, to the mailbox holder only, immediately after its socket attaches.
 * The slot and expiry are already known from `POST /v1/pair/new`; this is the
 * broker confirming the socket is the one that will receive the claim, and its
 * `expiresAt` is the authoritative countdown to display.
 */
export const PairReadyMessage = z.object({
  type: z.literal("pair:ready"),
  mailboxId: MailboxIdSchema,
  slot: SlotSchema,
  expiresAt: z.number().int().positive(),
});

/**
 * The other side's CPace share.
 *
 * Sent to a mailbox holder when someone claims its slot, and to a claimant for
 * each mailbox that answers. Because a claim is fanned out to every live
 * mailbox on the slot, receiving this is not evidence that the peer knows the
 * secret — only a valid `pair:peer-confirm` is.
 *
 * `sid` is always the *claimant's* session id, whichever direction the message
 * travels: one side has to choose it, and the claimant is the only side that
 * exists exactly once per exchange.
 */
export const PairPeerShareMessage = z.object({
  type: z.literal("pair:peer-share"),
  peer: PeerHandleSchema,
  share: hex(32),
  ad: z.string().max(256),
  /** Session id for this CPace run, chosen by the claimant. */
  sid: hex(16),
});

/** The peer's key confirmation tag. */
export const PairPeerConfirmMessage = z.object({
  type: z.literal("pair:peer-confirm"),
  peer: PeerHandleSchema,
  tag: hex(32),
});

/**
 * Pairing succeeded. Carries the sealed descriptor the CLI produced: candidate
 * direct URLs and a tunnel id, encrypted under the pairing key, so the broker
 * cannot learn the user's LAN topology.
 */
export const PairEstablishedMessage = z.object({
  type: z.literal("pair:established"),
  peer: PeerHandleSchema,
  sealedDescriptor: blob(8192),
});

/**
 * Terminal failure. `pair:failed` always destroys the mailbox — a wrong guess
 * burns the code, which is what makes one online attempt the attacker's whole
 * budget.
 */
export const PairFailedMessage = z.object({
  type: z.literal("pair:failed"),
  peer: PeerHandleSchema.optional(),
  reason: z.enum([
    "expired",
    "already-claimed",
    "confirmation-failed",
    "peer-gone",
    "rate-limited",
    "server-error",
  ]),
  message: z.string().max(256).optional(),
});

export const PairingServerMessage = z.discriminatedUnion("type", [
  PairReadyMessage,
  PairPeerShareMessage,
  PairPeerConfirmMessage,
  PairEstablishedMessage,
  PairFailedMessage,
]);

// ---------------------------------------------------------------------------
// Tunnel (WS /v1/agent for the CLI, WS /v1/tunnel/:id for the browser)
// ---------------------------------------------------------------------------

/** The CLI registering its tunnel, signed with its device key. */
export const TunnelRegisterMessage = z.object({
  type: z.literal("tunnel:register"),
  deviceId: hex(8),
  publicKey: hex(32),
  challenge: hex(32),
  signature: hex(64),
});

/** Broker → CLI: a browser wants a stream on this tunnel. */
export const TunnelStreamOpenMessage = z.object({
  type: z.literal("stream:open"),
  streamId: StreamIdSchema,
});

/** Either side closing one stream (not the tunnel). */
export const TunnelStreamCloseMessage = z.object({
  type: z.literal("stream:close"),
  streamId: StreamIdSchema,
  reason: z.string().max(256).optional(),
});

/**
 * One sealed application frame. The broker forwards `data` verbatim; it holds
 * no key that could open it.
 */
export const TunnelFrameMessage = z.object({
  type: z.literal("stream:frame"),
  streamId: StreamIdSchema,
  data: blob(MAX_FRAME_BYTES),
});

/** Broker → either side: the tunnel is going away. */
export const TunnelClosedMessage = z.object({
  type: z.literal("tunnel:closed"),
  reason: z.enum([
    "agent-gone",
    "quota-exceeded",
    "expired",
    "revoked",
    "server-error",
  ]),
});

/**
 * Broker → CLI, first message on /v1/agent: a fresh nonce to sign.
 *
 * The challenge is server-issued on purpose. If the CLI chose it, a captured
 * registration frame could be replayed forever to impersonate the device.
 */
export const TunnelChallengeMessage = z.object({
  type: z.literal("tunnel:challenge"),
  challenge: hex(32),
});

/** Broker → CLI: registration accepted. */
export const TunnelReadyMessage = z.object({
  type: z.literal("tunnel:ready"),
  tunnelId: TunnelIdSchema,
});

// ---------------------------------------------------------------------------
// Requested access: a dashboard asking a machine to let it in
// ---------------------------------------------------------------------------

/**
 * The other direction of pairing, for when nobody is standing at the machine.
 *
 * A typed code assumes the person wanting in can read a screen the machine is
 * showing. Signing in on a new phone breaks that assumption: you own the
 * machine, you can see it listed, and there is nothing you can type. So the
 * browser asks, and a human at the machine approves by comparing six digits.
 *
 * These ride the CLI's existing `/v1/agent` socket, which is already
 * authenticated by the machine's Ed25519 device key — so the broker knows which
 * machine it is forwarding to without the browser ever naming a network route.
 *
 * The ordering below is the security property; see `sas.ts`. The browser
 * commits to its ephemeral key before it has seen the CLI's, which is what
 * stops the broker grinding for a key whose SAS matches.
 */

/** Opaque per-request handle, minted by the broker. */
export const RequestIdSchema = z.string().min(8).max(64);

/** X25519 ephemeral public key, and the SHA-256 commitment to one. */
const ephemeralKey = hex(32);
const commitment = hex(32);

/**
 * Browser → broker, first message on `/v1/request/:id`: the commitment.
 *
 * Separate from the POST that mints the request id because the commitment has
 * to cover that id — committing to a key without binding it to one request
 * would let a commitment be lifted into another. The broker forwards nothing to
 * the machine until this arrives, so the machine still answers having seen a
 * commitment and no key.
 */
export const PairCommitMessage = z.object({
  type: z.literal("pair:commit"),
  requestId: RequestIdSchema,
  commitment,
});

/** Broker → CLI: a browser is asking, and here is what it committed to. */
export const PairRequestMessage = z.object({
  type: z.literal("pair:request"),
  requestId: RequestIdSchema,
  commitment,
  /**
   * Shown to the human deciding. Never trusted for anything else.
   *
   * Sanitised at parse rather than merely bounded: this string is printed into
   * the SAS prompt, and control characters in it can redraw that prompt.
   */
  deviceLabel: z
    .string()
    .max(MAX_LABEL_LENGTH)
    // Not point-free: zod passes its refinement ctx as a second argument,
    // which would land in `maxLength` and truncate every label to "".
    .transform((raw) => sanitizeLabel(raw)),
  accountEmail: z.string().max(320),
});

/** CLI → broker → browser: the machine's own ephemeral key. */
export const PairRequestAckMessage = z.object({
  type: z.literal("pair:request-ack"),
  requestId: RequestIdSchema,
  cliPublicKey: ephemeralKey,
});

/**
 * Browser → broker → CLI: the key the commitment was over.
 *
 * Sent only after the CLI's key has arrived. The CLI checks this against the
 * commitment it was given first, and a mismatch ends the request.
 */
export const PairRevealMessage = z.object({
  type: z.literal("pair:reveal"),
  requestId: RequestIdSchema,
  browserPublicKey: ephemeralKey,
});

/** CLI → broker → browser: approved, with the descriptor sealed under c2s. */
export const PairApprovedMessage = z.object({
  type: z.literal("pair:approved"),
  requestId: RequestIdSchema,
  sealedDescriptor: blob(4096),
});

/** CLI → broker → browser, or broker on its own: the request is over. */
export const PairDeniedMessage = z.object({
  type: z.literal("pair:denied"),
  requestId: RequestIdSchema,
  reason: z.enum([
    "refused",
    "commitment-failed",
    "no-tty",
    "timeout",
    "unknown-request",
    "agent-gone",
    "too-many-requests",
  ]),
});

export const TunnelClientMessage = z.discriminatedUnion("type", [
  TunnelRegisterMessage,
  TunnelStreamCloseMessage,
  TunnelFrameMessage,
  PairRequestAckMessage,
  PairApprovedMessage,
  PairDeniedMessage,
]);

export const TunnelServerMessage = z.discriminatedUnion("type", [
  TunnelChallengeMessage,
  TunnelReadyMessage,
  TunnelStreamOpenMessage,
  TunnelStreamCloseMessage,
  TunnelFrameMessage,
  TunnelClosedMessage,
  PairRequestMessage,
  PairRevealMessage,
]);

/** What the browser sends and receives on `/v1/request/:requestId`. */
export const RequestClientMessage = z.discriminatedUnion("type", [
  PairCommitMessage,
  PairRevealMessage,
]);

export const RequestServerMessage = z.discriminatedUnion("type", [
  PairRequestAckMessage,
  PairApprovedMessage,
  PairDeniedMessage,
]);

// ---------------------------------------------------------------------------
// HTTP bodies
// ---------------------------------------------------------------------------

/**
 * POST /v1/pair/new
 *
 * `space` picks which slot space to draw from. The default is `typed` and must
 * stay that way forever: a browser bundled inside a CLI posts an empty body
 * and must still land in the typed space. The width of a typed slot is a
 * separate question, and moved to three digits in 0.7.0.
 */
export const PairNewRequest = z.object({
  /**
   * The protocol this client speaks. Required, and its absence is itself the
   * signal: every client before 0.7.0 sent no `v`, and none of them can
   * complete a pairing against this broker.
   *
   * The broker answers 426 before it parses, so this schema never sees a
   * versionless body in practice — it is here so a client cannot omit `v` and
   * be quietly accepted by some other consumer of the schema.
   */
  v: ProtocolVersionSchema,
  space: z.enum(["typed", "scan"]).optional(),
});

export const PairNewResponse = z.object({
  mailboxId: MailboxIdSchema,
  slot: SlotSchema,
  expiresAt: z.number().int().positive(),
  /**
   * The mailbox's lifetime, as a duration rather than a deadline.
   *
   * Additive, so older clients ignore it. It exists because `expiresAt` is on
   * the broker's clock and the countdown runs on the caller's: a machine three
   * minutes fast subtracts its way to a negative timeout and burns its whole
   * re-arm budget in milliseconds. A duration cannot skew.
   */
  ttlMs: z.number().int().positive().optional(),
});

/**
 * Bounds on how long a hosted code may be believed to live.
 *
 * The floor is the one that matters. `expiresAt` is stamped on the broker's
 * clock and every countdown — the CLI's re-arm deadline, the `/pair` page's
 * timer — runs on the caller's. A device three minutes fast subtracts its way
 * to a code that has already expired: the code is fine, the arithmetic is not.
 * On the CLI that burned the whole re-arm budget in milliseconds; on the phone
 * it showed a code that said 0s the instant it appeared.
 */
export const MIN_CODE_TTL_MS = 30_000;
export const MAX_CODE_TTL_MS = 300_000;

/**
 * A hosted code's deadline, on the caller's clock.
 *
 * Prefers `ttlMs` — a duration cannot skew — and clamps either way, so the
 * worst a wrong clock or a lying broker can do is make a code short or long
 * rather than stillborn.
 */
export function codeDeadline(
  expiresAt: number,
  ttlMs?: number,
  now: number = Date.now(),
): number {
  const raw = ttlMs ?? expiresAt - now;
  return now + Math.min(Math.max(raw, MIN_CODE_TTL_MS), MAX_CODE_TTL_MS);
}

/**
 * How long a requested pairing may sit undecided.
 *
 * Shared with the browser rather than private to the broker, so the dialog can
 * show a countdown that means something. The three budgets nest deliberately:
 * this 120s, the CLI's 110s TTY prompt, and the 100s a request may sit in front
 * of `mtmux approve`. A decision that arrives after the request has expired is
 * worse than no decision, because the human believes they approved something.
 */
export const REQUEST_TTL_MS = 120_000;

/** POST /v1/pair/claim */
export const PairClaimRequest = z.object({
  v: ProtocolVersionSchema,
  slot: SlotSchema,
  share: hex(32),
  ad: z.string().max(256),
  sid: hex(16),
});

export const ClaimIdSchema = z.string().min(8).max(64);

export const PairClaimResponse = z.object({
  /**
   * Handle for `WS /v1/claim/:claimId`, where the claimant collects the replies.
   *
   * The claim is a POST but the answer is inherently many-valued and
   * asynchronous, so the socket is separate — and since 0.7.0 the socket is
   * also where the claim is *fanned out*. The POST reserves nothing and looks
   * at no mailbox, which is why it can no longer report whether anything was
   * waiting: `waiting` and `offered` are gone, and a claimant learns what is
   * there by counting the peers that answer on the socket.
   */
  claimId: ClaimIdSchema,
  /**
   * When the claim lapses if no socket attaches — a short window, seconds not
   * minutes. It is extended to the full mailbox TTL the moment one does, so
   * this is a deadline to connect by, never a deadline to finish by.
   */
  expiresAt: z.number(),
});

/** GET /v1/discover */
export const DiscoverResponse = z.object({
  ip: z.string().max(64),
});

/**
 * The payload the CLI seals under the pairing key, sealed fresh at counter 0
 * with a `FrameSealer` on the CLI→browser direction. The broker only ever sees
 * its ciphertext — publishing the shape here is safe and keeps both ends
 * honest about it.
 */
/**
 * `POST /v1/pair/request` — a signed-in browser asking one of its own machines
 * for access.
 *
 * Authenticated by the session cookie, and the broker checks the server belongs
 * to that account before forwarding anything. Note what is *not* here: no
 * network address, no route, nothing that would let a caller aim the request at
 * a machine it does not own. The commitment is opaque to the broker.
 */
export const PairRequestBody = z.object({
  v: ProtocolVersionSchema,
  serverId: z.string().min(8).max(64),
  /** How the machine should describe the asker to the human at the keyboard. */
  deviceLabel: z
    .string()
    .max(MAX_LABEL_LENGTH)
    // Not point-free: zod passes its refinement ctx as a second argument,
    // which would land in `maxLength` and truncate every label to "".
    .transform((raw) => sanitizeLabel(raw)),
});

export const SealedDescriptor = z.object({
  /** Direct URLs the browser should race, best first. */
  candidates: z.array(z.string().url().max(512)).max(8),
  /** Tunnel to fall back to when every candidate fails. */
  tunnelId: TunnelIdSchema,
  /** CLI's device identity, so the browser can pin it for reconnects. */
  deviceId: hex(8),
  publicKey: hex(32),
  /** Human label for the device list, e.g. "gagan@thinkpad". */
  label: z
    .string()
    .max(128)
    .transform((raw) => sanitizeLabel(raw, 128)),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PairingClientMessage = z.infer<typeof PairingClientMessage>;
export type PairingServerMessage = z.infer<typeof PairingServerMessage>;
export type TunnelClientMessage = z.infer<typeof TunnelClientMessage>;
export type TunnelServerMessage = z.infer<typeof TunnelServerMessage>;

export type PairShareMessage = z.infer<typeof PairShareMessage>;
export type PairConfirmMessage = z.infer<typeof PairConfirmMessage>;
export type PairEstablishMessage = z.infer<typeof PairEstablishMessage>;
export type PairCloseMessage = z.infer<typeof PairCloseMessage>;
export type PairReadyMessage = z.infer<typeof PairReadyMessage>;
export type PairPeerShareMessage = z.infer<typeof PairPeerShareMessage>;
export type PairPeerConfirmMessage = z.infer<typeof PairPeerConfirmMessage>;
export type PairEstablishedMessage = z.infer<typeof PairEstablishedMessage>;
export type PairFailedMessage = z.infer<typeof PairFailedMessage>;
export type TunnelChallengeMessage = z.infer<typeof TunnelChallengeMessage>;
export type TunnelRegisterMessage = z.infer<typeof TunnelRegisterMessage>;
export type TunnelReadyMessage = z.infer<typeof TunnelReadyMessage>;
export type TunnelStreamOpenMessage = z.infer<typeof TunnelStreamOpenMessage>;
export type TunnelStreamCloseMessage = z.infer<typeof TunnelStreamCloseMessage>;
export type TunnelFrameMessage = z.infer<typeof TunnelFrameMessage>;
export type TunnelClosedMessage = z.infer<typeof TunnelClosedMessage>;
export type RequestClientMessage = z.infer<typeof RequestClientMessage>;
export type RequestServerMessage = z.infer<typeof RequestServerMessage>;
export type PairCommitMessage = z.infer<typeof PairCommitMessage>;
export type PairRequestMessage = z.infer<typeof PairRequestMessage>;
export type PairRequestAckMessage = z.infer<typeof PairRequestAckMessage>;
export type PairRevealMessage = z.infer<typeof PairRevealMessage>;
export type PairApprovedMessage = z.infer<typeof PairApprovedMessage>;
export type PairDeniedMessage = z.infer<typeof PairDeniedMessage>;
export type PairRequestBody = z.infer<typeof PairRequestBody>;
export type PairNewRequest = z.infer<typeof PairNewRequest>;
export type PairNewResponse = z.infer<typeof PairNewResponse>;
/** Which slot space a mailbox is drawn from. */
export type SlotSpace = NonNullable<PairNewRequest["space"]>;
export type PairClaimRequest = z.infer<typeof PairClaimRequest>;
export type PairClaimResponse = z.infer<typeof PairClaimResponse>;
export type DiscoverResponse = z.infer<typeof DiscoverResponse>;
export type SealedDescriptor = z.infer<typeof SealedDescriptor>;

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; message: T } | { ok: false; error: string };

function tryParse<T>(
  schema: { parse: (value: unknown) => T },
  raw: string,
): Parsed<T> {
  try {
    return { ok: true, message: schema.parse(JSON.parse(raw)) };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown parse error",
    };
  }
}

export const tryDeserializePairingClientMessage = (raw: string) =>
  tryParse(PairingClientMessage, raw);
export const tryDeserializePairingServerMessage = (raw: string) =>
  tryParse(PairingServerMessage, raw);
export const tryDeserializeTunnelClientMessage = (raw: string) =>
  tryParse(TunnelClientMessage, raw);
export const tryDeserializeTunnelServerMessage = (raw: string) =>
  tryParse(TunnelServerMessage, raw);
export const tryDeserializeRequestClientMessage = (raw: string) =>
  tryParse(RequestClientMessage, raw);
export const tryDeserializeRequestServerMessage = (raw: string) =>
  tryParse(RequestServerMessage, raw);

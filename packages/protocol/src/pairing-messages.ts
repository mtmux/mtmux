import { z } from "zod";

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

/** The public two-digit routing half of the pairing code. */
export const SlotSchema = z.string().regex(/^\d{2}$/);
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

export const TunnelClientMessage = z.discriminatedUnion("type", [
  TunnelRegisterMessage,
  TunnelStreamCloseMessage,
  TunnelFrameMessage,
]);

export const TunnelServerMessage = z.discriminatedUnion("type", [
  TunnelChallengeMessage,
  TunnelReadyMessage,
  TunnelStreamOpenMessage,
  TunnelStreamCloseMessage,
  TunnelFrameMessage,
  TunnelClosedMessage,
]);

// ---------------------------------------------------------------------------
// HTTP bodies
// ---------------------------------------------------------------------------

/** POST /v1/pair/new */
export const PairNewResponse = z.object({
  mailboxId: MailboxIdSchema,
  slot: SlotSchema,
  expiresAt: z.number().int().positive(),
});

/** POST /v1/pair/claim */
export const PairClaimRequest = z.object({
  slot: SlotSchema,
  share: hex(32),
  ad: z.string().max(256),
  sid: hex(16),
});

export const ClaimIdSchema = z.string().min(8).max(64);

export const PairClaimResponse = z.object({
  /**
   * Whether anything was waiting on that slot. Deliberately not a count.
   *
   * This used to report how many live mailboxes the claim was fanned out to,
   * which handed any unauthenticated caller an exact read on how many pairings
   * were in flight on a slot — free enumeration, repeatable, no crypto needed.
   * A claimant only ever needed to know whether to open a socket; how many
   * peers there are it discovers by counting the ones that answer.
   */
  waiting: z.boolean(),
  /**
   * Handle for `WS /v1/claim/:claimId`, where the CLI collects the replies.
   *
   * The claim is a POST (per plan) but the answer is inherently many-valued
   * and asynchronous, so the socket is separate. Messages produced before the
   * socket attaches are buffered for the mailbox TTL, which removes the race
   * between fan-out and connect.
   */
  claimId: ClaimIdSchema,
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
export const SealedDescriptor = z.object({
  /** Direct URLs the browser should race, best first. */
  candidates: z.array(z.string().url().max(512)).max(8),
  /** Tunnel to fall back to when every candidate fails. */
  tunnelId: TunnelIdSchema,
  /** CLI's device identity, so the browser can pin it for reconnects. */
  deviceId: hex(8),
  publicKey: hex(32),
  /** Human label for the device list, e.g. "gagan@thinkpad". */
  label: z.string().max(128),
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
export type PairNewResponse = z.infer<typeof PairNewResponse>;
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

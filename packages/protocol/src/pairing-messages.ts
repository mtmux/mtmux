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

// ---------------------------------------------------------------------------
// Browser → broker (over WS /v1/pair/:mailboxId)
// ---------------------------------------------------------------------------

/**
 * The browser's CPace share, sent in response to a claim.
 *
 * `share` is a ristretto255 element. The broker cannot do anything with it
 * without the four-digit secret, which it never receives.
 */
export const PairMailboxShareMessage = z.object({
  type: z.literal("pair:share"),
  share: hex(32),
  /** Associated data bound into the CPace transcript. */
  ad: z.string().max(256),
});

/** Key confirmation, proving the browser derived the same key. */
export const PairMailboxConfirmMessage = z.object({
  type: z.literal("pair:confirm"),
  tag: hex(32),
});

/** The browser giving up on a mailbox (navigated away, code expired). */
export const PairMailboxCloseMessage = z.object({
  type: z.literal("pair:close"),
  reason: z.string().max(256).optional(),
});

export const PairingClientMessage = z.discriminatedUnion("type", [
  PairMailboxShareMessage,
  PairMailboxConfirmMessage,
  PairMailboxCloseMessage,
]);

// ---------------------------------------------------------------------------
// Broker → browser
// ---------------------------------------------------------------------------

/** The mailbox is live and holding the given slot. */
export const PairReadyMessage = z.object({
  type: z.literal("pair:ready"),
  mailboxId: MailboxIdSchema,
  slot: SlotSchema,
  expiresAt: z.number().int().positive(),
});

/**
 * Someone claimed this mailbox's slot. Fanned out to every live mailbox under
 * that slot — only the one whose secret matches will produce a valid
 * confirmation, so this message is not evidence the claimant knows anything.
 */
export const PairClaimedMessage = z.object({
  type: z.literal("pair:claimed"),
  /** The claimant's CPace share. */
  share: hex(32),
  ad: z.string().max(256),
  /** Session id for this CPace run, chosen by the claimant. */
  sid: hex(16),
});

/** The peer's key confirmation tag. */
export const PairPeerConfirmMessage = z.object({
  type: z.literal("pair:peer-confirm"),
  tag: hex(32),
});

/**
 * Pairing succeeded. Carries the sealed descriptor the CLI produced: candidate
 * direct URLs and a tunnel id, encrypted under the pairing key, so the broker
 * cannot learn the user's LAN topology.
 */
export const PairEstablishedMessage = z.object({
  type: z.literal("pair:established"),
  sealedDescriptor: blob(8192),
});

/**
 * Terminal failure. `pair:failed` always destroys the mailbox — a wrong guess
 * burns the code, which is what makes one online attempt the attacker's whole
 * budget.
 */
export const PairFailedMessage = z.object({
  type: z.literal("pair:failed"),
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
  PairClaimedMessage,
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

export const PairClaimResponse = z.object({
  /** How many live mailboxes the claim was offered to. Never which. */
  offered: z.number().int().nonnegative(),
  claimId: z.string().min(8).max(64),
});

/** GET /v1/discover */
export const DiscoverResponse = z.object({
  ip: z.string().max(64),
});

/**
 * The payload the CLI seals under the pairing key. The broker only ever sees
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

export type PairMailboxShareMessage = z.infer<typeof PairMailboxShareMessage>;
export type PairMailboxConfirmMessage = z.infer<
  typeof PairMailboxConfirmMessage
>;
export type PairMailboxCloseMessage = z.infer<typeof PairMailboxCloseMessage>;
export type PairReadyMessage = z.infer<typeof PairReadyMessage>;
export type PairClaimedMessage = z.infer<typeof PairClaimedMessage>;
export type PairPeerConfirmMessage = z.infer<typeof PairPeerConfirmMessage>;
export type PairEstablishedMessage = z.infer<typeof PairEstablishedMessage>;
export type PairFailedMessage = z.infer<typeof PairFailedMessage>;
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

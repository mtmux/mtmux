import { z } from "zod";

/**
 * What a recording is, on the wire and on disk.
 *
 * ## No path, ever
 *
 * A `RecordingInfo` carries a `filename`, not a path, and nothing a client
 * sends carries either. The client names a recording by `id` and the relay
 * resolves the file from its own index. That is the whole difference between
 * `recording:fetch` and `file:read` with extra steps, and it is why a
 * recordings-scoped grant can be handed to somebody without also handing them
 * a read of `$HOME`.
 *
 * ## Local files, not server-side blobs
 *
 * A `.cast` never leaves the machine except as AES-GCM frames a recipient has
 * paired for. The broker cannot store one, cannot see one in transit and is
 * never told that one exists — invariants 1, 2 and 4 all say the same thing
 * here, and a "recording library" in our infrastructure would break all three
 * at once.
 */

export const RecordingId = z.string().regex(/^rec_[a-z2-7]{16}$/);
export type RecordingId = z.infer<typeof RecordingId>;

/**
 * What is being recorded.
 *
 * A discriminated union rather than an optional `paneId`, because the two are
 * genuinely different captures with different fidelity: a session recording
 * comes from a pty attached to a locked grouped clone and starts with a full
 * redraw, while a pane recording comes from `pipe-pane` and has to synthesise
 * its first frame. See `apps/relay/src/recorder.ts`.
 */
export const RecordingTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), session: z.string().min(1).max(256) }),
  z.object({
    kind: z.literal("pane"),
    session: z.string().min(1).max(256),
    /** tmux `pane_id`, e.g. `%7`. */
    paneId: z.string().min(1).max(32),
  }),
]);
export type RecordingTarget = z.infer<typeof RecordingTarget>;

/** Why a recording stopped. `null` while it is still running. */
export const RecordingStopReason = z.enum([
  /** Somebody asked it to. */
  "requested",
  /** It hit `MAX_RECORDING_BYTES` or `MAX_RECORDING_MS` and closed cleanly. */
  "limit",
  /** The session or pane went away underneath it. */
  "ended",
  /** The relay died mid-recording; reconstructed by the startup sweep. */
  "interrupted",
  "error",
]);
export type RecordingStopReason = z.infer<typeof RecordingStopReason>;

export const RecordingInfo = z.object({
  id: RecordingId,
  /** Basename inside the recordings directory. Never a path. */
  filename: z.string().min(1).max(256),
  target: RecordingTarget,
  /**
   * Display title, defaulting to the session name and overridable.
   *
   * Overridable because a session name is itself a disclosure — `prod-deploy`
   * tells a recipient something they may not have been meant to learn — and
   * this string is written into the cast header, which travels with the file.
   */
  title: z.string().max(256),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nonnegative().nullable(),
  bytes: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  /** The file's last line was torn — see `parseCast` in `@repo/cast`. */
  truncated: z.boolean(),
  stopReason: RecordingStopReason.nullable(),
});
export type RecordingInfo = z.infer<typeof RecordingInfo>;

/** The on-disk sidecar. Versioned so a format change is detectable, not fatal. */
export const RecordingFile = z.object({
  version: z.literal(1),
  recordings: z.array(RecordingInfo),
});
export type RecordingFile = z.infer<typeof RecordingFile>;

/** A recording is still being written to. */
export function isRecordingLive(recording: RecordingInfo): boolean {
  return recording.endedAt === null;
}

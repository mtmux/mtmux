/**
 * Types for the Web Speech recognition adapter.
 *
 * Declared here rather than pulled from `lib.dom` because `SpeechRecognition`
 * is still not in the standard TypeScript DOM library — it exists only behind
 * `webkitSpeechRecognition` on Chromium and Safari — and because narrowing to
 * exactly what we use is what lets the reducer be tested with a plain object.
 */

export type SpeechErrorCode =
  | "no-speech"
  | "aborted"
  | "audio-capture"
  | "network"
  | "not-allowed"
  | "service-not-allowed"
  | "bad-grammar"
  | "language-not-supported";

export type SpeechState =
  | "unsupported"
  | "idle"
  | "requesting"
  | "listening"
  | "error";

export type SpeechEvent =
  | { type: "start" }
  | { type: "audiostart" }
  | { type: "result"; transcript: string; final: boolean }
  | { type: "error"; code: SpeechErrorCode }
  | { type: "end" }
  | { type: "stop" }
  | { type: "watchdog" }
  | { type: "hidden" };

/** Everything the UI needs, and nothing about the browser API. */
export type SpeechMachine = {
  state: SpeechState;
  /** The last interim transcript, for the ghost line. Never written to a field. */
  interim: string;
  /** Text ready to be inserted at the caret, consumed by the adapter. */
  final: string | null;
  /** A message to show, or null. Sticky for `not-allowed`. */
  message: string | null;
};

/** A minimal `SpeechRecognition`, so tests do not need a browser. */
export type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((e: unknown) => void) | null;
  onaudiostart: ((e: unknown) => void) | null;
  onresult: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: ((e: unknown) => void) | null;
};

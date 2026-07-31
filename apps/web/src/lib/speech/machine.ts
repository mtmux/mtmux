import type { SpeechEvent, SpeechMachine } from "./types";

/**
 * The dictation state machine, as a pure reducer.
 *
 * Every rule here is one the Web Speech API gets wrong if you write the obvious
 * thing, and none of them can be caught in headless Chromium — there is no
 * supported way to inject a transcript, and `--use-fake-device-for-media-stream`
 * feeds `getUserMedia`, which is a different code path entirely. So the
 * interesting half lives here, where it is a table of unit tests.
 *
 * The rules, and why each one exists:
 *
 * - **Double `start` is a no-op.** Chrome throws `InvalidStateError` if you call
 *   `start()` on a recognition that is already running, and a user tapping a mic
 *   button twice is not an error condition.
 * - **`end` after `error` must not clobber the error.** `onend` *always* fires
 *   after `onerror`, so the naive "end → idle" transition erases the message
 *   before anyone reads it.
 * - **`no-speech` and `aborted` are silent.** Both mean "nothing happened":
 *   silence, or the user cancelling. Neither is worth a message.
 * - **`not-allowed` is sticky.** A denied microphone stays denied until the user
 *   changes it in browser settings; re-arming the button invites them to tap a
 *   thing that cannot work.
 * - **Never auto-restart on `end`.** Continuous listening that restarts itself
 *   is a hot mic, and the user cannot tell it from a stuck button.
 * - **A watchdog turns silence into a message.** In an installed iOS PWA
 *   recognition frequently starts and then simply never fires anything, with no
 *   error. Without the watchdog the button spins forever.
 */

export const INITIAL: SpeechMachine = {
  state: "idle",
  interim: "",
  final: null,
  message: null,
};

export const UNSUPPORTED: SpeechMachine = { ...INITIAL, state: "unsupported" };

/** How long a `requesting` may sit with no `audiostart` before we call it dead. */
export const WATCHDOG_MS = 1200;

const MESSAGES: Partial<Record<string, string>> = {
  "audio-capture": "No microphone available.",
  network: "Dictation needs a connection.",
  "not-allowed": "Microphone access is blocked. Allow it in browser settings.",
  "service-not-allowed": "This browser will not run its speech service here.",
  "language-not-supported": "Dictation is not available in this language.",
  "bad-grammar": "Dictation failed. Try again.",
};

export function reduce(
  machine: SpeechMachine,
  event: SpeechEvent,
): SpeechMachine {
  // Nothing revives an unsupported browser. Guarding here rather than at every
  // call site means the UI can dispatch freely.
  if (machine.state === "unsupported") return machine;

  switch (event.type) {
    case "start":
      // Already going: ignore rather than throw InvalidStateError.
      if (machine.state === "requesting" || machine.state === "listening") {
        return machine;
      }
      // A sticky denial is not retried by tapping again.
      if (
        machine.state === "error" &&
        machine.message === MESSAGES["not-allowed"]
      ) {
        return machine;
      }
      return { state: "requesting", interim: "", final: null, message: null };

    case "audiostart":
      if (machine.state !== "requesting") return machine;
      return { ...machine, state: "listening", message: null };

    case "result":
      if (machine.state !== "listening" && machine.state !== "requesting") {
        return machine;
      }
      if (!event.final) {
        // Interim text is *never* written into the field — it renders in a
        // separate ghost line, because a field that rewrites itself as you
        // speak cannot be edited and reads to a screen reader as a firehose.
        return { ...machine, state: "listening", interim: event.transcript };
      }
      return {
        ...machine,
        state: "listening",
        interim: "",
        final: event.transcript,
      };

    case "error": {
      // Silence and cancellation are not failures worth reporting.
      if (event.code === "no-speech" || event.code === "aborted") {
        return { ...machine, state: "idle", interim: "", message: null };
      }
      return {
        state: "error",
        interim: "",
        final: null,
        message: MESSAGES[event.code] ?? "Dictation failed. Try again.",
      };
    }

    case "end":
      // `onend` always follows `onerror`. Letting it reset the state here is
      // what would erase the message before it could be shown.
      if (machine.state === "error") return machine;
      // And never re-`start()`: a self-restarting recogniser is a hot mic.
      return { ...machine, state: "idle", interim: "" };

    case "stop":
    case "hidden":
      if (machine.state === "error") return machine;
      return { ...machine, state: "idle", interim: "" };

    case "watchdog":
      // Started, and nothing ever came back. Only meaningful while still
      // waiting for the first audio event.
      if (machine.state !== "requesting") return machine;
      return {
        state: "error",
        interim: "",
        final: null,
        message: "Dictation did not start. Try the browser instead of the app.",
      };
  }
}

/** Clear a consumed `final` without disturbing anything else. */
export function consumeFinal(machine: SpeechMachine): SpeechMachine {
  return machine.final === null ? machine : { ...machine, final: null };
}

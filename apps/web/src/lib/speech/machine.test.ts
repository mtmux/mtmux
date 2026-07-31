import { describe, it, expect } from "vitest";
import { INITIAL, UNSUPPORTED, consumeFinal, reduce } from "./machine";
import type { SpeechEvent, SpeechMachine } from "./types";

const run = (events: SpeechEvent[], from: SpeechMachine = INITIAL) =>
  events.reduce(reduce, from);

describe("start", () => {
  it("moves to requesting", () => {
    expect(run([{ type: "start" }]).state).toBe("requesting");
  });

  it("is a no-op while already going", () => {
    // Chrome throws InvalidStateError on a second `start()`, and a user
    // double-tapping a mic button is not an error condition.
    const twice = run([{ type: "start" }, { type: "start" }]);
    expect(twice.state).toBe("requesting");

    const listening = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "start" },
    ]);
    expect(listening.state).toBe("listening");
  });

  it("does nothing at all in an unsupported browser", () => {
    expect(reduce(UNSUPPORTED, { type: "start" })).toBe(UNSUPPORTED);
  });
});

describe("results", () => {
  it("keeps interim text out of the final slot", () => {
    const m = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "result", transcript: "git che", final: false },
    ]);
    expect(m.interim).toBe("git che");
    expect(m.final).toBeNull();
  });

  it("clears interim when the final arrives", () => {
    const m = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "result", transcript: "git che", final: false },
      { type: "result", transcript: "git checkout", final: true },
    ]);
    expect(m.interim).toBe("");
    expect(m.final).toBe("git checkout");
    expect(consumeFinal(m).final).toBeNull();
  });

  it("ignores results that arrive after it has stopped", () => {
    const m = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "end" },
      { type: "result", transcript: "late", final: true },
    ]);
    expect(m.final).toBeNull();
  });
});

describe("errors", () => {
  it("stays silent for no-speech and aborted", () => {
    // Silence and cancellation are not failures. Neither deserves a message.
    for (const code of ["no-speech", "aborted"] as const) {
      const m = run([{ type: "start" }, { type: "error", code }]);
      expect(m.state).toBe("idle");
      expect(m.message).toBeNull();
    }
  });

  it("survives the end event that always follows it", () => {
    // `onend` fires after `onerror`, every time. A naive "end → idle" erases
    // the message before anyone can read it.
    const m = run([
      { type: "start" },
      { type: "error", code: "audio-capture" },
      { type: "end" },
    ]);
    expect(m.state).toBe("error");
    expect(m.message).toMatch(/microphone/i);
  });

  it("makes a denial sticky", () => {
    // A blocked microphone stays blocked until the user changes a browser
    // setting; re-arming the button invites a tap that cannot work.
    const denied = run([
      { type: "start" },
      { type: "error", code: "not-allowed" },
    ]);
    expect(denied.state).toBe("error");
    expect(reduce(denied, { type: "start" })).toBe(denied);
  });

  it("lets a recoverable error be retried", () => {
    const failed = run([{ type: "start" }, { type: "error", code: "network" }]);
    expect(reduce(failed, { type: "start" }).state).toBe("requesting");
  });
});

describe("end", () => {
  it("never restarts", () => {
    // A recogniser that restarts itself on `end` is a hot mic the user cannot
    // distinguish from a stuck button.
    const m = run([{ type: "start" }, { type: "audiostart" }, { type: "end" }]);
    expect(m.state).toBe("idle");
  });
});

describe("watchdog", () => {
  it("turns a silent iOS-standalone failure into a message", () => {
    // Recognition starts and then nothing ever happens — no audio, no result,
    // no error. Without this the button spins forever.
    const m = run([{ type: "start" }, { type: "watchdog" }]);
    expect(m.state).toBe("error");
    expect(m.message).toMatch(/did not start/i);
  });

  it("does not fire once audio has arrived", () => {
    const m = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "watchdog" },
    ]);
    expect(m.state).toBe("listening");
  });
});

describe("visibility", () => {
  it("stops listening when the tab is hidden", () => {
    const m = run([
      { type: "start" },
      { type: "audiostart" },
      { type: "hidden" },
    ]);
    expect(m.state).toBe("idle");
  });
});

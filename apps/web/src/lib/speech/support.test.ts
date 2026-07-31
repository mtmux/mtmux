import { describe, it, expect } from "vitest";
import { detectSupport, shouldTransliterate } from "./support";

const env = (over: Partial<Parameters<typeof detectSupport>[0]> = {}) => ({
  hasRecognition: true,
  isSecureContext: true,
  online: true,
  ...over,
});

describe("detectSupport", () => {
  it("says yes when everything is in place", () => {
    expect(detectSupport(env())).toEqual({ supported: true });
  });

  it("renders nothing at all in a browser with no Web Speech", () => {
    // Firefox. There is no action the user can take, and a permanently
    // disabled button with a tooltip is worse than no button — hence a null
    // message, which the component reads as "do not render me".
    const result = detectSupport(env({ hasRecognition: false }));
    expect(result).toEqual({
      supported: false,
      reason: "no-api",
      message: null,
    });
  });

  it("explains itself on the LAN origin", () => {
    // http://192.168.1.5:14100 is how a lot of people reach this app, and a
    // mic that silently does nothing there reads as a bug.
    const result = detectSupport(env({ isSecureContext: false }));
    expect(result).toMatchObject({ reason: "insecure-context" });
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.message).toMatch(/https/i);
  });

  it("short-circuits offline rather than prompting first", () => {
    // Recognition streams to a remote service. Prompting for the microphone
    // and then failing with `network` is two dead ends instead of one message.
    const result = detectSupport(env({ online: false }));
    expect(result).toMatchObject({ reason: "offline" });
  });

  it("reports no-api before anything else", () => {
    const result = detectSupport(
      env({ hasRecognition: false, isSecureContext: false, online: false }),
    );
    expect(result).toMatchObject({ reason: "no-api" });
  });
});

describe("shouldTransliterate", () => {
  it("runs for English locales", () => {
    for (const locale of ["en", "en-US", "en-GB", "EN-us"]) {
      expect(shouldTransliterate(locale)).toBe(true);
    }
  });

  it("does not touch anything else", () => {
    // The table is entirely English words. Applying it to a French or Japanese
    // transcript would corrupt text while claiming to help.
    for (const locale of ["fr-FR", "ja-JP", "de", "es-419", ""]) {
      expect(shouldTransliterate(locale)).toBe(false);
    }
  });
});

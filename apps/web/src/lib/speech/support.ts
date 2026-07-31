/**
 * Whether dictation can work here, and if not, why.
 *
 * The "why" is the point. A mic button that is simply absent on the LAN origin
 * — `http://192.168.1.5:14100`, which is how a lot of people reach this app —
 * looks like a bug, and one that does nothing when tapped is worse. Every
 * negative answer here has a sentence attached to it.
 *
 * Pure, and takes its environment as an argument, so all six branches are unit
 * tests rather than a manual matrix across four browsers.
 */

export type SpeechSupport =
  | { supported: true }
  | {
      supported: false;
      reason: SpeechUnsupportedReason;
      message: string | null;
    };

export type SpeechUnsupportedReason =
  /** Firefox, and anything else with no Web Speech implementation at all. */
  | "no-api"
  /** An http:// origin that is not localhost. getUserMedia is unavailable. */
  | "insecure-context"
  /** Recognition streams to a remote service; offline it cannot start. */
  | "offline";

export type SpeechEnvironment = {
  hasRecognition: boolean;
  isSecureContext: boolean;
  online: boolean;
};

export function detectSupport(env: SpeechEnvironment): SpeechSupport {
  // No API at all — Firefox. Render *nothing*, rather than a disabled button
  // with an explanation: there is no action the user can take in this browser,
  // and a permanently dead control is worse than no control.
  if (!env.hasRecognition) {
    return { supported: false, reason: "no-api", message: null };
  }
  if (!env.isSecureContext) {
    return {
      supported: false,
      reason: "insecure-context",
      message: "Dictation needs an https connection.",
    };
  }
  // Short-circuited before prompting, because the permission dialog appears and
  // then recognition fails with a `network` error the user cannot act on.
  if (!env.online) {
    return {
      supported: false,
      reason: "offline",
      message: "Dictation needs a connection.",
    };
  }
  return { supported: true };
}

/** Read the environment from the browser. Not called during SSR. */
export function readEnvironment(): SpeechEnvironment {
  if (typeof window === "undefined") {
    return { hasRecognition: false, isSecureContext: false, online: false };
  }
  const w = window as unknown as Record<string, unknown>;
  return {
    hasRecognition:
      typeof w.SpeechRecognition === "function" ||
      typeof w.webkitSpeechRecognition === "function",
    isSecureContext: window.isSecureContext === true,
    online: navigator.onLine !== false,
  };
}

/**
 * Whether shell transliteration should run for this locale.
 *
 * The whole table is English words — "dash", "slash", "pipe" — so applying it to
 * a French or Japanese transcript would corrupt text while claiming to help.
 */
export function shouldTransliterate(locale: string): boolean {
  return /^en\b/i.test(locale) || /^en-/i.test(locale);
}

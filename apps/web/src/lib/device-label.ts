/**
 * A coarse name for this browser, e.g. "Chrome on macOS".
 *
 * Used in two places that must not drift: the label sent with a dashboard
 * access request, and the associated data bound into the CPace transcript when
 * this browser claims a code. The second is what makes `mtmux start` able to
 * print "✓ Chrome on iOS connected." instead of "✓ browser connected." — the
 * label was always transmitted and always read, it was simply the literal
 * string "browser".
 *
 * **Deliberately coarse.** Sending the full user-agent would hand the broker a
 * near-unique fingerprint for every device that pairs. Browser family and OS
 * family is enough for a human to recognise their own phone in a list and not
 * much use for anything else. There is precedent — `POST /v1/pair/request`
 * already sends a device label in cleartext — and it does not touch the
 * invariant that matters, which is about what the broker *logs*.
 *
 * Never widen this to include a version, a platform string, or anything
 * derived from screen size.
 */
export function deviceLabel(): string {
  if (typeof navigator === "undefined") return "A browser";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

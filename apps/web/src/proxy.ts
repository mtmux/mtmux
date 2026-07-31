import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Next.js 16 renamed the `middleware` file convention and named export to
// `proxy`. Behaviour here is unchanged: this only sets security headers. The
// auth guard stays client-side because the credential lives in localStorage /
// IndexedDB, which a server-side proxy can't read.
export function proxy(_request: NextRequest) {
  const response = NextResponse.next();

  // Derive relay HTTP origin for CSP (allows <img>, <video>, <audio>, <iframe> to load files).
  // When NEXT_PUBLIC_RELAY_URL is unset (single-port CLI mode), the relay is same-origin
  // and 'self' already covers it.
  const relayWsUrl = process.env.NEXT_PUBLIC_RELAY_URL;
  const relayOrigin = relayWsUrl
    ? ` ${relayWsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:")}`
    : "";

  // The pairing broker is a genuine cross-origin fetch target: /pair calls
  // /v1/pair/new and /v1/discover on it. Without this the page cannot reach the
  // broker at all and hosted pairing dies with a CSP violation — so it is added
  // explicitly rather than by loosening connect-src to all of https:.
  // Unset for self-hosters, who never contact a broker.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  const apiOrigin = apiUrl ? ` ${apiUrl.replace(/\/+$/, "")}` : "";

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  /*
   * A tripwire rather than a fix.
   *
   * Nothing is broken today — this app sends no Permissions-Policy at all, so
   * the microphone is allowed by default. But `apps/site` sets
   * `microphone=()`, and the day somebody consolidates the two header blocks
   * dictation dies with no console message and no obvious cause. Stating the
   * grant explicitly means that consolidation is a diff someone has to read.
   *
   * `camera` and `geolocation` are denied because this app has no use for
   * either and never should.
   */
  response.headers.set(
    "Permissions-Policy",
    "microphone=(self), camera=(), geolocation=()",
  );
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:${apiOrigin}; font-src 'self' data:; img-src 'self' data: blob:${relayOrigin}; media-src 'self'${relayOrigin}; frame-src 'self'${relayOrigin};`,
  );

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon-|manifest.json|sw.js).*)",
  ],
};

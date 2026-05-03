import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // Token is stored client-side in localStorage, which isn't available in middleware.
  // Auth guard is handled on the client side via the layout component.
  // Middleware is used for security headers.
  const response = NextResponse.next();

  // Derive relay HTTP origin for CSP (allows <img>, <video>, <audio>, <iframe> to load files).
  // When NEXT_PUBLIC_RELAY_URL is unset (single-port CLI mode), the relay is same-origin
  // and 'self' already covers it.
  const relayWsUrl = process.env.NEXT_PUBLIC_RELAY_URL;
  const relayOrigin = relayWsUrl
    ? ` ${relayWsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:")}`
    : "";

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; font-src 'self' data:; img-src 'self' data: blob:${relayOrigin}; media-src 'self'${relayOrigin}; frame-src 'self'${relayOrigin};`,
  );

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon-|manifest.json|sw.js).*)"],
};

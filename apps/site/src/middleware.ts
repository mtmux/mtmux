import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { defaultLocale } from "@/i18n/locales";
import { routing } from "@/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

/**
 * Locale routing.
 *
 * Next.js 16 re-invokes this handler on its own internal rewrites, which
 * next-intl does not expect. With `localePrefix: "as-needed"` that produces an
 * infinite redirect: `/` is rewritten to `/en`, the handler runs a second time
 * on `/en`, and — because the default locale is meant to live at the root —
 * redirects back to `/`, forever.
 *
 * next-intl's rewrite target always carries the default-locale prefix, so
 * seeing that prefix on the way in means this is the re-entry pass. There is
 * nothing left to negotiate at that point, so pass it straight through.
 *
 * Genuine external requests to `/en/...` also land here and get served rather
 * than redirected to the unprefixed form. That leaves a duplicate URL, which is
 * resolved the standard way: every page emits a self-referencing canonical
 * pointing at the unprefixed URL (see `buildMetadata` in `src/lib/seo.ts`), and
 * only the unprefixed form appears in the sitemap.
 *
 * The file is `middleware.ts` rather than Next 16's newer `proxy.ts` because
 * both re-enter identically and next-intl documents the middleware entry point,
 * so this keeps us on its supported path.
 */
export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === `/${defaultLocale}` ||
    pathname.startsWith(`/${defaultLocale}/`)
  ) {
    return NextResponse.next();
  }

  return normaliseRewrite(handleI18nRouting(request));
}

/**
 * Forces the internal rewrite target back onto http.
 *
 * TLS terminates at Cloudflare, which forwards `X-Forwarded-Proto: https` to an
 * origin listening on plain HTTP. Next derives `nextUrl` from that header, so
 * next-intl's absolute rewrite comes out as `https://localhost:41317/en` — an
 * https URL aimed at a plaintext port. Next then opens a socket to it, the TLS
 * handshake fails with `EPROTO: wrong version number`, and every page 500s. It
 * never reproduces locally because nothing sets the header there.
 *
 * The scheme is pinned rather than made relative because Next rejects a
 * relative `x-middleware-rewrite` outright (`ERR_INVALID_URL`). Pinning is safe
 * for good: `next start` has no TLS support at all, so a self-referencing
 * origin URL is always http regardless of what the edge terminated.
 *
 * Only the rewrite is touched. Redirect `Location` headers and every canonical,
 * hreflang and Open Graph URL are built from `siteConfig.url` in `lib/seo.ts`,
 * so the public-facing https URLs are unaffected.
 */
function normaliseRewrite(response: Response): Response {
  const target = response.headers.get("x-middleware-rewrite");
  if (!target) return response;

  try {
    const url = new URL(target);
    if (url.protocol === "https:") {
      url.protocol = "http:";
      response.headers.set("x-middleware-rewrite", url.toString());
    }
  } catch {
    // Not an absolute URL; leave it for Next to handle.
  }

  return response;
}

export const config = {
  /**
   * Everything except Next internals, API routes and any path containing a dot,
   * so `/robots.txt`, `/llms.txt`, `/feed.xml`, `/sitemap.xml` and static
   * assets are served untouched.
   */
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};

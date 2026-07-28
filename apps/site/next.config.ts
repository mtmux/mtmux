import { readFileSync } from "node:fs";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The version badge on the site is the version users will actually install, so
 * it is read from the package that gets published rather than typed by hand.
 * Hand-typing it is how the site ended up advertising 0.9.4 while npm served
 * 0.3.0.
 *
 * Read at config time and inlined as a build-time constant: `src/config/site.ts`
 * is imported by client components, so it cannot touch the filesystem itself.
 */
function publishedCliVersion(): string {
  const pkgUrl = new URL("../cli/package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
    version?: string;
  };
  if (!version) {
    throw new Error(
      `apps/cli/package.json has no "version" field (read from ${pkgUrl.pathname})`,
    );
  }
  return version;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  env: {
    NEXT_PUBLIC_MTMUX_VERSION: publishedCliVersion(),
  },
  // Trailing slashes create duplicate URLs; keep exactly one canonical form.
  trailingSlash: false,
  compress: true,

  images: {
    formats: ["image/avif", "image/webp"],
  },

  // `next start` is the production server (see ecosystem.config.cjs), so we
  // deliberately do NOT emit a standalone bundle — the two are alternatives,
  // not complements.

  async headers() {
    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ];

    return [
      { source: "/:path*", headers: securityHeaders },
      // Next already serves /_next/static as immutable; overriding it breaks
      // dev-mode revalidation, so it is deliberately left alone.
      {
        source: "/:file(feed.xml|llms.txt|robots.txt|sitemap.xml)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);

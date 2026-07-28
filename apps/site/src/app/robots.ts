import type { MetadataRoute } from "next";

import { siteConfig } from "@/config/site";

/**
 * Allow everything except the API surface. Deliberately does **not** block
 * AI crawlers (GPTBot, ClaudeBot, PerplexityBot, …) — citation traffic from
 * AI answer engines is a stated goal, not a threat to mitigate.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: "/api/",
    },
    sitemap: `${siteConfig.url}/sitemap.xml`,
    host: siteConfig.url,
  };
}

import type { MetadataRoute } from "next";
import { source } from "@/lib/source";

const BASE_URL = "https://docs.mtmux.com";

/**
 * Generated from the Fumadocs page tree rather than hand-listed.
 *
 * The previous hand-maintained array had already fallen behind the content
 * directory — `/docs/pairing` existed on disk and was missing from the sitemap.
 * Deriving it from `source` means adding an MDX file is the only step.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();

  return pages.map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: "monthly" as const,
    priority:
      page.url === "/docs" ? 1 : page.url.split("/").length > 3 ? 0.6 : 0.8,
  }));
}

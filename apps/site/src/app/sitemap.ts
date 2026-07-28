import type { MetadataRoute } from "next";

import { staticRoutes } from "@/config/site";
import { locales } from "@/i18n/locales";
import { absoluteUrl, languageAlternates } from "@/lib/seo";
import { getAllPosts, getAllTags, tagSlug } from "@/lib/blog";

// Stamped once per build so every static-route entry shares one timestamp,
// instead of a fresh `new Date()` (and therefore a full sitemap diff) on
// every request.
const BUILD_TIME = new Date();

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const entries: MetadataRoute.Sitemap = [];

  // One entry per static route per locale. `alternates.languages` is what
  // makes Next render the `xhtml:link` hreflang annotations inside
  // <url> — the single most commonly botched part of a multilingual sitemap.
  for (const route of staticRoutes) {
    for (const locale of locales) {
      entries.push({
        url: absoluteUrl(locale.code, route.href),
        lastModified: BUILD_TIME,
        changeFrequency: route.changeFrequency,
        priority: route.priority,
        alternates: { languages: languageAlternates(route.href) },
      });
    }
  }

  // Blog posts, per locale (translated and untranslated-fallback copies are
  // both real, servable URLs — see the `untranslated` flag in src/lib/blog.ts).
  for (const locale of locales) {
    const posts = await getAllPosts(locale.code);
    for (const post of posts) {
      const path = `/blog/${post.slug}`;
      entries.push({
        url: absoluteUrl(locale.code, path),
        lastModified: new Date(
          post.frontmatter.updated ?? post.frontmatter.date,
        ),
        changeFrequency: "monthly",
        priority: 0.6,
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  // Tag pages, per locale — freshness follows the newest post carrying the tag.
  for (const locale of locales) {
    const [tags, posts] = await Promise.all([
      getAllTags(locale.code),
      getAllPosts(locale.code),
    ]);

    for (const { tag } of tags) {
      const slug = tagSlug(tag);
      const path = `/blog/tag/${slug}`;
      const newestDate = posts
        .filter((post) =>
          post.frontmatter.tags.some((t) => tagSlug(t) === slug),
        )
        .reduce<string | null>((latest, post) => {
          const candidate = post.frontmatter.updated ?? post.frontmatter.date;
          return !latest || candidate > latest ? candidate : latest;
        }, null);

      entries.push({
        url: absoluteUrl(locale.code, path),
        lastModified: newestDate ? new Date(newestDate) : BUILD_TIME,
        changeFrequency: "weekly",
        priority: 0.4,
        alternates: { languages: languageAlternates(path) },
      });
    }
  }

  return entries;
}

import { siteConfig, staticRoutes } from "@/config/site";
import { defaultLocale } from "@/i18n/locales";
import { loadMessages } from "@/i18n/messages";
import { getAllPosts } from "@/lib/blog";
import { absoluteUrl } from "@/lib/seo";

export const dynamic = "force-static";

type MessageTree = Record<string, unknown>;

function readString(
  tree: MessageTree,
  path: readonly string[],
): string | undefined {
  let node: unknown = tree;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as MessageTree)[key];
  }
  return typeof node === "string" ? node : undefined;
}

/** `/` -> `home`, `/use-cases` -> `use-cases` — matches the `messages/en/*.json` filenames. */
function routeNamespace(href: string): string {
  return href === "/" ? "home" : href.slice(1).split("/")[0];
}

/** Turns `/use-cases` into "Use cases" when a page has no `meta.title` yet. */
function titleCaseFromRoute(href: string): string {
  const slug = href === "/" ? "home" : href.slice(1);
  const words = slug.split(/[-/]/).filter(Boolean);
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Curated Markdown for LLM crawlers and answer engines at `/llms.txt`
 * (see https://llmstxt.org). Every page and post listed here is read live
 * from `staticRoutes` / `src/lib/blog.ts` — nothing below is hand-maintained,
 * so the file can never drift out of date with the actual site.
 */
export async function GET() {
  const messages = (await loadMessages(defaultLocale)) as MessageTree;
  const posts = await getAllPosts(defaultLocale);

  const intro =
    readString(messages, ["home", "meta", "description"]) ??
    readString(messages, ["common", "defaultDescription"]) ??
    siteConfig.name;

  const pageLines = staticRoutes.map((route) => {
    const namespace = routeNamespace(route.href);
    const title =
      readString(messages, [namespace, "meta", "title"]) ??
      titleCaseFromRoute(route.href);
    const description = readString(messages, [
      namespace,
      "meta",
      "description",
    ]);
    const url = absoluteUrl(defaultLocale, route.href);
    return description
      ? `- [${title}](${url}): ${description}`
      : `- [${title}](${url})`;
  });

  const postLines = posts.map((post) => {
    const url = absoluteUrl(defaultLocale, `/blog/${post.slug}`);
    return `- [${post.frontmatter.title}](${url}): ${post.frontmatter.description}`;
  });

  const body = [
    `# ${siteConfig.name}`,
    "",
    intro,
    "",
    "## Pages",
    "",
    ...pageLines,
    "",
    "## Blog",
    "",
    ...(postLines.length > 0 ? postLines : ["- (no posts published yet)"]),
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

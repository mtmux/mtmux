import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";

/**
 * Inline links inside translated copy.
 *
 * Marketing pages had **zero** contextual links to the blog — sixteen posts
 * that only the listing page and the footer pointed at, which is a crawler
 * telling itself the posts do not matter. Fixing that needed no new machinery:
 * `t.rich()` was already in use across a dozen components, and the only thing
 * missing was a shared handler so every one of those links does not re-declare
 * the same four utility classes.
 *
 * The href is passed at the **call site**, deliberately. It keeps URLs out of
 * `messages/` (a URL is not copy to translate), and it keeps them as literal
 * strings inside component source, which is the only reason
 * `src/lib/link-graph.ts` can see a marketing → blog edge at build time.
 */
export const inlineLinkClassName =
  "text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

/** A `t.rich()` handler that wraps its chunks in a locale-aware internal link. */
export function inlineLink(href: string) {
  return function InlineLink(chunks: ReactNode) {
    return (
      <Link href={href} className={inlineLinkClassName}>
        {chunks}
      </Link>
    );
  };
}

/**
 * Every rich-text tag name used anywhere in `messages/`.
 *
 * ⚠️ Add a new tag to a message file and it MUST be added here too. Any page
 * that feeds its copy to JSON-LD runs it through `stripRichTags` first, and a
 * tag this list does not know about ships as literal `<post>` markup inside
 * FAQPage structured data — invalid, and quoted verbatim by whatever reads it.
 *
 * This lived as three near-identical local regexes (`/faq`, `/agents`, home)
 * before it lived here, which is exactly how the next one would have been
 * forgotten.
 */
export const RICH_TAGS = [
  "cmd",
  "code",
  "link",
  "post",
  "mailLink",
  "docsLink",
  "discussions",
  "email",
  "accent",
  "path",
  // These four were live handlers in `privacy`, `pricing`, `changelog` and
  // `security` that never made it into this list — the exact drift the warning
  // above predicts. `src/lib/messages.seo.test.ts` now walks every message file
  // and fails on a tag this array does not know, so the warning has teeth.
  "changelogLink",
  "planLink",
  "ghLink",
  "repoLink",
] as const;

const RICH_TAG_PATTERN = new RegExp(`</?(?:${RICH_TAGS.join("|")})>`, "g");

/** Renders translated copy as plain text, for structured data. */
export function stripRichTags(text: string): string {
  return text.replace(RICH_TAG_PATTERN, "").replace(/'(<[^']+>)'/g, "$1");
}

/** The same, for an absolute URL on another origin — docs.mtmux.com, a citation. */
export function externalLink(href: string) {
  return function ExternalLink(chunks: ReactNode) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={inlineLinkClassName}
      >
        {chunks}
      </a>
    );
  };
}

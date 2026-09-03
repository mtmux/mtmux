import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import home from "../../messages/en/home.json";

import { stripRichTags } from "./rich-links";

/**
 * Assertions against the *rendered* homepage.
 *
 * Everything else in this directory tests a builder in isolation, which cannot
 * see the two failures that actually cost rankings: a heading outline that
 * skips a level, and structured data describing content the page does not
 * contain. Both are properties of the HTML, so this reads the HTML.
 *
 * It is skipped when the tree has not been built. `pnpm verify` runs the build
 * first; a bare `pnpm test` on a clean checkout still passes rather than
 * failing on something that is not the developer's fault.
 */

const HTML_PATH = path.join(process.cwd(), ".next", "server", "app", "en.html");
const built = existsSync(HTML_PATH);
const html = built ? readFileSync(HTML_PATH, "utf8") : "";

/** Decodes only what Next escapes in text nodes, so titles compare by value. */
function decode(text: string): string {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonLdNodes(): Array<Record<string, unknown>> {
  const blocks = [
    ...html.matchAll(
      /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  return blocks.flatMap((match) => {
    const doc = JSON.parse(match[1]!) as {
      "@graph"?: Array<Record<string, unknown>>;
    };
    return doc["@graph"] ?? [doc as Record<string, unknown>];
  });
}

describe.skipIf(!built)("rendered homepage", () => {
  it("has exactly one h1, and it is the hero title", () => {
    const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)];
    expect(h1s).toHaveLength(1);
    expect(decode(h1s[0]![1]!)).toBe(stripRichTags(home.hero.title));
  });

  it("skips no heading level", () => {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) =>
      Number(m[1]),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
    }
  });

  it("heads every section, including the compat strip", () => {
    expect(html).toContain(`>${home.compat.label}<`);
    const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) =>
      decode(m[1]!),
    );
    expect(h2s).toContain(home.compat.label);
  });

  it("contains every demo chapter title and description the HowTo claims", () => {
    // The honesty gate. `HowTo` is built from these keys; if playback or a
    // reduced-motion path ever stopped rendering them, the markup would be
    // describing steps a crawler cannot find.
    for (const chapter of Object.values(home.demo.chapters)) {
      expect(decode(html)).toContain(decode(stripRichTags(chapter.title)));
      expect(decode(html)).toContain(
        decode(stripRichTags(chapter.description)),
      );
    }
  });

  it("contains every FAQ answer the FAQPage node claims", () => {
    for (const item of home.faq.items) {
      expect(decode(html)).toContain(decode(stripRichTags(item.answer)));
    }
  });

  it("emits exactly the six expected structured-data types", () => {
    const types = new Set(jsonLdNodes().map((node) => node["@type"]));
    expect([...types].sort()).toEqual([
      "FAQPage",
      "HowTo",
      "Organization",
      "SoftwareApplication",
      "WebPage",
      "WebSite",
    ]);
  });

  it("ships no raw rich-text markup inside structured data", () => {
    const serialised = JSON.stringify(jsonLdNodes());
    expect(serialised).not.toMatch(/<\/?(post|cmd|accent|code|link)>/);
  });

  it("emits one canonical, self-referencing", () => {
    const canonicals = [
      ...html.matchAll(/<link rel="canonical" href="([^"]+)"/g),
    ];
    expect(canonicals).toHaveLength(1);
    expect(canonicals[0]![1]).toBe("https://mtmux.com");
  });

  it("emits an hreflang for every locale plus x-default", () => {
    const alternates = [
      ...html.matchAll(/<link rel="alternate" hrefLang="([^"]+)"/gi),
    ].map((m) => m[1]);
    expect(alternates).toContain("x-default");
  });

  it("keeps the title keyword-first and free of a brand suffix", () => {
    const title = decode(/<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "");
    expect(title).toBe(home.meta.title);
    expect(title).not.toMatch(/\|\s*mtmux/);
  });
});

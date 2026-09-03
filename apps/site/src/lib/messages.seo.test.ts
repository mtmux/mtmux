import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RICH_TAGS } from "./rich-links";

/**
 * Message-file invariants, checked across every namespace at once.
 *
 * `buildMetadata` throws on an over-long description, but only for a page that
 * is actually built, and it can say nothing at all about the two rules that
 * matter most across the whole site: that no two pages claim the same
 * `<title>` (which is how a site cannibalises itself), and that every rich tag
 * used in copy is one `stripRichTags` knows how to remove. The second was
 * enforced by a comment in `rich-links.tsx` and nothing else — and the failure
 * mode is `<post>` shipping as literal markup inside FAQPage JSON-LD.
 */

const MESSAGES_DIR = path.join(process.cwd(), "messages", "en");
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 155;

type Json = unknown;

const files = readdirSync(MESSAGES_DIR).filter((name) =>
  name.endsWith(".json"),
);

const namespaces = files.map((name) => ({
  namespace: path.basename(name, ".json"),
  json: JSON.parse(readFileSync(path.join(MESSAGES_DIR, name), "utf8")) as Json,
}));

function metaOf(json: Json): { title?: string; description?: string } {
  if (typeof json !== "object" || json === null) return {};
  const meta = (json as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return {};
  return meta as { title?: string; description?: string };
}

/** Every string anywhere in a message tree, with its dotted key path. */
function walk(json: Json, prefix = ""): Array<[string, string]> {
  if (typeof json === "string") return [[prefix, json]];
  if (Array.isArray(json))
    return json.flatMap((item, i) => walk(item, `${prefix}[${i}]`));
  if (typeof json === "object" && json !== null)
    return Object.entries(json).flatMap(([key, value]) =>
      walk(value, prefix ? `${prefix}.${key}` : key),
    );
  return [];
}

describe("message files", () => {
  it("found the namespaces to check", () => {
    expect(namespaces.length).toBeGreaterThan(5);
  });

  describe.each(namespaces)("$namespace", ({ json }) => {
    const meta = metaOf(json);

    it.skipIf(!meta.title)("has a title of at most 60 characters", () => {
      expect(meta.title!.length).toBeLessThanOrEqual(MAX_TITLE);
    });

    it.skipIf(!meta.title)("does not append a brand suffix", () => {
      // Titles are keyword-first by house rule; brand attribution lives in
      // og:site_name and the Organization node.
      expect(meta.title!).not.toMatch(/[|·—-]\s*mtmux\s*$/i);
    });

    it.skipIf(!meta.description)(
      "has a description of at most 155 characters",
      () => {
        expect(meta.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION);
      },
    );
  });

  it("gives every namespace a distinct meta.title", () => {
    // Two pages sharing a title is the cannibalisation alarm: they compete for
    // the same query and Google picks one, usually not the one you wanted.
    const titles = namespaces
      .map(({ namespace, json }) => ({ namespace, title: metaOf(json).title }))
      .filter((entry): entry is { namespace: string; title: string } =>
        Boolean(entry.title),
      );

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const { namespace, title } of titles) {
      const key = title.toLowerCase();
      const previous = seen.get(key);
      if (previous) collisions.push(`${previous} and ${namespace}: "${title}"`);
      else seen.set(key, namespace);
    }
    expect(collisions).toEqual([]);
  });

  it("uses only rich tags stripRichTags knows about", () => {
    const known = new Set<string>(RICH_TAGS);
    const unknown: string[] = [];

    for (const { namespace, json } of namespaces) {
      for (const [key, value] of walk(json)) {
        for (const match of value.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)>/g)) {
          if (!known.has(match[1]!))
            unknown.push(`${namespace}.${key}: <${match[1]}>`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });

  it("balances every rich tag it opens", () => {
    const unbalanced: string[] = [];
    for (const { namespace, json } of namespaces) {
      for (const [key, value] of walk(json)) {
        for (const tag of RICH_TAGS) {
          const open = value.split(`<${tag}>`).length - 1;
          const close = value.split(`</${tag}>`).length - 1;
          if (open !== close) unbalanced.push(`${namespace}.${key}: <${tag}>`);
        }
      }
    }
    expect(unbalanced).toEqual([]);
  });
});

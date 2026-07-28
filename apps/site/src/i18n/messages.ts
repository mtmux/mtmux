import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultLocale } from "./locales";

const MESSAGES_ROOT = path.join(process.cwd(), "messages");

type MessageTree = Record<string, unknown>;

async function readNamespaceDir(locale: string): Promise<MessageTree | null> {
  const dir = path.join(MESSAGES_ROOT, locale);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  const entries = await Promise.all(
    files.map(async (file) => {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      return [
        path.basename(file, ".json"),
        JSON.parse(raw) as unknown,
      ] as const;
    }),
  );

  return Object.fromEntries(entries);
}

/**
 * Deep-merges `overrides` onto `base`. Used so a partially translated locale
 * transparently falls back to English for any key it has not covered yet,
 * instead of rendering a raw key or throwing.
 */
function deepMerge(base: MessageTree, overrides: MessageTree): MessageTree {
  const result: MessageTree = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(existing as MessageTree, value as MessageTree);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Loads every namespace file under `messages/<locale>/`.
 *
 * One JSON file per namespace keeps page copy modular: adding a page means
 * adding a file, and two people (or two agents) can never collide on a single
 * monolithic translation blob.
 */
export async function loadMessages(locale: string): Promise<MessageTree> {
  const fallback = (await readNamespaceDir(defaultLocale)) ?? {};
  if (locale === defaultLocale) return fallback;

  const translated = await readNamespaceDir(locale);
  if (!translated) return fallback;

  return deepMerge(fallback, translated);
}

/**
 * The locale registry.
 *
 * ── Adding a language is a three-step change ──────────────────────────────
 *   1. Copy `messages/en.json` to `messages/<code>.json` and translate it.
 *   2. Add an entry to `locales` below.
 *   3. (Optional) add translated posts under `content/blog/<code>/`.
 *
 * Everything else — routing, hreflang alternates, the sitemap, the locale
 * switcher, OG locale tags, RSS feeds, static generation — reads this array
 * and updates itself. Nothing else in the codebase hardcodes a locale.
 *
 * See `.claude/skills/add-language/SKILL.md` for the full checklist.
 */

export type LocaleDefinition = {
  /** URL segment and `lang` attribute. Use a BCP-47 tag. */
  code: string;
  /** Name of the language written in that language — never translated. */
  label: string;
  /** English name, used for `aria-label`s and admin surfaces. */
  englishLabel: string;
  /** Underscored locale for Open Graph `og:locale`. */
  ogLocale: string;
  /** Text direction. Components use CSS logical properties, so RTL works. */
  dir: "ltr" | "rtl";
  /** Region hint shown in the switcher. */
  region: string;
};

export const locales = [
  {
    code: "en",
    label: "English",
    englishLabel: "English",
    ogLocale: "en_US",
    dir: "ltr",
    region: "Global",
  },
] as const satisfies ReadonlyArray<LocaleDefinition>;

export type Locale = (typeof locales)[number]["code"];

export const localeCodes = locales.map((l) => l.code) as unknown as [
  Locale,
  ...Locale[],
];

export const defaultLocale: Locale = "en";

export function getLocaleDefinition(code: string): LocaleDefinition {
  return locales.find((l) => l.code === code) ?? locales[0];
}

export function isRtl(code: string): boolean {
  return getLocaleDefinition(code).dir === "rtl";
}

/** True once a second language ships; the switcher hides itself until then. */
export const isMultilingual = locales.length > 1;

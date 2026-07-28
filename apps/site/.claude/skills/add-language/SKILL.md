---
name: add-language
description: Add a new locale/language to the mtmux site — routing, translations, hreflang alternates, sitemap entries and the locale switcher. Use this whenever the user wants to translate the site, add a language, launch in a new market, support Spanish/German/Japanese/any locale, or asks how internationalisation works here. Also use it when a translation looks wrong or a locale is missing from the switcher.
---

# Add a language

The site is locale-agnostic by construction: routing, hreflang alternates, the sitemap, the OG
locale tags, the RSS feed, static generation and the switcher all read one array. Adding a
language is genuinely three steps, and step two is the only one that takes real work.

## Step 1 — register the locale

Edit `src/i18n/locales.ts` and add an entry to `locales`:

```ts
{
  code: "de",              // URL segment and the html lang attribute — a BCP-47 tag
  label: "Deutsch",        // written in that language, never translated
  englishLabel: "German",  // for aria-labels and admin surfaces
  ogLocale: "de_DE",       // Open Graph wants underscores
  dir: "ltr",              // "rtl" for Arabic, Hebrew, Farsi
  region: "Deutschland",   // shown as the subtitle in the switcher
}
```

That is the only code change. `defaultLocale` stays `en`, and `localePrefix: "as-needed"` means
English keeps the unprefixed root URLs while the new locale is served under `/de/…`. This matters
for a young domain: subdirectories keep every link and every crawl signal consolidated on one
host, where subdomains would split them.

The switcher hides itself while only one locale exists (`isMultilingual`), so it appears on its
own once you add the second.

## Step 2 — translate the messages

```bash
cp -r messages/en messages/de
```

Then translate the values inside `messages/de/*.json`, leaving every key untouched. One file per
namespace, named after the page or feature area, so two people can translate two pages without
touching the same file.

`src/i18n/messages.ts` deep-merges each locale over English. A key you have not translated yet
falls back to the English string instead of rendering a raw key or throwing — so shipping a
partial translation is safe, and you can translate the highest-traffic pages first.

Sensible order: `common`, `nav`, `footer`, `home`, then `agents` and `compare` (highest
commercial intent), then the rest.

### What must be translated, and what must not

Translate every human-readable string, including `alt` text, `aria-label`s and visually hidden
copy — those are read aloud by screen readers and indexed by search engines.

Do **not** translate:

- the install command `npm i -g mtmux`
- CLI commands, flags, config keys, file paths (`~/.mtmux/config.json`)
- terminal transcripts and code samples
- host names (`app.mtmux.com`, `api.mtmux.com`) and environment variables (`MTMUX_API_URL`)

Watch for ICU plurals and interpolation. `"{count, plural, =1 {One post} other {# posts}}"` needs
the plural categories that language actually uses — Polish and Russian have more than English,
and dropping one throws at render time rather than degrading quietly.

## Step 3 — translate content (optional, and worth being strategic about)

Blog posts live in `content/blog/<locale>/<slug>.mdx`. Keep the slug identical to the English
original so the hreflang alternates pair correctly.

You do not have to translate the whole blog, and usually should not. A locale with no translation
for a given post automatically falls back to the English original and shows a notice saying so,
so nothing 404s. Developers routinely search technical terms in English regardless of their
native language, so translating the marketing pages first and only the highest-intent posts
(the comparisons) is normally a better use of effort than translating a tmux reference nobody
searches for in translation.

## What updates itself

Nothing below needs touching — if you find yourself editing one of these to add a language,
something has been hardcoded and should be fixed instead:

- `src/middleware.ts` — locale detection and rewriting
- `src/app/sitemap.ts` — per-locale URLs with `xhtml:link` alternate annotations
- `src/lib/seo.ts` — canonical URL, bidirectional hreflang and `x-default`
- `src/components/site/locale-switcher.tsx` — appears once a second locale exists
- `generateStaticParams` across every route — each locale is prerendered
- `og:locale` and `og:locale:alternate` tags

## Verify

```bash
pnpm build
```

Check the build output lists the new locale for every route — `/de`, `/de/features`,
`/de/blog/...`. A route that only prerenders `/en` means a page is missing `setRequestLocale`
or its `generateStaticParams`.

Then confirm the SEO wiring, which is where multilingual sites usually break:

```bash
# Port 41999, not 41317 — PM2 already holds 41317 with the live site.
pnpm build && pnpm exec next start --port 41999
curl -s localhost:41999/de | grep -o '<link rel="alternate"[^>]*>'
```

You are looking for:

- a **self-referencing canonical** on each locale — pointing every locale at the English URL is
  the classic mistake that makes hreflang contradict canonical, and Google then ignores both
- **bidirectional** alternates — every locale lists every other locale, not just a link home
- **`x-default`** pointing at the unprefixed English root

## Right-to-left languages

Set `dir: "rtl"`. The components are built on logical CSS properties (`ms-*`, `pe-*`,
`border-s-*`, `text-start`) and shadcn was initialised with RTL support, so layout mirrors
without per-component work. Spot-check the header, the mobile drawer and the blog table of
contents, since those have the most positional styling.

import { describe, expect, it } from "vitest";

import { defaultLocale, locales } from "@/i18n/locales";

import { absoluteUrl, buildMetadata, languageAlternates } from "./seo";

/**
 * The metadata factory's contract.
 *
 * Every page and post on the site routes through `buildMetadata`, so the
 * properties asserted here are site-wide by construction. They were previously
 * enforced by a docblock and a build-time throw that only fires on the length
 * rule — everything else (canonical shape, hreflang completeness, the absent
 * brand suffix, `noindex, follow`) was convention with nothing holding it.
 */

const LOCALE = defaultLocale;

function meta(overrides: Partial<Parameters<typeof buildMetadata>[0]> = {}) {
  return buildMetadata({
    locale: LOCALE,
    path: "/features",
    title: "tmux in any browser",
    description: "A description well under the limit.",
    ...overrides,
  });
}

describe("buildMetadata", () => {
  it("throws when the description passes 155 characters", () => {
    expect(() => meta({ description: "x".repeat(156) })).toThrow(/155/);
  });

  it("accepts a description of exactly 155 characters", () => {
    expect(() => meta({ description: "x".repeat(155) })).not.toThrow();
  });

  it("names the offending path and locale in the throw", () => {
    expect(() =>
      meta({ path: "/pricing", description: "x".repeat(200) }),
    ).toThrow(/\/pricing/);
  });

  it("passes the title through verbatim, with no brand suffix", () => {
    const result = meta({ title: "tmux web client" });
    expect(result.title).toBe("tmux web client");
    expect(String(result.title)).not.toMatch(/\|\s*mtmux/);
  });

  it("emits an absolute, self-referencing canonical", () => {
    const result = meta({ path: "/security" });
    expect(result.alternates?.canonical).toBe(absoluteUrl(LOCALE, "/security"));
    expect(String(result.alternates?.canonical)).toMatch(
      /^https:\/\/mtmux\.com\//,
    );
  });

  it("gives the homepage a canonical with no trailing path", () => {
    expect(meta({ path: "/" }).alternates?.canonical).toBe("https://mtmux.com");
  });

  it("emits one hreflang per locale plus x-default", () => {
    const languages = meta().alternates?.languages ?? {};
    expect(Object.keys(languages)).toHaveLength(locales.length + 1);
    for (const locale of locales) {
      expect(languages[locale.code]).toBe(
        absoluteUrl(locale.code, "/features"),
      );
    }
    expect(languages["x-default"]).toBe(
      absoluteUrl(defaultLocale, "/features"),
    );
  });

  it("points x-default at the unprefixed default locale", () => {
    expect(languageAlternates("/")["x-default"]).toBe("https://mtmux.com");
  });

  it("defaults the OG image to the route's own generated card", () => {
    const images = meta({ path: "/security" }).openGraph?.images;
    expect(JSON.stringify(images)).toContain(
      "https://mtmux.com/security/opengraph-image",
    );
  });

  it("uses noindex, follow — never nofollow", () => {
    // Thin list pages set this. Their whole remaining value is the links out.
    expect(meta({ noindex: true }).robots).toEqual({
      index: false,
      follow: true,
    });
  });

  it("indexes by default", () => {
    const robots = meta().robots as { index: boolean; follow: boolean };
    expect(robots.index).toBe(true);
    expect(robots.follow).toBe(true);
  });
});

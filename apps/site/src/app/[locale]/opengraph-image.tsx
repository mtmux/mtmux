import { getTranslations } from "next-intl/server";
import { ImageResponse } from "next/og";

import { siteConfig } from "@/config/site";
import { locales } from "@/i18n/locales";
import {
  loadOgFonts,
  OG_COLORS,
  OG_FONT_DISPLAY,
  OG_FONT_MONO,
  OG_SAFE_PADDING,
  OG_SIZE,
  truncateTitle,
} from "@/lib/og";

export const alt = siteConfig.name;
export const size = OG_SIZE;
export const contentType = "image/png";
export const dynamic = "force-static";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale: locale.code }));
}

/** The two-pane split from `logo-mark.svg`, redrawn as flex boxes for Satori. */
function MarkGlyph() {
  return (
    <div
      style={{
        display: "flex",
        width: 72,
        height: 72,
        borderRadius: 16,
        backgroundColor: OG_COLORS.brand,
        padding: 10,
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "44%",
          height: "100%",
          borderRadius: 5,
          backgroundColor: OG_COLORS.brandContrast,
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "56%",
          height: "100%",
          gap: 6,
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 5,
            backgroundColor: OG_COLORS.brandContrast,
          }}
        />
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 5,
            backgroundColor: OG_COLORS.brandContrast,
            opacity: 0.45,
          }}
        />
      </div>
    </div>
  );
}

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const [t, fonts] = await Promise.all([
    // `home`, not `common`. This route renders the card for `/` — the only
    // page it serves — and reading `common.default*` meant every rewrite of the
    // homepage's own title and description silently failed to reach the share
    // card. `common.default*` is now what its name says: the fallback for the
    // documents that have no page metadata, `not-found` and `error`.
    getTranslations({ locale, namespace: "home" }),
    loadOgFonts(),
  ]);

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: OG_COLORS.surfaceBase,
        backgroundImage: `radial-gradient(ellipse 900px 560px at 18% 20%, ${OG_COLORS.brandGlow}, transparent 70%)`,
        padding: `${OG_SAFE_PADDING.y}px ${OG_SAFE_PADDING.x}px`,
      }}
    >
      {/* Header: mark + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <MarkGlyph />
        <span
          style={{
            fontFamily: OG_FONT_DISPLAY,
            fontSize: 34,
            fontWeight: 600,
            letterSpacing: -1.5,
            color: OG_COLORS.textStrong,
          }}
        >
          {siteConfig.name}
        </span>
      </div>

      {/* Tagline */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          marginTop: "auto",
          maxWidth: 900,
        }}
      >
        <h1
          style={{
            fontFamily: OG_FONT_DISPLAY,
            fontSize: 58,
            fontWeight: 600,
            lineHeight: 1.12,
            letterSpacing: -2,
            color: OG_COLORS.textStrong,
            margin: 0,
          }}
        >
          {truncateTitle(t("meta.title"))}
        </h1>
        <p
          style={{
            fontFamily: OG_FONT_MONO,
            fontSize: 24,
            fontWeight: 400,
            lineHeight: 1.5,
            color: OG_COLORS.textMuted,
            marginTop: 22,
            marginBottom: 0,
            maxWidth: 820,
          }}
        >
          {t("meta.description")}
        </p>
      </div>

      {/* Terminal chip: npm i -g mtmux */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: 44,
          padding: "18px 26px",
          borderRadius: 14,
          border: `1px solid ${OG_COLORS.line}`,
          backgroundColor: OG_COLORS.surfaceSunken,
          boxShadow: `0 0 0 1px ${OG_COLORS.brandGlowSoft}, 0 24px 60px -24px ${OG_COLORS.brandGlow}`,
        }}
      >
        <span aria-hidden="true" style={{ display: "flex", gap: 8 }}>
          <span
            style={{
              display: "flex",
              width: 12,
              height: 12,
              borderRadius: 999,
              backgroundColor: OG_COLORS.signalFailed,
            }}
          />
          <span
            style={{
              display: "flex",
              width: 12,
              height: 12,
              borderRadius: 999,
              backgroundColor: OG_COLORS.signalBlocked,
            }}
          />
          <span
            style={{
              display: "flex",
              width: 12,
              height: 12,
              borderRadius: 999,
              backgroundColor: OG_COLORS.signalDone,
            }}
          />
        </span>
        <span
          style={{
            display: "flex",
            fontFamily: OG_FONT_MONO,
            fontSize: 26,
            color: OG_COLORS.brand,
          }}
        >
          $
        </span>
        <span
          style={{
            display: "flex",
            fontFamily: OG_FONT_MONO,
            fontSize: 26,
            color: OG_COLORS.textStrong,
          }}
        >
          {siteConfig.install}
        </span>
      </div>
    </div>,
    { ...size, fonts },
  );
}

import { getTranslations } from "next-intl/server";
import { ImageResponse } from "next/og";

import { getAuthor } from "@/config/authors";
import { siteConfig } from "@/config/site";
import { locales } from "@/i18n/locales";
import { getAllSlugs, getPost } from "@/lib/blog";
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

export async function generateStaticParams() {
  const params: Array<{ locale: string; slug: string }> = [];
  for (const locale of locales) {
    for (const slug of await getAllSlugs(locale.code)) {
      params.push({ locale: locale.code, slug });
    }
  }
  return params;
}

/** The two-pane split from `logo-mark.svg`, redrawn as flex boxes for Satori. */
function MarkGlyph({ size: dim = 48 }: { size?: number }) {
  return (
    <div
      style={{
        display: "flex",
        width: dim,
        height: dim,
        borderRadius: dim * 0.22,
        backgroundColor: OG_COLORS.brand,
        padding: dim * 0.14,
        gap: dim * 0.08,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "44%",
          height: "100%",
          borderRadius: 4,
          backgroundColor: OG_COLORS.brandContrast,
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "56%",
          height: "100%",
          gap: dim * 0.08,
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 4,
            backgroundColor: OG_COLORS.brandContrast,
          }}
        />
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "47%",
            borderRadius: 4,
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
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const [post, t, fonts] = await Promise.all([
    getPost(locale, slug),
    getTranslations({ locale, namespace: "blog" }),
    loadOgFonts(),
  ]);

  // A static param can outlive its source file between builds; render a
  // generic brand card instead of throwing so a stale request never 500s.
  const title = post ? truncateTitle(post.frontmatter.title) : siteConfig.name;
  const category = post
    ? t(`categories.${post.frontmatter.category}`)
    : undefined;
  const author = post ? getAuthor(post.frontmatter.author) : undefined;
  const date = post?.frontmatter.date;

  return new ImageResponse(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        backgroundColor: OG_COLORS.surfaceBase,
        backgroundImage: `radial-gradient(ellipse 900px 560px at 82% 12%, ${OG_COLORS.brandGlow}, transparent 70%)`,
        padding: `${OG_SAFE_PADDING.y}px ${OG_SAFE_PADDING.x}px`,
      }}
    >
      {/* Header: mark + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <MarkGlyph size={44} />
        <span
          style={{
            fontFamily: OG_FONT_DISPLAY,
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: -1,
            color: OG_COLORS.textStrong,
          }}
        >
          {siteConfig.name}
        </span>
      </div>

      {category ? (
        <span
          style={{
            display: "flex",
            fontFamily: OG_FONT_MONO,
            fontSize: 20,
            fontWeight: 500,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: OG_COLORS.brand,
            marginTop: 46,
          }}
        >
          {category}
        </span>
      ) : null}

      {/* Post title */}
      <h1
        style={{
          fontFamily: OG_FONT_DISPLAY,
          fontSize: 54,
          fontWeight: 600,
          lineHeight: 1.14,
          letterSpacing: -1.5,
          color: OG_COLORS.textStrong,
          marginTop: 18,
          marginBottom: 0,
          maxWidth: 980,
        }}
      >
        {title}
      </h1>

      {/* Footer: author + date */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          marginTop: "auto",
          paddingTop: 28,
          borderTop: `1px solid ${OG_COLORS.line}`,
          fontFamily: OG_FONT_MONO,
          fontSize: 22,
          color: OG_COLORS.textMuted,
        }}
      >
        {author ? (
          <span style={{ display: "flex", color: OG_COLORS.textStrong }}>
            {author.name}
          </span>
        ) : null}
        {author && date ? <span style={{ display: "flex" }}>·</span> : null}
        {date ? <span style={{ display: "flex" }}>{date}</span> : null}
      </div>
    </div>,
    { ...size, fonts },
  );
}

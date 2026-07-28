import type { Metadata, Viewport } from "next";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { IBM_Plex_Mono, IBM_Plex_Sans, Martian_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { SkipLink } from "@/components/site/skip-link";
import { siteConfig } from "@/config/site";
import { getLocaleDefinition, type Locale } from "@/i18n/locales";
import { routing } from "@/i18n/routing";
import {
  graph,
  organizationSchema,
  websiteSchema,
} from "@/lib/structured-data";

import "../globals.css";

/* Display face: geometric monospace, used only for headings. */
const martianMono = Martian_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-martian-mono",
  display: "swap",
});

/* Reading face: prose, UI labels, everything long-form. */
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-sans",
  display: "swap",
});

/* Terminal face: code, shell output, keycaps. */
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const viewport: Viewport = {
  // The site ships dark-only, so there is one theme colour and one scheme.
  themeColor: "#0a0b0a",
  colorScheme: "dark",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "common" });

  return {
    metadataBase: new URL(siteConfig.url),
    applicationName: siteConfig.name,
    generator: undefined,
    referrer: "origin-when-cross-origin",
    creator: siteConfig.name,
    publisher: siteConfig.name,
    formatDetection: { telephone: false, address: false, email: false },
    icons: {
      icon: [
        { url: "/favicon.svg", type: "image/svg+xml" },
        { url: "/favicon.ico", sizes: "any" },
      ],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      title: siteConfig.name,
      statusBarStyle: "black-translucent",
    },
    other: {
      "msapplication-TileColor": "#0a0b0a",
    },
    title: {
      // Sub-pages set their own absolute titles; this is the fallback only.
      default: t("defaultTitle"),
      template: "%s",
    },
    description: t("defaultDescription"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  // Opts this subtree into static rendering.
  setRequestLocale(locale);

  const definition = getLocaleDefinition(locale);
  const t = await getTranslations({ locale, namespace: "common" });

  return (
    // The site ships dark-only. The `dark` class is fixed here rather than
    // toggled at runtime, so shadcn's `dark:` variants still resolve.
    <html
      lang={locale}
      dir={definition.dir}
      className={`dark ${martianMono.variable} ${plexSans.variable} ${plexMono.variable}`}
    >
      <head>
        <JsonLd
          json={graph(organizationSchema(), websiteSchema(locale as Locale))}
        />
      </head>
      {/*
        Browser extensions commonly stamp attributes onto <body> before React
        hydrates (password managers, ad blockers, shopping helpers), which React
        reports as a hydration mismatch even though the markup we render is
        identical. Suppressing it here covers that one element only — it does
        not hide genuine mismatches in the tree below.
      */}
      <body
        suppressHydrationWarning
        className="min-h-dvh bg-surface-base text-text antialiased"
      >
        <NextIntlClientProvider>
          <SkipLink label={t("skipToContent")} />
          <div className="relative flex min-h-dvh flex-col">
            <SiteHeader />
            <main id="content" className="flex-1">
              {children}
            </main>
            <SiteFooter />
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { ChangelogHero } from "@/components/sections/changelog/hero";
import { ChangelogTimeline } from "@/components/sections/changelog/timeline";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "changelog" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/changelog",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function ChangelogPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "changelog" });

  const schema = graph(
    breadcrumbSchema(locale as Locale, [
      { name: t("breadcrumb.home"), href: "/" },
      { name: t("breadcrumb.current"), href: "/changelog" },
    ]),
  );

  return (
    <>
      <JsonLd json={schema} />
      <ChangelogHero />
      <ChangelogTimeline />
    </>
  );
}

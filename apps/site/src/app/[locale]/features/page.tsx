import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { Section } from "@/components/primitives/section";
import { ClosingCta } from "@/components/sections/closing-cta";
import { FeaturesHero } from "@/components/sections/features/hero";
import { FeaturesInput } from "@/components/sections/features/input";
import { FeaturesReflow } from "@/components/sections/features/reflow";
import { FeaturesRest } from "@/components/sections/features/rest";
import { FeaturesStats } from "@/components/sections/features/stats";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "features" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/features",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function FeaturesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "features" });

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.current"), href: "/features" },
          ]),
        )}
      />
      <FeaturesHero />
      <Section bordered={false}>
        <FeaturesInput />
      </Section>
      <Section tone="raised">
        <FeaturesReflow />
      </Section>
      <Section>
        <FeaturesRest />
      </Section>
      <Section tone="raised">
        <FeaturesStats />
      </Section>
      <ClosingCta namespace="features.cta" />
    </>
  );
}

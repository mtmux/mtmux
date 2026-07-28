import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { Section } from "@/components/primitives/section";
import { ClosingCta } from "@/components/sections/closing-cta";
import { UseCasesHero } from "@/components/sections/use-cases/hero";
import { UseCasesScenarios } from "@/components/sections/use-cases/scenarios";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import { breadcrumbSchema, graph } from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "use-cases" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/use-cases",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function UseCasesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "use-cases" });

  return (
    <>
      <JsonLd
        json={graph(
          breadcrumbSchema(locale as Locale, [
            { name: t("breadcrumb.home"), href: "/" },
            { name: t("breadcrumb.current"), href: "/use-cases" },
          ]),
        )}
      />
      <UseCasesHero />
      <Section bordered={false}>
        <UseCasesScenarios />
      </Section>
      <ClosingCta namespace="use-cases.cta" tone="raised" />
    </>
  );
}

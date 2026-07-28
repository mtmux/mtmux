import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { JsonLd } from "@/components/json-ld";
import { ClosingCta } from "@/components/sections/closing-cta";
import { Agents } from "@/components/sections/home/agents";
import { CompatStrip } from "@/components/sections/home/compat-strip";
import { Faq } from "@/components/sections/home/faq";
import { Fidelity } from "@/components/sections/home/fidelity";
import { HomeHero } from "@/components/sections/home/hero";
import { HowItWorks } from "@/components/sections/home/how-it-works";
import { PricingTeaser } from "@/components/sections/home/pricing-teaser";
import { Security } from "@/components/sections/home/security";
import type { Locale } from "@/i18n/locales";
import { buildMetadata } from "@/lib/seo";
import {
  faqSchema,
  graph,
  softwareApplicationSchema,
} from "@/lib/structured-data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "home" });

  return buildMetadata({
    locale: locale as Locale,
    path: "/",
    title: t("meta.title"),
    description: t("meta.description"),
  });
}

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "home" });
  const faqItems = t.raw("faq.items") as Array<{
    question: string;
    answer: string;
  }>;

  return (
    <>
      <JsonLd
        json={graph(
          softwareApplicationSchema(t("meta.description")),
          faqSchema(faqItems),
        )}
      />
      <HomeHero />
      <CompatStrip />
      <HowItWorks />
      <Fidelity />
      <Agents />
      <Security />
      <PricingTeaser />
      <Faq />
      <ClosingCta namespace="home.cta" showDocsLink />
    </>
  );
}

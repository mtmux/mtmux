import { getTranslations } from "next-intl/server";

import { HairlineCell, HairlineGrid } from "@/components/primitives/cards";
import { SectionHeading, Section } from "@/components/primitives/section";
import { Link } from "@/i18n/navigation";

type BillingFaqItem = { question: string; answer: string };

export async function PricingBillingFaq() {
  const t = await getTranslations("pricing.billingFaq");
  const items = t.raw("items") as BillingFaqItem[];

  return (
    <Section>
      <SectionHeading title={t("title")} level={2} size="sm" />
      <HairlineGrid minColumnWidth="20rem" className="mt-8 sm:mt-10">
        {items.map((item) => (
          <HairlineCell key={item.question}>
            <p className="mb-2 text-[0.9375rem] text-text-strong">
              {item.question}
            </p>
            <p className="text-[0.8125rem] leading-[1.7] text-text-muted">
              {item.answer}
            </p>
          </HairlineCell>
        ))}
      </HairlineGrid>
      <div className="mt-8 text-center">
        <Link
          href="/faq"
          className="text-[0.9063rem] text-brand underline decoration-brand/40 underline-offset-3 hover:decoration-brand"
        >
          {t("moreLink")} →
        </Link>
      </div>
    </Section>
  );
}

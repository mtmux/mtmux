import { getTranslations } from "next-intl/server";

import { Section, SectionHeading } from "@/components/primitives/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Link } from "@/i18n/navigation";

type FaqItem = { question: string; answer: string };

export async function Faq() {
  const t = await getTranslations("home.faq");
  const items = t.raw("items") as FaqItem[];

  return (
    <Section tone="raised">
      <div className="mx-auto max-w-[46rem]">
        <SectionHeading
          eyebrow={t("eyebrow")}
          title={t("title")}
          level={2}
          size="sm"
          className="mb-8 max-w-none sm:mb-11"
        />

        <Accordion defaultValue={[0]} className="border-t border-line-subtle">
          {items.map((item, index) => (
            <AccordionItem
              key={item.question}
              value={index}
              className="border-line-subtle"
            >
              <AccordionTrigger className="gap-3.5 py-4.5 font-mono text-[0.96875rem] text-text-strong hover:no-underline hover:text-brand">
                <span
                  aria-hidden="true"
                  className="text-[0.78125rem] text-brand"
                >
                  ▸
                </span>
                <span className="flex-1">{item.question}</span>
              </AccordionTrigger>
              <AccordionContent>
                <p className="max-w-[66ch] ps-7.5 text-[0.90625rem] leading-[1.8] text-text-muted">
                  {item.answer}
                </p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>

        <div className="mt-5.5">
          <Link
            href="/faq"
            className="text-[0.90625rem] text-brand underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
          >
            {t("moreLink")} →
          </Link>
        </div>
      </div>
    </Section>
  );
}

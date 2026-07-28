import { getTranslations } from "next-intl/server";

import { SectionHeading } from "@/components/primitives/section";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export type FaqItem = {
  question: string;
  answer: string;
};

/** Reads the FAQ entries so the page can build matching `faqSchema` JSON-LD. */
export async function getAgentsFaqItems(): Promise<FaqItem[]> {
  const t = await getTranslations("agents.faq");
  return t.raw("items") as FaqItem[];
}

export async function AgentFaq({ items }: { items: FaqItem[] }) {
  const t = await getTranslations("agents.faq");

  return (
    <section className="border-t border-line-subtle">
      <div className="container-content max-w-3xl py-(--spacing-section)">
        <SectionHeading
          eyebrow={t("eyebrow")}
          eyebrowTone="agent"
          title={t("title")}
        />
        <Accordion className="mt-8" multiple>
          {items.map((item, index) => (
            <AccordionItem key={item.question} value={`faq-${index}`}>
              <AccordionTrigger className="py-4 text-[0.9375rem] font-600 text-text-strong">
                {item.question}
              </AccordionTrigger>
              <AccordionContent className="text-[0.9375rem] leading-[1.7] text-text-muted">
                {item.answer}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

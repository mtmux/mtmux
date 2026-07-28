import { getTranslations } from "next-intl/server";

import { Cmd, HairlineGrid, StepCard } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";

type Step = { title: string; body: string };

/**
 * The four steps of running an agent and checking on it.
 *
 * Steps one, two and four are things tmux already does — which is the point.
 * mtmux only appears at step three, and saying so is what makes the rest of
 * the page believable.
 */
export async function AgentWorkflow() {
  const t = await getTranslations("agents.workflow");
  const steps = t.raw("steps") as Step[];

  return (
    <Section bordered={false} innerClassName="pt-0">
      <SectionHeading
        title={t("title")}
        description={t("description")}
        level={2}
        size="sm"
        className="mb-8 sm:mb-10"
      />
      <HairlineGrid minColumnWidth="15.5rem">
        {steps.map((step, index) => (
          <StepCard key={step.title} index={index + 1} title={step.title}>
            {t.rich(`steps.${index}.body`, {
              cmd: (chunks) => <Cmd>{chunks}</Cmd>,
            })}
          </StepCard>
        ))}
      </HairlineGrid>
    </Section>
  );
}

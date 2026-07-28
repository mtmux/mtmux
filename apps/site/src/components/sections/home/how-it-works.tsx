import { getTranslations } from "next-intl/server";

import { HairlineGrid, StepCard } from "@/components/primitives/cards";
import { Section, SectionHeading } from "@/components/primitives/section";
import {
  Cursor,
  Line,
  Prompt,
  Tok,
  TerminalWindow,
} from "@/components/primitives/terminal";
import { siteConfig } from "@/config/site";

/**
 * The per-step commands and the `mtmux` transcript are literal CLI output, not
 * prose — home.json only supplies the step titles, descriptions and the
 * terminal window title, so the command text is authored here.
 *
 * The transcript mirrors what `apps/cli/src/banner.ts` actually prints: the
 * brand line, the scan prompt, the host and the grouped six-digit code, then
 * the local and network addresses. Keep it in step with that file — a banner
 * nobody recognises when they run the thing is worse than no banner at all.
 */
export async function HowItWorks() {
  const t = await getTranslations("home.howItWorks");

  return (
    <Section tone="base">
      <SectionHeading
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        level={2}
        size="md"
        className="mb-10 sm:mb-14"
      />

      <HairlineGrid minColumnWidth="16.75rem">
        <StepCard
          index={1}
          title={t("steps.start.title")}
          footer={
            <div className="rounded-md border border-line-subtle bg-surface-sunken px-3 py-2.5 font-mono text-[0.8125rem] text-text">
              <Prompt />
              mtmux
            </div>
          }
        >
          {t("steps.start.description")}
        </StepCard>
        <StepCard
          index={2}
          title={t("steps.scan.title")}
          footer={
            <div className="rounded-md border border-line-subtle bg-surface-sunken px-3 py-2.5 font-mono text-[0.8125rem] text-text">
              <Tok kind="path">{siteConfig.appHost}</Tok> ·{" "}
              <Tok kind="flag">48 29 13</Tok>
            </div>
          }
        >
          {t("steps.scan.description")}
        </StepCard>
        <StepCard
          index={3}
          title={t("steps.attach.title")}
          footer={
            <div className="rounded-md border border-line-subtle bg-surface-sunken px-3 py-2.5 font-mono text-[0.8125rem] text-text">
              <Prompt />
              mtmux status
            </div>
          }
        >
          {t("steps.attach.description")}
        </StepCard>
      </HairlineGrid>

      <TerminalWindow title={t("terminalTitle")} className="mt-6 sm:mt-9">
        <Line>
          <Prompt />
          mtmux
        </Line>
        <Line> </Line>
        <Line tone="faint">
          {"  ›  mtmux  "}
          {siteConfig.version}
        </Line>
        <Line> </Line>
        <Line tone="strong">{"  Scan to open your terminal"}</Line>
        <Line> </Line>
        <Line>
          {"  "}
          <Tok kind="comment">or go to&nbsp;&nbsp;</Tok>{" "}
          <Tok kind="path">{siteConfig.appHost}</Tok>
        </Line>
        <Line>
          {"  "}
          <Tok kind="comment">and enter&nbsp;</Tok>{" "}
          <Tok kind="flag">48 29 13</Tok>
        </Line>
        <Line> </Line>
        <Line>
          {"  "}
          <Tok kind="comment">Local&nbsp;&nbsp;&nbsp;</Tok>{" "}
          http://127.0.0.1:14100
        </Line>
        <Line>
          {"  "}
          <Tok kind="comment">Network&nbsp;</Tok> http://192.168.1.24:14100{" "}
          <Tok kind="comment">(en0)</Tok>
        </Line>
        <Line> </Line>
        <Line tone="faint">
          {"  Waiting for a device…   Ctrl+C to stop."}
          <Cursor />
        </Line>
      </TerminalWindow>
    </Section>
  );
}

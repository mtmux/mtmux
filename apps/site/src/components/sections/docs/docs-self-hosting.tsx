import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import {
  Line,
  Prompt,
  TerminalWindow,
  Tok,
} from "@/components/primitives/terminal";

/**
 * Two real escape hatches, in order of effort.
 *
 * `--local` needs nothing from us at all and is the one most people want.
 * Running the broker is the second, and it is a normal Node service in the
 * repo — there is no container image to license and none is implied here.
 */
export async function DocsSelfHosting() {
  const t = await getTranslations("docs.selfHosting");

  return (
    <section id="self-hosting">
      <h2 className="mb-5 text-[clamp(1.1875rem,2.35vw,1.6875rem)] leading-[1.06]">
        {t("title")}
      </h2>
      <p className="mb-5 max-w-[62ch] text-[0.9375rem] leading-[1.75] text-text-muted">
        {t.rich("prose", { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
      </p>
      <p className="mb-5 max-w-[62ch] text-[0.9375rem] leading-[1.75] text-text-muted">
        {t.rich("brokerProse", { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
      </p>
      <TerminalWindow title={t("filename")} chrome={false}>
        <Line tone="faint"># {t("localComment")}</Line>
        <Line>
          <Prompt />
          mtmux start <Tok kind="flag">--local</Tok>
        </Line>
        <Line> </Line>
        <Line tone="faint"># {t("runComment")}</Line>
        <Line>
          <Prompt />
          <Tok kind="keyword">MTMUX_API_URL</Tok>=
          <Tok kind="value">https://mtmux.internal</Tok> mtmux
        </Line>
        <Line> </Line>
        <Line tone="faint"># {t("buildComment")}</Line>
        <Line>
          <Prompt />
          <Tok kind="keyword">MTMUX_BUILD_API_URL</Tok>=
          <Tok kind="value">https://mtmux.internal</Tok> pnpm build
        </Line>
      </TerminalWindow>
    </section>
  );
}

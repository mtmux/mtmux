import { getTranslations } from "next-intl/server";

import { Cmd } from "@/components/primitives/cards";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Command syntax is code, not prose, so it stays out of the message catalogue.
 *
 * ⚠️ This array is **index-matched** against `docs.cli.descriptions` in
 * `messages/en/docs.json`. Row N here is described by entry N there. Reorder
 * one without the other and every description silently shifts by a row, which
 * the build will not catch. Add and remove in pairs.
 *
 * This is the complete surface of `apps/cli/src/bin.ts`. If a command is not
 * in that file, it does not belong in this table.
 */
const CLI_COMMANDS = [
  "mtmux",
  "mtmux start",
  "mtmux start --local",
  "mtmux start --no-qr",
  "mtmux start -n, --name <label>",
  "mtmux start -p, --port <n>",
  "mtmux start -h, --host <addr>",
  "mtmux start --no-open | --json",
  "mtmux local",
  "mtmux pair [code]",
  "mtmux status | stop",
  "mtmux doctor",
  "mtmux login | logout | whoami",
  "mtmux servers",
  "mtmux devices [revoke <id>]",
  "mtmux upgrade",
  "mtmux token print|rotate|set",
  "mtmux version",
] as const;

export async function DocsCliReference() {
  const t = await getTranslations("docs.cli");
  const descriptions = t.raw("descriptions") as string[];

  return (
    <section id="cli-reference">
      <h2 className="mb-5 text-[clamp(1.1875rem,2.35vw,1.6875rem)] leading-[1.06]">
        {t("title")}
      </h2>
      <div className="overflow-x-auto rounded-xl border border-line">
        <Table>
          <TableHeader>
            <TableRow className="border-line-subtle hover:bg-transparent">
              <TableHead className="font-mono text-[0.6875rem] tracking-[0.1em] text-text-faint uppercase">
                {t("columns.command")}
              </TableHead>
              <TableHead className="font-mono text-[0.6875rem] tracking-[0.1em] text-text-faint uppercase">
                {t("columns.description")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CLI_COMMANDS.map((command, index) => (
              <TableRow
                key={command}
                className="border-line-subtle hover:bg-surface-panel"
              >
                <TableCell className="font-mono text-[0.875rem] whitespace-nowrap text-text-strong">
                  {command}
                </TableCell>
                <TableCell className="text-[0.875rem] whitespace-normal text-text-muted">
                  {descriptions[index]}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-5 max-w-[62ch] text-[0.875rem] leading-[1.75] text-text-subtle">
        {t.rich("configNote", { cmd: (chunks) => <Cmd>{chunks}</Cmd> })}
      </p>
    </section>
  );
}

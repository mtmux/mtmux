import readline from "node:readline";
import kleur from "kleur";
import { formatSas } from "@repo/crypto";

/**
 * The prompt a browser's access request raises on this machine.
 *
 * This is the strongest gate in the product, and it is deliberately the only
 * pairing path that has one. The rule is: demand approval exactly when the
 * requester cannot be presumed present at the machine.
 *
 *   `mtmux start` code/QR  — no prompt. You ran the command, you are standing
 *                            there, the code is fresh and short-lived. A
 *                            keypress here is pure friction at the one moment
 *                            the product should feel magical.
 *   dashboard request      — prompt. Nobody is necessarily at the machine.
 *
 * The six digits are not a password and are not secret. They are a comparison:
 * the browser shows the same number, and the only way the two disagree is if
 * something sat in the middle of the exchange. So the question asked is
 * "do these match?", never "is this code correct?".
 */

/** Long enough to walk to the machine; short enough to not sit forever. */
const PROMPT_TIMEOUT_MS = 110_000;

export type AccessPromptInput = {
  sas: string;
  deviceLabel: string;
  accountEmail: string;
};

export type AccessPromptResult =
  | { approved: true }
  | { approved: false; reason: "refused" | "no-tty" };

export type PromptDeps = {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  timeoutMs?: number;
};

/**
 * Render the request. Exported so a test can assert what a human is shown
 * without driving a terminal.
 */
export function renderAccessRequest(req: AccessPromptInput): string[] {
  return [
    "",
    kleur.bold("  A browser wants to pair with this machine"),
    "",
    `    ${kleur.dim("Device ")}  ${req.deviceLabel || "unknown device"}`,
    `    ${kleur.dim("Account")}  ${req.accountEmail || "unknown account"}`,
    `    ${kleur.dim("Code   ")}  ${kleur.bold(formatSas(req.sas))}`,
    "",
  ];
}

/**
 * Ask, and return what the human said.
 *
 * No TTY means deny, never auto-approve. A machine running as a service has
 * nobody to ask, and "nobody objected" is not consent — it is the difference
 * between a gate and a formality. Such machines queue the request instead; see
 * `mtmux approve`.
 */
export async function promptForAccess(
  req: AccessPromptInput,
  deps: PromptDeps = {},
): Promise<AccessPromptResult> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;

  if (!input.isTTY) return { approved: false, reason: "no-tty" };

  for (const line of renderAccessRequest(req)) {
    output.write(`${line}\n`);
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(
        () => resolve(null),
        deps.timeoutMs ?? PROMPT_TIMEOUT_MS,
      );
      timer.unref?.();
      rl.question(
        kleur.bold("  Matches what your browser shows?") + " [y/N] ",
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      );
    });

    // Anything that is not an explicit yes — including a timeout, an empty
    // line, or EOF — is a no. Defaulting the other way would make walking away
    // from the keyboard an approval.
    const approved = /^y(es)?$/i.test((answer ?? "").trim());
    output.write(
      approved
        ? kleur.green("  ✓ Approved.\n")
        : kleur.yellow("  ✗ Refused.\n"),
    );
    return approved
      ? { approved: true }
      : { approved: false, reason: "refused" };
  } finally {
    rl.close();
  }
}

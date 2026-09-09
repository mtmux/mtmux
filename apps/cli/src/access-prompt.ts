import readline from "node:readline";
import kleur from "kleur";
import { formatSas } from "@repo/crypto";
import { displayLabel } from "@repo/protocol";

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
  | { approved: false; reason: "refused" | "no-tty" | "timeout" };

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
    `    ${kleur.dim("Device ")}  ${displayLabel(req.deviceLabel, "unknown device")}`,
    `    ${kleur.dim("Account")}  ${displayLabel(req.accountEmail, "unknown account")}`,
    `    ${kleur.dim("Code   ")}  ${kleur.bold(formatSas(req.sas))}`,
    "",
  ];
}

/**
 * Who gets asked, in order of specificity.
 *
 * Four cases now, and the first one is the whole reason this is a function
 * rather than three lines inline: `offer` returning **null** means "nobody is
 * waiting", which is emphatically not a refusal. Collapsing the two would mean
 * a machine with an idle approval window silently stopped prompting in its own
 * terminal — a regression that would look, from the outside, exactly like the
 * feature working.
 *
 *   1. Somebody ran `mtmux approve` and is waiting → they decide.
 *   2. There is a TTY → the prompt, unchanged.
 *   3. Neither, and we can park → hold it for the offer window, tell the
 *      terminal, and let them run `mtmux approve` in another shell.
 *   4. Neither, and we cannot → deny `no-tty`. Silence is not consent.
 *
 * Case 3 is new, and it is the common case rather than the exotic one: `mtmux
 * start` under systemd, `nohup`, or a detached tmux pane has no TTY, so
 * pressing "Pair this device" was denied instantly while the user sat right
 * there watching the output. Parking does not weaken anything — it still denies
 * on timeout, and a human still has to type `y` somewhere. It only stops the
 * question being asked and answered in the same millisecond.
 *
 * Everything downstream of the decision is untouched, so a requested pairing is
 * identical however it was approved.
 */
export async function decideAccess(
  req: AccessPromptInput,
  deps: {
    /** Returns null when no approval window is open. */
    offer?: (req: AccessPromptInput) => Promise<boolean | null>;
    /** Hold the request open with nobody polling. Returns false on timeout. */
    park?: (req: AccessPromptInput) => Promise<boolean>;
    /** Called once, when a request is parked, so the terminal can say so. */
    onParked?: (req: AccessPromptInput) => void;
    prompt?: (req: AccessPromptInput) => Promise<AccessPromptResult>;
  } = {},
): Promise<AccessPromptResult> {
  const offered = deps.offer ? await deps.offer(req) : null;
  if (offered !== null) {
    return offered
      ? { approved: true }
      : { approved: false, reason: "refused" };
  }

  const asked = await (deps.prompt ?? promptForAccess)(req);
  // Anything the prompt could actually decide is final. Only `no-tty` — which
  // means it could not ask at all — falls through to parking.
  if (asked.approved || asked.reason !== "no-tty") return asked;
  if (!deps.park) return asked;

  deps.onParked?.(req);
  const approved = await deps.park(req);
  // A parked request nobody answered is a timeout, not a refusal — and the
  // browser offers a different way out for each.
  return approved ? { approved: true } : { approved: false, reason: "timeout" };
}

/**
 * Ask, and return what the human said.
 *
 * No TTY means deny, never auto-approve. A machine running as a service has
 * nobody to ask, and "nobody objected" is not consent — it is the difference
 * between a gate and a formality. Such machines open a window instead; see
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

/**
 * A device that paired before is coming back, and the policy says ask.
 *
 * Deliberately not the same question as `promptForAccess`. There is no SAS to
 * compare here: the device already proved itself cryptographically — its key
 * schedule is what opened the frame — so nothing is being verified. What is
 * being asked is a policy question, "let this one back in?", and dressing it up
 * with a six-digit code nobody can check would teach people to ignore the
 * codes that do matter.
 *
 * No TTY means refuse. Someone who set `reconnectPolicy: confirm` asked for a
 * human in the loop, and silently admitting the device because nobody could be
 * asked would be the setting quietly not applying — the worst outcome for a
 * security control. The refusal says how to change it.
 */
export type ReturningDevice = { label: string; pairedAt?: number };

export function renderReturningDevice(device: ReturningDevice): string[] {
  return [
    "",
    kleur.bold("  A device you paired earlier is reconnecting"),
    "",
    `    ${kleur.dim("Device")}  ${device.label || "unknown device"}`,
    ...(device.pairedAt
      ? [
          `    ${kleur.dim("Paired")}  ${new Date(device.pairedAt).toLocaleString()}`,
        ]
      : []),
    "",
  ];
}

export async function promptForReturningDevice(
  device: ReturningDevice,
  deps: PromptDeps = {},
): Promise<AccessPromptResult> {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;

  if (!input.isTTY) return { approved: false, reason: "no-tty" };

  for (const line of renderReturningDevice(device)) {
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
      rl.question(kleur.bold("  Let it reconnect?") + " [y/N] ", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    if (answer === null) return { approved: false, reason: "timeout" };
    return /^y(es)?$/i.test(answer.trim())
      ? { approved: true }
      : { approved: false, reason: "refused" };
  } finally {
    rl.close();
  }
}

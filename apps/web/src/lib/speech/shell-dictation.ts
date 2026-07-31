/**
 * Turning dictated English into something shell-shaped.
 *
 * Speech recognition has no idea it is listening to a command line: it hears
 * "git checkout dash b feature slash login" and writes exactly that. This maps
 * the handful of spoken words that have an obvious punctuation meaning.
 *
 * Three rules keep it from doing damage, and each one is a bug it would
 * otherwise have:
 *
 * 1. **Whole tokens only, never substrings.** Substring replacement turns
 *    `pipeline` into `|line` and `dashboard` into `-board`. Every rule here
 *    matches a complete token or does not fire.
 * 2. **Quoted regions are inert.** `git commit -m "add slash remove"` is a
 *    sentence about slashes, and the word belongs in the message. Anything
 *    between quotes is passed through untouched.
 * 3. **Command repair is token zero only.** Recognition loves turning `vim`
 *    into `them` — but `them` is also a word, so repairing it anywhere in the
 *    line would rewrite English mid-sentence. Only the first token is a command.
 *
 * `newline` is deliberately *not* in the table. A spoken newline in a shell
 * command means "run this now", and nothing dictated should be able to submit
 * itself; the Send button is the only thing that runs anything.
 *
 * The transform is faithful even when what was said is catastrophic — "rm dash
 * rf slash" becomes `rm -rf /`, and there is a test that pins it. That is
 * exactly why nothing here auto-executes.
 */

/** Spoken word → literal, matched as a whole token. */
const TOKENS: Record<string, string> = {
  dash: "-",
  hyphen: "-",
  "double-dash": "--",
  underscore: "_",
  slash: "/",
  backslash: "\\",
  pipe: "|",
  ampersand: "&",
  asterisk: "*",
  star: "*",
  tilde: "~",
  caret: "^",
  percent: "%",
  dollar: "$",
  hash: "#",
  "hash-tag": "#",
  hashtag: "#",
  at: "@",
  colon: ":",
  semicolon: ";",
  comma: ",",
  "full-stop": ".",
  period: ".",
  dot: ".",
  "question-mark": "?",
  "exclamation-mark": "!",
  bang: "!",
  equals: "=",
  plus: "+",
  "greater-than": ">",
  "less-than": "<",
  "open-paren": "(",
  "close-paren": ")",
  "open-bracket": "[",
  "close-bracket": "]",
  "open-brace": "{",
  "close-brace": "}",
};

/** Two-word phrases, matched before single tokens. */
const PHRASES: [string[], string][] = [
  [["double", "dash"], "--"],
  [["dash", "dash"], "--"],
  [["forward", "slash"], "/"],
  [["back", "slash"], "\\"],
  [["back", "tick"], "`"],
  [["question", "mark"], "?"],
  [["exclamation", "mark"], "!"],
  [["exclamation", "point"], "!"],
  [["hash", "tag"], "#"],
  [["full", "stop"], "."],
  [["open", "paren"], "("],
  [["close", "paren"], ")"],
  [["open", "bracket"], "["],
  [["close", "bracket"], "]"],
  [["open", "brace"], "{"],
  [["close", "brace"], "}"],
  [["greater", "than"], ">"],
  [["less", "than"], "<"],
  [["double", "quote"], '"'],
  [["single", "quote"], "'"],
];

/**
 * Commands recognition reliably mishears, and what it hears them as.
 *
 * Applied to token zero only. `them` → `vim` is safe as a command and unsafe
 * as a word, and that distinction is the whole reason for the restriction.
 */
const COMMAND_REPAIRS: Record<string, string> = {
  them: "vim",
  get: "git",
  gets: "git",
  githup: "git",
  "cd.": "cd",
  "see-through": "cd",
  make: "make",
  grip: "grep",
  grap: "grep",
  "curl.": "curl",
  "en-p-m": "npm",
  "npm.": "npm",
  "docker.": "docker",
  "sudo.": "sudo",
  pseudo: "sudo",
};

/** Escape hatches: say these to get the literal word instead of the symbol. */
const LITERALLY = "literally";
const SPELL = "spell";

/**
 * Split a line into quoted and unquoted runs.
 *
 * Anything inside single or double quotes is prose, and prose about slashes is
 * still prose. An unterminated quote takes the rest of the line with it, which
 * matches what a shell would do.
 */
export function splitQuoted(
  input: string,
): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let buffer = "";
  let quote: string | null = null;

  for (const ch of input) {
    if (quote) {
      buffer += ch;
      if (ch === quote) {
        out.push({ text: buffer, quoted: true });
        buffer = "";
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (buffer) out.push({ text: buffer, quoted: false });
      buffer = ch;
      quote = ch;
      continue;
    }
    buffer += ch;
  }
  if (buffer) out.push({ text: buffer, quoted: quote !== null });
  return out;
}

/**
 * Apply the shell vocabulary to one dictated utterance.
 *
 * Idempotent: running it on its own output is a no-op, because the output is
 * punctuation and punctuation matches no rule.
 */
export function toShell(input: string): string {
  return splitQuoted(input)
    .map((run) => (run.quoted ? run.text : transformRun(run.text)))
    .join("");
}

function transformRun(run: string): string {
  // Preserve leading and trailing whitespace so runs rejoin correctly.
  const leading = /^\s*/.exec(run)![0];
  const trailing = /\s*$/.exec(run)![0];
  const body = run.slice(leading.length, run.length - trailing.length);
  if (!body) return run;

  const tokens = body.split(/\s+/);
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const lower = token.toLowerCase();

    // `literally slash` → the word "slash".
    if (lower === LITERALLY && i + 1 < tokens.length) {
      out.push(tokens[++i]!);
      continue;
    }

    // `spell l s` → "ls". Consumes single characters until something longer.
    if (lower === SPELL) {
      let spelled = "";
      while (
        i + 1 < tokens.length &&
        tokens[i + 1]!.replace(/\W/g, "").length === 1
      ) {
        spelled += tokens[++i]!.replace(/\W/g, "");
      }
      if (spelled) {
        out.push(spelled);
        continue;
      }
      out.push(token);
      continue;
    }

    // Two-word phrases first, so "double dash" does not become "-" "-".
    const next = tokens[i + 1]?.toLowerCase();
    const phrase = next
      ? PHRASES.find(([[a, b]]) => a === lower && b === next)
      : undefined;
    if (phrase) {
      out.push(phrase[1]);
      i += 1;
      continue;
    }

    const literal = TOKENS[lower];
    if (literal !== undefined) {
      out.push(literal);
      continue;
    }

    out.push(token);
  }

  return leading + joinTokens(out) + trailing;
}

/**
 * Rejoin, closing the space around anything that behaves like punctuation.
 *
 * "git checkout - b" is not what was meant; "git checkout -b" is. A symbol
 * binds to the token after it, except for the ones that close rather than open.
 */
const BINDS_RIGHT = new Set([
  "-",
  "--",
  "/",
  "\\",
  "~",
  "$",
  "#",
  "@",
  "^",
  ".",
  ":",
  "=",
  "(",
  "[",
  "{",
]);

/** Punctuation that always closes onto the token before it: `file` `.` `txt`. */
const ALWAYS_LEFT = new Set([
  ".",
  ",",
  ":",
  ";",
  "?",
  "!",
  ")",
  "]",
  "}",
  "=",
  "@",
]);

/**
 * Separators that close leftwards *only when already inside a path*.
 *
 * The two cases this has to tell apart:
 *
 *     cd slash var slash log   →  cd /var/log
 *     rm dash rf slash         →  rm -rf /
 *
 * Both end with a slash preceded by a token that was joined without a space, so
 * "was the previous token bound?" is not enough. What differs is what opened the
 * run: a path separator in the first, a flag in the second. `inPath` tracks
 * that.
 */
const LEFT_IF_IN_PATH = new Set(["/", "\\"]);

/** Symbols that begin something path-shaped, so what follows continues it. */
const PATH_OPENERS = new Set(["/", "\\", "~", ".", "$"]);

function joinTokens(tokens: string[]): string {
  let out = "";
  let bindNext = false;
  let inPath = false;
  for (const token of tokens) {
    let bound = true;
    if (!out) {
      out = token;
      bound = false;
    } else if (
      bindNext ||
      ALWAYS_LEFT.has(token) ||
      (LEFT_IF_IN_PATH.has(token) && inPath)
    ) {
      out += token;
    } else {
      out += ` ${token}`;
      bound = false;
    }
    // A path run continues while tokens keep joining, and ends at the first
    // space — `rm -rf /` breaks the run at the space before `/`.
    inPath = PATH_OPENERS.has(token) || (bound && inPath);
    bindNext = BINDS_RIGHT.has(token);
  }
  return out;
}

/** Repair a mis-heard command, token zero only. */
export function repairCommand(input: string): string {
  const match = /^(\s*)(\S+)([\s\S]*)$/.exec(input);
  if (!match) return input;
  const [, lead, first, rest] = match;
  const repaired = COMMAND_REPAIRS[first!.toLowerCase()];
  return repaired ? `${lead}${repaired}${rest}` : input;
}

/** The whole transform: repair the command, then apply the vocabulary. */
export function dictationToShell(input: string): string {
  return repairCommand(toShell(input));
}

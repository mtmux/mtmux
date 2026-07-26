import kleur from "kleur";
import qrcode from "qrcode-terminal";

export type BannerOpts = {
  /** Always-correct loopback URL for the machine running the server. */
  localUrl: string;
  /** Reachable LAN URL, or null when bound to loopback / there is no network. */
  lanUrl?: string | null;
  /** Interface the LAN address came from, e.g. "wlp3s0". */
  lanInterface?: string | null;
  /** What the QR encodes — normally a `/login#n=<nonce>` tokenless sign-in. */
  qrPayload?: string | null;
  token: string;
  /** Terminal width; injectable so the layout can be tested. */
  columns?: number;
};

const GAP = "  ";
const INDENT = "  ";
const ANSI = /\[[0-9;]*m/g;

/**
 * qrcode-terminal draws *light* modules as foreground blocks and dark modules
 * as the background. That is only the right way round on a dark terminal, and a
 * polarity-inverted QR is a coin flip across scanner apps. Pinning bright white
 * on black makes the code render identically under any terminal theme.
 */
function colorizeQr(lines: string[]): string[] {
  if (!kleur.enabled) return lines;
  return lines.map((line) => `[97;40m${line}[0m`);
}

/** Render a QR for `text` as plain lines, blank rows trimmed. */
export function qrLines(text: string): string[] {
  let out = "";
  // qrcode-terminal's callback is synchronous despite the shape.
  qrcode.generate(text, { small: true }, (rendered: string) => {
    out = rendered;
  });
  return out.split("\n").filter((line) => line.trim().length > 0);
}

/** Visible width, ignoring ANSI colour and counting astral chars once. */
function width(line: string): number {
  return [...line.replace(ANSI, "")].length;
}

/**
 * Zip a text column and a QR column side by side, falling back to stacked
 * output when the terminal is too narrow to hold both.
 */
function twoColumn(left: string[], right: string[], columns: number): string[] {
  if (right.length === 0) return left;

  const leftWidth = Math.max(...left.map(width), 0);
  const rightWidth = Math.max(...right.map(width), 0);

  if (leftWidth + GAP.length + rightWidth + INDENT.length > columns) {
    return [...left, "", ...right.map((line) => INDENT + line)];
  }

  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? "";
    const r = right[i];
    if (r === undefined) {
      out.push(l);
      continue;
    }
    out.push(l + " ".repeat(leftWidth - width(l)) + GAP + r);
  }
  return out;
}

export function renderBannerLines(opts: BannerOpts): string[] {
  const coral = kleur.red; // closest stock color; full RGB requires kleur/colors
  const columns = opts.columns ?? process.stdout.columns ?? 80;

  const left: string[] = [];
  left.push(
    INDENT +
      coral().bold("›  mtmux") +
      kleur.dim("  Your tmux, in any browser."),
  );
  left.push("");
  left.push(INDENT + kleur.bold("On this machine"));
  left.push(INDENT + "  " + coral(opts.localUrl));

  if (opts.lanUrl) {
    const iface = opts.lanInterface
      ? kleur.dim(`  (${opts.lanInterface})`)
      : "";
    left.push("");
    left.push(INDENT + kleur.bold("On your network") + iface);
    left.push(INDENT + "  " + coral(opts.lanUrl));
  }

  const right = opts.qrPayload ? colorizeQr(qrLines(opts.qrPayload)) : [];
  const body = twoColumn(left, right, columns);

  const footer: string[] = [""];
  if (opts.qrPayload) {
    footer.push(
      INDENT + kleur.dim("Scan the code to sign in — no token to type."),
    );
  }
  footer.push(INDENT + kleur.bold("Token") + "  " + kleur.dim(opts.token));
  footer.push("");
  footer.push(INDENT + kleur.dim(`Press ${kleur.bold("Ctrl+C")} to stop.`));

  return ["", ...body, ...footer, ""];
}

export function banner(opts: BannerOpts) {
  for (const line of renderBannerLines(opts)) console.log(line);
}

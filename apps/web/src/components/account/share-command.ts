/**
 * Builds the `mtmux share` command string the dashboard offers to copy.
 *
 * Its own module, separate from the dialog, so it can be tested in the existing
 * node-environment vitest project without dragging React and the whole UI
 * package in behind it.
 */

export type ShareFiles = "none" | "ro" | "rw";

export type ShareCommandOptions = {
  session: string;
  readOnly: boolean;
  files: ShareFiles;
  expires: string;
};

/**
 * Quote only when the shell would otherwise mangle it.
 *
 * tmux session names may contain spaces, and `mtmux share my project` shares a
 * session called `my` — silently, since the extra word lands where the command
 * expects nothing.
 */
function shellArg(value: string): string {
  return /^[A-Za-z0-9._/@:,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildShareCommand(opts: ShareCommandOptions): string {
  const session = opts.session.trim();
  // The placeholder is a prompt to the reader, not an argument, so it is the
  // one thing here that must not be quoted.
  const target = session ? shellArg(session) : "<session>";
  const parts = ["mtmux", "share", target];
  if (opts.readOnly) parts.push("--read-only");
  // `none` and `7d` are the CLI's own defaults, so leaving them off keeps the
  // command people copy most often down to three words.
  if (opts.files !== "none") parts.push("--files", opts.files);
  if (opts.expires !== "7d") parts.push("--expires", opts.expires);
  return parts.join(" ");
}

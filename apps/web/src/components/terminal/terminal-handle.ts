/**
 * Registry for the mounted terminal's imperative handle.
 *
 * The mobile keyboard toolbar lives in the app shell's footer, well outside the
 * tree that owns the terminal ref, so it needs the same kind of escape hatch as
 * `getRelayClient()` — there is only ever one mounted terminal. This lives in
 * its own module (rather than in terminal-view) so consumers don't drag xterm
 * into their bundle: xterm touches `self` at module scope and breaks the
 * server render.
 */
export interface TerminalHandle {
  search: (term: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  /** Current xterm selection, or "" when nothing is selected. */
  getSelection: () => string;
}

let mounted: TerminalHandle | null = null;

export function setTerminalHandle(handle: TerminalHandle | null): void {
  mounted = handle;
}

export function getTerminalHandle(): TerminalHandle | null {
  return mounted;
}

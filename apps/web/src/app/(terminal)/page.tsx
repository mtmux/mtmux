"use client";

import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";

/**
 * The terminal. Every internal handoff targets this route — `connect-to-server`,
 * the session list, the LAN QR and the CLI's `--open` — so it stays at `/`.
 */
export default function TerminalPage() {
  return <TerminalWorkspace />;
}

"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { TerminalWorkspace } from "@/components/terminal/terminal-workspace";
import { useSessionStore } from "@/stores/session-store";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";

/**
 * Deep-link straight to one tmux session.
 *
 * ## Why `/s/` and not `/<sessionId>`
 *
 * Unprefixed, this is a catch-all at the root of the terminal group, so every
 * new top-level route is one tmux session name away from being shadowed — or
 * from shadowing. A session called `start`, `pair` or `settings` is an entirely
 * ordinary thing to create, and any of them would have silently taken over a
 * real page. A one-character namespace removes the whole class.
 *
 * ## Why it renders the workspace
 *
 * It used to `return null` with a comment claiming the parent layout drew the
 * terminal. The layout draws `children`, and `children` was that null — so this
 * route rendered the app shell around an empty box. It was broken, not merely
 * unlinked.
 */
export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { setActiveSession } = useSessionStore();

  useEffect(() => {
    if (sessionId) {
      setActiveSession(decodeURIComponent(sessionId));
      writeStored(LAST_SESSION_KEY, decodeURIComponent(sessionId));
    }
  }, [sessionId, setActiveSession]);

  return <TerminalWorkspace />;
}

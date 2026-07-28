"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useSessionStore } from "@/stores/session-store";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { setActiveSession } = useSessionStore();

  useEffect(() => {
    if (sessionId) {
      setActiveSession(decodeURIComponent(sessionId));
      writeStored(LAST_SESSION_KEY, decodeURIComponent(sessionId));
    }
  }, [sessionId, setActiveSession]);

  // The terminal is rendered by the parent layout
  return null;
}

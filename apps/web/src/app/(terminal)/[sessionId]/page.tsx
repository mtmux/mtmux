"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useSessionStore } from "@/stores/session-store";

export default function SessionPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { setActiveSession } = useSessionStore();

  useEffect(() => {
    if (sessionId) {
      setActiveSession(decodeURIComponent(sessionId));
      localStorage.setItem("ccremote-last-session", decodeURIComponent(sessionId));
    }
  }, [sessionId, setActiveSession]);

  // The terminal is rendered by the parent layout
  return null;
}

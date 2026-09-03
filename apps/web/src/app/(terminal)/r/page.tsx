"use client";

import { RecordingList } from "@/components/recording/recording-list";

/**
 * The recordings on the connected machine.
 *
 * Also where a recordings-scoped share lands. Such a connection can attach to
 * no session at all, so sending it to `/` would show it a terminal that can
 * never fill in — `layout.tsx` routes it here instead.
 */
export default function RecordingsPage() {
  return <RecordingList />;
}

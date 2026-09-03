"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { getRelayClient, useRelayClient } from "@/hooks/use-websocket";
import { fetchCast, type CastChunk } from "@/lib/cast-fetch";
import { useRecordingStore } from "@/stores/recording-store";

import { CastPlayer } from "./cast-player";

/**
 * Fetch one recording and hand it to the player.
 *
 * The bytes come over the websocket as `recording:chunk`, not over HTTP. That
 * is not a preference: the case this feature exists for is a phone on cellular,
 * which is the *tunnelled* case, and there the relay has no HTTP route at all —
 * `resolveRelayHttpBase()` returns `""` and says so in its own docblock.
 * `GET /recording` is a LAN fast path and nothing is built on it.
 */
export function RecordingViewer({ recordingId }: { recordingId: string }) {
  const client = useRelayClient();
  const recordings = useRecordingStore((s) => s.recordings);
  const recording = recordings.find((r) => r.id === recordingId);

  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ received: 0, total: 0 });

  // Chunk listeners live outside React state: they fire at transfer speed, and
  // routing 64 KiB of base64 through a setState would re-render the page for
  // every slice of the file.
  const listeners = useRef(new Set<(chunk: CastChunk) => void>());

  useEffect(() => {
    if (!client) return;
    return client.onMessage((msg) => {
      if (msg.type !== "recording:chunk") return;
      for (const listener of [...listeners.current]) listener(msg);
    });
  }, [client]);

  useEffect(() => {
    if (!client) return;
    // The list is what turns an id into a title and a duration, and a deep link
    // into a share arrives with an empty store.
    if (recordings.length === 0) client.send({ type: "recording:list" });
  }, [client, recordings.length]);

  useEffect(() => {
    if (!client) return;
    const controller = new AbortController();
    setSource(null);
    setError(null);

    fetchCast({
      id: recordingId,
      signal: controller.signal,
      transport: {
        request: (id, offset) =>
          getRelayClient()?.send({ type: "recording:fetch", id, offset }),
        onChunk: (listener) => {
          listeners.current.add(listener);
          return () => listeners.current.delete(listener);
        },
      },
      onProgress: (p) =>
        setProgress({ received: p.receivedBytes, total: p.totalBytes }),
    })
      .then(setSource)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load it.");
      });

    return () => controller.abort();
  }, [client, recordingId]);

  return (
    // `h-dvh` less the app shell's header rather than `h-full`: the parent is
    // not a flex container with a resolved height, so `h-full` collapses to
    // zero and the terminal has nothing to fit into.
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <Link
          href="/r"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Recordings
        </Link>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
          <p className="font-medium">This recording could not be loaded.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      ) : source === null ? (
        <div
          role="status"
          className="grid flex-1 place-items-center text-sm text-muted-foreground"
        >
          {progress.total > 0
            ? `Loading… ${Math.round((progress.received / progress.total) * 100)}%`
            : "Loading…"}
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <CastPlayer
            source={source}
            title={recording?.title}
            truncated={recording?.truncated}
          />
        </div>
      )}
    </div>
  );
}

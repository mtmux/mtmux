"use client";

import { Circle, Square } from "lucide-react";

import { Button } from "@repo/ui/components/ui/button";

import { getRelayClient } from "@/hooks/use-websocket";
import {
  isReadOnly,
  supportsRecording,
  useConnectionStore,
} from "@/stores/connection-store";
import { liveRecordingFor, useRecordingStore } from "@/stores/recording-store";

/**
 * Start or stop recording the attached session.
 *
 * Renders nothing at all in two cases, rather than rendering a disabled
 * control: against a relay too old to record, and for a read-only share. The
 * first is not the viewer's fault and a greyed button invites a support
 * question; the second is a boundary, and a control that exists to say "you may
 * not" is a worse way of saying it than the control's absence.
 */
export function RecordButton({ session }: { session: string | null }) {
  const features = useConnectionStore((s) => s.features);
  const capabilities = useConnectionStore((s) => s.capabilities);
  const recordings = useRecordingStore((s) => s.recordings);

  if (!session) return null;
  if (!supportsRecording(features)) return null;
  if (isReadOnly(capabilities)) return null;

  const live = liveRecordingFor(recordings, session);

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      aria-label={live ? "Stop recording" : "Record this session"}
      aria-pressed={live !== null}
      onClick={() => {
        const client = getRelayClient();
        if (!client) return;
        if (live) {
          client.send({ type: "recording:stop", id: live.id });
        } else {
          client.send({
            type: "recording:start",
            target: { kind: "session", session },
          });
        }
      }}
    >
      {live ? (
        <Square className="h-3.5 w-3.5 fill-current text-destructive" />
      ) : (
        <Circle className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

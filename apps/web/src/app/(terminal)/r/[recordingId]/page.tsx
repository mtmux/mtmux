"use client";

import { use } from "react";

import { RecordingViewer } from "@/components/recording/recording-viewer";

export default function RecordingPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  const { recordingId } = use(params);
  return <RecordingViewer recordingId={recordingId} />;
}

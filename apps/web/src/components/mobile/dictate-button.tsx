"use client";

import { Mic, MicOff, Loader2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useSpeechDictation } from "@/hooks/use-speech-dictation";

/**
 * The microphone.
 *
 * It either works, explains itself, or is not there at all — never a dead
 * control. In Firefox, which has no Web Speech implementation and no way for
 * the user to get one, it renders nothing: a permanently disabled button with a
 * tooltip is worse than an absent one. On the LAN origin
 * (`http://192.168.1.5:14100`, which is how a lot of people reach this app) and
 * when offline it renders disabled *with the reason*, because in both cases
 * there is something the user could change.
 *
 * Interim text goes in an `aria-hidden` ghost line and never into the field.
 * Only state changes reach the live region — announcing every partial
 * transcript turns a screen reader into a firehose.
 *
 * All motion is CSS, so the `prefers-reduced-motion` reset in `globals.css`
 * covers it without this file knowing about it.
 */
export function DictateButton({
  onFinal,
  className,
}: {
  onFinal: (text: string) => void;
  className?: string;
}) {
  const { support, state, interim, message, start, stop } =
    useSpeechDictation(onFinal);

  // Nothing to offer and nothing to explain.
  if (!support.supported && support.reason === "no-api") return null;

  const listening = state === "listening" || state === "requesting";
  const blocked = !support.supported;

  return (
    <div className={cn("relative flex", className)}>
      <button
        type="button"
        onClick={listening ? stop : start}
        disabled={blocked}
        aria-label={listening ? "Stop dictation" : "Dictate a command"}
        aria-pressed={listening}
        title={blocked ? (message ?? undefined) : undefined}
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:opacity-40",
          listening
            ? "bg-destructive text-destructive-foreground"
            : "bg-muted text-muted-foreground active:scale-95",
        )}
      >
        {state === "requesting" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : blocked || state === "error" ? (
          <MicOff className="h-4 w-4" />
        ) : (
          <Mic className={cn("h-4 w-4", listening && "animate-pulse")} />
        )}
      </button>

      {/* The ghost line: what is being heard right now, for sighted users only.
          Writing it into the field would make the field un-editable mid-speech
          and would re-announce the whole value on every partial result. */}
      {interim && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1 max-w-[60vw] -translate-x-1/2 truncate rounded bg-popover px-2 py-1 font-mono text-xs text-muted-foreground shadow"
        >
          {interim}
        </span>
      )}

      {/* State changes only — never transcripts. */}
      <span className="sr-only" role="status">
        {message ?? (listening ? "Listening" : "")}
      </span>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  INITIAL,
  UNSUPPORTED,
  WATCHDOG_MS,
  consumeFinal,
  reduce,
} from "@/lib/speech/machine";
import {
  detectSupport,
  readEnvironment,
  shouldTransliterate,
  type SpeechSupport,
} from "@/lib/speech/support";
import { dictationToShell } from "@/lib/speech/shell-dictation";
import type {
  Recognition,
  SpeechErrorCode,
  SpeechEvent,
  SpeechMachine,
} from "@/lib/speech/types";

/**
 * The browser adapter for dictation. Everything decidable lives elsewhere.
 *
 * **This hook has no access to `getRelayClient`, and that is the enforcement
 * for "dictation never runs anything".** It is not a code-review convention
 * that someone can forget: there is no import here that could send a command,
 * so the only thing a transcript can do is arrive at `onFinal`, which inserts
 * it at the caret and leaves the caret after it. Reviewing what was heard is
 * then the natural next action rather than a discipline.
 */
export type UseSpeechDictation = {
  support: SpeechSupport;
  state: SpeechMachine["state"];
  /** Interim text for an `aria-hidden` ghost line. Never a field value. */
  interim: string;
  message: string | null;
  start: () => void;
  stop: () => void;
};

export function useSpeechDictation(
  onFinal: (text: string) => void,
): UseSpeechDictation {
  const [machine, setMachine] = useState<SpeechMachine>(INITIAL);
  const [support, setSupport] = useState<SpeechSupport>({ supported: true });
  const recognitionRef = useRef<Recognition | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  // Detected on mount rather than at module scope: `isSecureContext` and
  // `navigator.onLine` do not exist during SSR, and `online` can change.
  useEffect(() => {
    const detect = () => {
      const next = detectSupport(readEnvironment());
      setSupport(next);
      setMachine((m) => (next.supported ? m : UNSUPPORTED));
    };
    detect();
    window.addEventListener("online", detect);
    window.addEventListener("offline", detect);
    return () => {
      window.removeEventListener("online", detect);
      window.removeEventListener("offline", detect);
    };
  }, []);

  const dispatch = useCallback((event: SpeechEvent) => {
    setMachine((current) => reduce(current, event));
  }, []);

  // Deliver finals outside the reducer, so the reducer stays pure and testable.
  useEffect(() => {
    if (machine.final === null) return;
    onFinalRef.current(machine.final);
    setMachine(consumeFinal);
  }, [machine.final]);

  const clearWatchdog = useCallback(() => {
    if (!watchdogRef.current) return;
    clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  const stop = useCallback(() => {
    clearWatchdog();
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    dispatch({ type: "stop" });
  }, [clearWatchdog, dispatch]);

  const start = useCallback(() => {
    if (!support.supported) return;
    // The reducer refuses a second start; bail here too so we never construct
    // a second recogniser whose events would interleave with the first's.
    if (recognitionRef.current) return;

    const Ctor = recognitionConstructor();
    if (!Ctor) return;

    const recognition = new Ctor() as Recognition;
    recognitionRef.current = recognition;
    const locale = navigator.language || "en-US";
    recognition.lang = locale;
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onaudiostart = () => {
      clearWatchdog();
      dispatch({ type: "audiostart" });
    };
    recognition.onresult = (raw) => {
      const event = raw as {
        resultIndex: number;
        results: ArrayLike<
          ArrayLike<{ transcript: string }> & { isFinal: boolean }
        >;
      };
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const raw = result[0]?.transcript ?? "";
        const transcript = shouldTransliterate(locale)
          ? dictationToShell(raw)
          : raw;
        dispatch({ type: "result", transcript, final: result.isFinal });
      }
    };
    recognition.onerror = (raw) => {
      clearWatchdog();
      const code = (raw as { error?: SpeechErrorCode }).error ?? "bad-grammar";
      dispatch({ type: "error", code });
    };
    recognition.onend = () => {
      clearWatchdog();
      recognitionRef.current = null;
      // Deliberately no restart here. See `machine.ts`.
      dispatch({ type: "end" });
    };

    dispatch({ type: "start" });
    try {
      recognition.start();
    } catch {
      // Chrome throws InvalidStateError on a double start. The guards above
      // make that unreachable; if it happens anyway, fail visibly rather than
      // leaving a button that spins.
      recognitionRef.current = null;
      dispatch({ type: "error", code: "bad-grammar" });
      return;
    }

    // In an installed iOS PWA recognition frequently starts and then never
    // fires anything at all — no audio, no result, no error. Without this the
    // button spins forever and the user has no idea the app cannot do it.
    watchdogRef.current = setTimeout(
      () => dispatch({ type: "watchdog" }),
      WATCHDOG_MS,
    );
  }, [support.supported, clearWatchdog, dispatch]);

  // Backgrounding the tab with a live microphone is exactly the thing a user
  // would be alarmed to discover, so it is aborted rather than left running.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      dispatch({ type: "hidden" });
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [dispatch]);

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  return useMemo(
    () => ({
      support,
      state: machine.state,
      interim: machine.interim,
      message: machine.message ?? (support.supported ? null : support.message),
      start,
      stop,
    }),
    [support, machine.state, machine.interim, machine.message, start, stop],
  );
}

function recognitionConstructor(): (new () => unknown) | null {
  const w = window as unknown as Record<string, unknown>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof Ctor === "function" ? (Ctor as new () => unknown) : null;
}

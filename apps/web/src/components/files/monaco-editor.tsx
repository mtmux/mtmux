"use client";

import dynamic from "next/dynamic";
import { loader } from "@monaco-editor/react";
import type { OnMount, OnChange } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useCallback, useRef } from "react";

// Configure @monaco-editor/react to use the locally installed monaco-editor
// instead of fetching from CDN
loader.config({ monaco });

const Editor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex-1 space-y-2 p-4">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="h-4 animate-pulse rounded bg-muted"
          style={{ width: `${40 + Math.random() * 50}%` }}
        />
      ))}
    </div>
  ),
});

interface MonacoEditorProps {
  content: string;
  language: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
  theme?: "vs-dark" | "light";
  wordWrap?: "on" | "off";
  fontSize?: number;
}

export function MonacoEditor({
  content,
  language,
  readOnly = false,
  onChange,
  onSave,
  theme = "vs-dark",
  wordWrap = "on",
  fontSize = 14,
}: MonacoEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;

      // Register Ctrl+S / Cmd+S keybinding
      if (onSave) {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
          onSave();
        });
      }

      editor.focus();
    },
    [onSave],
  );

  const handleChange: OnChange = useCallback(
    (value) => {
      onChange?.(value ?? "");
    },
    [onChange],
  );

  return (
    <Editor
      height="100%"
      language={language}
      value={content}
      theme={theme}
      onChange={handleChange}
      onMount={handleMount}
      options={{
        readOnly,
        minimap: { enabled: true },
        lineNumbers: "on",
        wordWrap,
        fontSize,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: "selection",
        bracketPairColorization: { enabled: true },
        padding: { top: 8 },
      }}
    />
  );
}

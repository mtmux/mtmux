import { z } from "zod";
import {
  SessionInfoSchema,
  FileEntrySchema,
  FileStatSchema,
  PaneInfoSchema,
  WindowInfoSchema,
} from "./types";

export const AuthSuccessMessage = z.object({
  type: z.literal("auth:success"),
  serverVersion: z.string(),
  /**
   * What this credential may do, so the UI can be honest about it.
   *
   * Strictly advisory. Every field here is enforced on the server for every
   * message regardless of what the client does with it — this exists so a
   * read-only viewer sees a read-only banner instead of a keyboard that
   * silently does nothing, and so a share with no file access does not render
   * a file tree that can only ever answer ACCESS_DENIED.
   *
   * Optional because an older relay does not send it, and the absence must
   * read as "unrestricted", which is what such a relay in fact is.
   */
  capabilities: z
    .object({
      readOnly: z.boolean(),
      files: z.enum(["none", "read", "write"]),
      scope: z.enum(["all", "sessions"]),
    })
    .optional(),
});

export const AuthFailureMessage = z.object({
  type: z.literal("auth:failure"),
  reason: z.string(),
});

export const PongMessage = z.object({
  type: z.literal("pong"),
  timestamp: z.number(),
});

export const ErrorMessage = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const ServerInfoMessage = z.object({
  type: z.literal("server:info"),
  hostname: z.string(),
  platform: z.string(),
  uptime: z.number(),
  // Primary allowed directory the file browser should open to. Advertised by
  // the relay so the client doesn't have to guess the server's home path.
  defaultPath: z.string().optional(),
});

export const TerminalOutputMessage = z.object({
  type: z.literal("terminal:output"),
  data: z.string(),
});

export const SessionListResponse = z.object({
  type: z.literal("session:list"),
  sessions: z.array(SessionInfoSchema),
});

export const SessionCreatedMessage = z.object({
  type: z.literal("session:created"),
  session: SessionInfoSchema,
});

export const SessionKilledMessage = z.object({
  type: z.literal("session:killed"),
  name: z.string(),
});

export const SessionActivityMessage = z.object({
  type: z.literal("session:activity"),
  name: z.string(),
  activity: z.string(),
});

export const SessionExitedMessage = z.object({
  type: z.literal("session:exited"),
  name: z.string(),
  exitCode: z.number().optional(),
});

export const FileListResponse = z.object({
  type: z.literal("file:list"),
  path: z.string(),
  entries: z.array(FileEntrySchema),
});

export const FileContentResponse = z.object({
  type: z.literal("file:content"),
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const FileStatResponse = z.object({
  type: z.literal("file:stat"),
  stat: FileStatSchema,
});

export const FileChangedMessage = z.object({
  type: z.literal("file:changed"),
  path: z.string(),
  event: z.enum(["add", "change", "unlink", "addDir", "unlinkDir"]),
});

// File write/operation results
export const FileWriteResultMessage = z.object({
  type: z.literal("file:write:result"),
  path: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  size: z.number().optional(),
});

export const FileOpResultMessage = z.object({
  type: z.literal("file:op:result"),
  op: z.enum(["create", "mkdir", "delete", "rename", "upload"]),
  path: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});

// Pane/Window response messages
export const PaneListResponse = z.object({
  type: z.literal("pane:list"),
  panes: z.array(PaneInfoSchema),
  windowId: z.string(),
});

export const WindowListResponse = z.object({
  type: z.literal("window:list"),
  windows: z.array(WindowInfoSchema),
  sessionName: z.string(),
});

export const PaneChangedMessage = z.object({
  type: z.literal("pane:changed"),
  panes: z.array(PaneInfoSchema),
  windowId: z.string(),
});

export const WindowChangedMessage = z.object({
  type: z.literal("window:changed"),
  windows: z.array(WindowInfoSchema),
  sessionName: z.string(),
});

export const SessionAttachedMessage = z.object({
  type: z.literal("session:attached"),
  name: z.string(),
  // Echoes `session:attach.attachId` — see client-messages.ts.
  attachId: z.string().optional(),
});

export const PaneCapturedMessage = z.object({
  type: z.literal("pane:captured"),
  id: z.string(),
  content: z.string(),
});

export const SessionWindowsResponse = z.object({
  type: z.literal("session:windows"),
  name: z.string(),
  windows: z.array(WindowInfoSchema),
  panes: z.array(PaneInfoSchema),
});

export const ServerMessage = z.discriminatedUnion("type", [
  AuthSuccessMessage,
  AuthFailureMessage,
  PongMessage,
  ErrorMessage,
  ServerInfoMessage,
  TerminalOutputMessage,
  SessionListResponse,
  SessionCreatedMessage,
  SessionKilledMessage,
  SessionActivityMessage,
  SessionExitedMessage,
  FileListResponse,
  FileContentResponse,
  FileStatResponse,
  FileChangedMessage,
  FileWriteResultMessage,
  FileOpResultMessage,
  PaneListResponse,
  WindowListResponse,
  PaneChangedMessage,
  WindowChangedMessage,
  SessionAttachedMessage,
  PaneCapturedMessage,
  SessionWindowsResponse,
]);

export type ServerMessage = z.infer<typeof ServerMessage>;
export type AuthSuccessMessage = z.infer<typeof AuthSuccessMessage>;
export type AuthFailureMessage = z.infer<typeof AuthFailureMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type ServerInfoMessage = z.infer<typeof ServerInfoMessage>;
export type TerminalOutputMessage = z.infer<typeof TerminalOutputMessage>;
export type SessionListResponse = z.infer<typeof SessionListResponse>;
export type SessionCreatedMessage = z.infer<typeof SessionCreatedMessage>;
export type SessionKilledMessage = z.infer<typeof SessionKilledMessage>;
export type SessionActivityMessage = z.infer<typeof SessionActivityMessage>;
export type SessionExitedMessage = z.infer<typeof SessionExitedMessage>;
export type FileListResponse = z.infer<typeof FileListResponse>;
export type FileContentResponse = z.infer<typeof FileContentResponse>;
export type FileStatResponse = z.infer<typeof FileStatResponse>;
export type FileChangedMessage = z.infer<typeof FileChangedMessage>;
export type FileWriteResultMessage = z.infer<typeof FileWriteResultMessage>;
export type FileOpResultMessage = z.infer<typeof FileOpResultMessage>;
export type PaneListResponse = z.infer<typeof PaneListResponse>;
export type WindowListResponse = z.infer<typeof WindowListResponse>;
export type PaneChangedMessage = z.infer<typeof PaneChangedMessage>;
export type WindowChangedMessage = z.infer<typeof WindowChangedMessage>;
export type SessionAttachedMessage = z.infer<typeof SessionAttachedMessage>;
export type PaneCapturedMessage = z.infer<typeof PaneCapturedMessage>;
export type SessionWindowsResponse = z.infer<typeof SessionWindowsResponse>;

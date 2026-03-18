import { z } from "zod";
import { TerminalSizeSchema } from "./types";

export const AuthMessage = z.object({
  type: z.literal("auth"),
  token: z.string(),
});

export const PingMessage = z.object({
  type: z.literal("ping"),
  timestamp: z.number(),
});

export const TerminalInputMessage = z.object({
  type: z.literal("terminal:input"),
  data: z.string(),
});

export const TerminalResizeMessage = z.object({
  type: z.literal("terminal:resize"),
  size: TerminalSizeSchema,
});

export const SessionListMessage = z.object({
  type: z.literal("session:list"),
});

export const SessionCreateMessage = z.object({
  type: z.literal("session:create"),
  name: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional(),
});

export const SessionAttachMessage = z.object({
  type: z.literal("session:attach"),
  name: z.string(),
  size: TerminalSizeSchema.optional(),
});

export const SessionDetachMessage = z.object({
  type: z.literal("session:detach"),
});

export const SessionKillMessage = z.object({
  type: z.literal("session:kill"),
  name: z.string(),
});

export const SessionRenameMessage = z.object({
  type: z.literal("session:rename"),
  oldName: z.string(),
  newName: z.string(),
});

export const FileListMessage = z.object({
  type: z.literal("file:list"),
  path: z.string(),
});

export const FileReadMessage = z.object({
  type: z.literal("file:read"),
  path: z.string(),
});

export const FileStatMessage = z.object({
  type: z.literal("file:stat"),
  path: z.string(),
});

export const FileWatchMessage = z.object({
  type: z.literal("file:watch"),
  path: z.string(),
});

export const FileUnwatchMessage = z.object({
  type: z.literal("file:unwatch"),
  path: z.string(),
});

export const CommandSendMessage = z.object({
  type: z.literal("command:send"),
  command: z.string(),
});

export const CommandInterruptMessage = z.object({
  type: z.literal("command:interrupt"),
});

export const CommandEofMessage = z.object({
  type: z.literal("command:eof"),
});

export const CommandClearMessage = z.object({
  type: z.literal("command:clear"),
});

export const CommandSuspendMessage = z.object({
  type: z.literal("command:suspend"),
});

// Pane messages
export const PaneListMessage = z.object({
  type: z.literal("pane:list"),
});

export const PaneSplitMessage = z.object({
  type: z.literal("pane:split"),
  direction: z.enum(["h", "v"]),
});

export const PaneSelectMessage = z.object({
  type: z.literal("pane:select"),
  id: z.string(),
});

export const PaneZoomMessage = z.object({
  type: z.literal("pane:zoom"),
});

export const PaneResizeMessage = z.object({
  type: z.literal("pane:resize"),
  id: z.string(),
  direction: z.enum(["U", "D", "L", "R"]),
  amount: z.number().int().min(1),
});

export const PaneKillMessage = z.object({
  type: z.literal("pane:kill"),
  id: z.string(),
});

// Window messages
export const WindowListMessage = z.object({
  type: z.literal("window:list"),
});

export const WindowCreateMessage = z.object({
  type: z.literal("window:create"),
  name: z.string().optional(),
});

export const WindowSelectMessage = z.object({
  type: z.literal("window:select"),
  id: z.string(),
});

export const WindowKillMessage = z.object({
  type: z.literal("window:kill"),
  id: z.string(),
});

export const PaneSwapMessage = z.object({
  type: z.literal("pane:swap"),
  id: z.string(),
  direction: z.enum(["U", "D", "L", "R"]),
});

export const WindowRenameMessage = z.object({
  type: z.literal("window:rename"),
  id: z.string(),
  name: z.string(),
});

export const WindowLayoutMessage = z.object({
  type: z.literal("window:layout"),
  preset: z.enum(["even-horizontal", "even-vertical", "main-horizontal", "main-vertical", "tiled"]),
});

export const LayoutRotateMessage = z.object({
  type: z.literal("layout:rotate"),
});

export const TmuxPrefixMessage = z.object({
  type: z.literal("tmux:prefix"),
});

export const TmuxCopyModeMessage = z.object({
  type: z.literal("tmux:copy-mode"),
});

export const ClientMessage = z.discriminatedUnion("type", [
  AuthMessage,
  PingMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
  SessionListMessage,
  SessionCreateMessage,
  SessionAttachMessage,
  SessionDetachMessage,
  SessionKillMessage,
  SessionRenameMessage,
  FileListMessage,
  FileReadMessage,
  FileStatMessage,
  FileWatchMessage,
  FileUnwatchMessage,
  CommandSendMessage,
  CommandInterruptMessage,
  CommandEofMessage,
  CommandClearMessage,
  CommandSuspendMessage,
  PaneListMessage,
  PaneSplitMessage,
  PaneSelectMessage,
  PaneZoomMessage,
  PaneResizeMessage,
  PaneKillMessage,
  WindowListMessage,
  WindowCreateMessage,
  WindowSelectMessage,
  WindowKillMessage,
  PaneSwapMessage,
  WindowRenameMessage,
  WindowLayoutMessage,
  LayoutRotateMessage,
  TmuxPrefixMessage,
  TmuxCopyModeMessage,
]);

export type ClientMessage = z.infer<typeof ClientMessage>;
export type AuthMessage = z.infer<typeof AuthMessage>;
export type PingMessage = z.infer<typeof PingMessage>;
export type TerminalInputMessage = z.infer<typeof TerminalInputMessage>;
export type TerminalResizeMessage = z.infer<typeof TerminalResizeMessage>;
export type SessionListMessage = z.infer<typeof SessionListMessage>;
export type SessionCreateMessage = z.infer<typeof SessionCreateMessage>;
export type SessionAttachMessage = z.infer<typeof SessionAttachMessage>;
export type SessionDetachMessage = z.infer<typeof SessionDetachMessage>;
export type SessionKillMessage = z.infer<typeof SessionKillMessage>;
export type SessionRenameMessage = z.infer<typeof SessionRenameMessage>;
export type FileListMessage = z.infer<typeof FileListMessage>;
export type FileReadMessage = z.infer<typeof FileReadMessage>;
export type FileStatMessage = z.infer<typeof FileStatMessage>;
export type FileWatchMessage = z.infer<typeof FileWatchMessage>;
export type FileUnwatchMessage = z.infer<typeof FileUnwatchMessage>;
export type CommandSendMessage = z.infer<typeof CommandSendMessage>;
export type CommandInterruptMessage = z.infer<typeof CommandInterruptMessage>;
export type CommandEofMessage = z.infer<typeof CommandEofMessage>;
export type CommandClearMessage = z.infer<typeof CommandClearMessage>;
export type CommandSuspendMessage = z.infer<typeof CommandSuspendMessage>;
export type PaneListMessage = z.infer<typeof PaneListMessage>;
export type PaneSplitMessage = z.infer<typeof PaneSplitMessage>;
export type PaneSelectMessage = z.infer<typeof PaneSelectMessage>;
export type PaneZoomMessage = z.infer<typeof PaneZoomMessage>;
export type PaneResizeMessage = z.infer<typeof PaneResizeMessage>;
export type PaneKillMessage = z.infer<typeof PaneKillMessage>;
export type WindowListMessage = z.infer<typeof WindowListMessage>;
export type WindowCreateMessage = z.infer<typeof WindowCreateMessage>;
export type WindowSelectMessage = z.infer<typeof WindowSelectMessage>;
export type WindowKillMessage = z.infer<typeof WindowKillMessage>;
export type PaneSwapMessage = z.infer<typeof PaneSwapMessage>;
export type WindowRenameMessage = z.infer<typeof WindowRenameMessage>;
export type WindowLayoutMessage = z.infer<typeof WindowLayoutMessage>;
export type LayoutRotateMessage = z.infer<typeof LayoutRotateMessage>;
export type TmuxPrefixMessage = z.infer<typeof TmuxPrefixMessage>;
export type TmuxCopyModeMessage = z.infer<typeof TmuxCopyModeMessage>;

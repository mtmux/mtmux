import fs from "node:fs/promises";
import path from "node:path";
import { watch } from "chokidar";
import { createLogger } from "@repo/logger";
import type { FileEntry, FileStat } from "@repo/protocol";
import { config } from "./config.js";

const logger = createLogger("relay:files");

const MAX_FILE_SIZE = 100 * 1024; // 100KB

export function isPathAllowed(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  return config.allowedPaths.some((allowed) => {
    const resolvedAllowed = path.resolve(allowed);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
  });
}

function assertPathAllowed(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (!isPathAllowed(resolved)) {
    throw new Error(`Access denied: path outside allowed directories`);
  }
  return resolved;
}

function fileTypeFromDirent(dirent: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileEntry["type"] {
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "directory";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

export async function listDirectory(dirPath: string): Promise<FileEntry[]> {
  const resolved = assertPathAllowed(dirPath);
  const entries = await fs.readdir(resolved, { withFileTypes: true });

  const results: FileEntry[] = [];
  for (const entry of entries) {
    try {
      const fullPath = path.join(resolved, entry.name);
      const stat = await fs.stat(fullPath);
      results.push({
        name: entry.name,
        path: fullPath,
        type: fileTypeFromDirent(entry),
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries we can't stat
    }
  }

  return results.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

export async function readFile(
  filePath: string,
): Promise<{ content: string; truncated: boolean }> {
  const resolved = assertPathAllowed(filePath);
  const stat = await fs.stat(resolved);

  if (!stat.isFile()) {
    throw new Error("Not a file");
  }

  if (stat.size > MAX_FILE_SIZE) {
    const buffer = Buffer.alloc(MAX_FILE_SIZE);
    const handle = await fs.open(resolved, "r");
    try {
      await handle.read(buffer, 0, MAX_FILE_SIZE, 0);
      return { content: buffer.toString("utf-8"), truncated: true };
    } finally {
      await handle.close();
    }
  }

  const content = await fs.readFile(resolved, "utf-8");
  return { content, truncated: false };
}

export async function getStats(filePath: string): Promise<FileStat> {
  const resolved = assertPathAllowed(filePath);
  const stat = await fs.stat(resolved);

  let permissions: string;
  try {
    await fs.access(resolved, fs.constants.R_OK);
    permissions = "r";
    try {
      await fs.access(resolved, fs.constants.W_OK);
      permissions += "w";
    } catch {
      // not writable
    }
  } catch {
    permissions = "-";
  }

  return {
    name: path.basename(resolved),
    path: resolved,
    type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other",
    size: stat.size,
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    permissions,
    isReadable: permissions.includes("r"),
    isWritable: permissions.includes("w"),
  };
}

export interface DirectoryWatcher {
  close(): void;
}

export function watchDirectory(
  dirPath: string,
  onChange: (event: "add" | "change" | "unlink" | "addDir" | "unlinkDir", filePath: string) => void,
): DirectoryWatcher {
  const resolved = assertPathAllowed(dirPath);

  const watcher = watch(resolved, {
    depth: 0,
    ignoreInitial: true,
    persistent: true,
  });

  watcher.on("all", (event, filePath) => {
    const validEvents = ["add", "change", "unlink", "addDir", "unlinkDir"] as const;
    if (validEvents.includes(event as (typeof validEvents)[number])) {
      onChange(event as (typeof validEvents)[number], filePath);
    }
  });

  watcher.on("error", (err) => {
    logger.error({ err, path: resolved }, "File watcher error");
  });

  return {
    close() {
      watcher.close();
    },
  };
}

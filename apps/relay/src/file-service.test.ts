import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// file-service reads config.allowedPaths at import time from ALLOWED_PATHS, so
// we create the fixture tree, point ALLOWED_PATHS at it, then dynamically import
// the module under test. realpath is resolved so the tmp dir may itself be a
// symlink (as on some platforms) without affecting the assertions.
let files: typeof import("./file-service.js");

let base: string; // real temp base
let allowedDir: string; // the single allowed root (base/user)
let siblingDir: string; // base/userdata — shares a string prefix with the root
let subDir: string; // base/user/sub — a legitimate subpath
let outsideDir: string; // base/outside — symlink escape target
let escapeLink: string; // base/user/escape -> base/outside

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-fs-")));
  allowedDir = path.join(base, "user");
  siblingDir = path.join(base, "userdata");
  subDir = path.join(allowedDir, "sub");
  outsideDir = path.join(base, "outside");

  fs.mkdirSync(allowedDir);
  fs.mkdirSync(siblingDir);
  fs.mkdirSync(subDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "top secret");

  escapeLink = path.join(allowedDir, "escape");
  fs.symlinkSync(outsideDir, escapeLink, "dir");

  process.env.ALLOWED_PATHS = allowedDir;
  files = await import("./file-service.js");
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("isPathAllowed", () => {
  it("allows the exact allowed root", () => {
    expect(files.isPathAllowed(allowedDir)).toBe(true);
  });

  it("allows a subpath of the allowed root", () => {
    expect(files.isPathAllowed(subDir)).toBe(true);
    expect(files.isPathAllowed(path.join(subDir, "deep", "nested"))).toBe(true);
  });

  it("allows a not-yet-existing file inside the allowed root", () => {
    expect(files.isPathAllowed(path.join(allowedDir, "new-file.txt"))).toBe(
      true,
    );
  });

  it("rejects a sibling directory that merely shares a string prefix", () => {
    // /home/userdata must NOT match allowed /home/user
    expect(files.isPathAllowed(siblingDir)).toBe(false);
    expect(files.isPathAllowed(path.join(siblingDir, "file.txt"))).toBe(false);
  });

  it("rejects `..` traversal that escapes the allowed root", () => {
    expect(files.isPathAllowed(path.join(allowedDir, "..", ".."))).toBe(false);
    expect(files.isPathAllowed(path.join(allowedDir, "..", "outside"))).toBe(
      false,
    );
  });

  it("rejects a symlink inside the allowed root that points outside it", () => {
    // The symlink itself resolves outside the root.
    expect(files.isPathAllowed(escapeLink)).toBe(false);
    // And any path accessed *through* the symlink is rejected too.
    expect(files.isPathAllowed(path.join(escapeLink, "secret.txt"))).toBe(
      false,
    );
  });
});

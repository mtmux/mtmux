import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Which broker a machine talks to.
 *
 * `config-store` reads `MTMUX_CONFIG_DIR` at import time, so every test gets a
 * throwaway directory and freshly imported modules. Nothing here can touch the
 * developer's real `~/.mtmux`.
 */
let dir: string;
let api: typeof import("./api.js");
let store: typeof import("./config-store.js");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mtmux-api-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  delete process.env.MTMUX_API_URL;
  vi.resetModules();
  api = await import("./api.js");
  store = await import("./config-store.js");
});

afterEach(async () => {
  delete process.env.MTMUX_CONFIG_DIR;
  delete process.env.MTMUX_API_URL;
  await rm(dir, { recursive: true, force: true });
});

describe("resolveApiBase", () => {
  it("uses ours when nothing says otherwise", async () => {
    expect(await api.resolveApiBase()).toBe(api.DEFAULT_API_BASE);
  });

  it("reads the stored broker, which is the whole point", async () => {
    // Before this, `Account.apiBase` was written and never read back, so a
    // self-hoster had to pass `--api` or export `MTMUX_API_URL` on every
    // single invocation.
    await store.setApiBase("https://broker.example.com");
    expect(await api.resolveApiBase()).toBe("https://broker.example.com");
  });

  it("falls back to the broker the account signed in against", async () => {
    await store.setAccount({
      token: "t",
      userId: "u",
      email: "me@example.com",
      apiBase: "https://accounts.example.com",
    });
    expect(await api.resolveApiBase()).toBe("https://accounts.example.com");
  });

  it("prefers the explicit setting over the account's broker", async () => {
    await store.setAccount({
      token: "t",
      userId: "u",
      email: "me@example.com",
      apiBase: "https://accounts.example.com",
    });
    await store.setApiBase("https://broker.example.com");
    expect(await api.resolveApiBase()).toBe("https://broker.example.com");
  });

  it("lets a flag and the environment win, in that order", async () => {
    await store.setApiBase("https://stored.example.com");
    process.env.MTMUX_API_URL = "https://env.example.com";
    expect(await api.resolveApiBase()).toBe("https://env.example.com");
    expect(await api.resolveApiBase("https://flag.example.com")).toBe(
      "https://flag.example.com",
    );
  });

  it("strips a trailing slash, wherever the value came from", async () => {
    await store.setApiBase("https://broker.example.com/");
    expect(await api.resolveApiBase()).toBe("https://broker.example.com");
    expect(await api.resolveApiBase("https://flag.example.com//")).toBe(
      "https://flag.example.com",
    );
  });

  it("reaches the default broker even when the config is unreadable", async () => {
    // A corrupt config must not cut the machine off from pairing entirely.
    vi.spyOn(store, "load").mockRejectedValue(new Error("EACCES"));
    expect(await api.resolveApiBase()).toBe(api.DEFAULT_API_BASE);
  });
});

describe("isBrokerUrl", () => {
  it("accepts http and https", async () => {
    // http on purpose: a self-hoster's first broker is usually on their own
    // network, and refusing it only teaches them to fight the tool.
    expect(api.isBrokerUrl("http://192.168.1.10:14400")).toBe(true);
    expect(api.isBrokerUrl("https://broker.example.com")).toBe(true);
  });

  it("refuses anything that is not an absolute http(s) URL", async () => {
    for (const bad of [
      "broker.example.com",
      "ws://broker.example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
      "  ",
    ]) {
      expect(api.isBrokerUrl(bad)).toBe(false);
    }
  });
});

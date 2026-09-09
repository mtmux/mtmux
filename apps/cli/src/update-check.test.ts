import { describe, it, expect, vi, afterEach } from "vitest";
import { MIN_PAIR_CLI_VERSION } from "@repo/protocol";
import {
  describeUpdate,
  fetchBrokerVersion,
  type BrokerVersion,
} from "./update-check.js";

const info = (over: Partial<BrokerVersion> = {}): BrokerVersion => ({
  protocol: 2,
  floor: 2,
  ...over,
});

describe("describeUpdate", () => {
  it("says nothing when the broker has no opinion", () => {
    // Offline, self-hosted, or simply older than `/v1/version`. All three mean
    // "no answer", and inventing advice from no answer is how a check like
    // this loses the reader's trust.
    expect(describeUpdate("0.7.0", null).kind).toBe("current");
    expect(describeUpdate("0.7.0", info()).kind).toBe("current");
    expect(describeUpdate("0.7.0", info())).not.toHaveProperty("advisory");
  });

  it("names the floor when the broker will refuse to pair", () => {
    const notice = describeUpdate("0.6.4", info({ minCli: "0.7.0" }));
    expect(notice.kind).toBe("outdated");
    expect(notice.detail).toContain("0.7.0");
    expect(notice.fix).toBe("npm i -g mtmux@latest");
  });

  it("falls back to the compiled floor when the broker names none", () => {
    expect(describeUpdate("0.1.0", info()).kind).toBe("outdated");
    expect(describeUpdate(MIN_PAIR_CLI_VERSION, info()).kind).toBe("current");
  });

  it("mentions a newer release without calling it a problem", () => {
    const notice = describeUpdate("0.7.0", info({ latest: "0.8.1" }));
    expect(notice.kind).toBe("stale");
    expect(notice.detail).toContain("0.8.1");
  });

  it("never reports a version it cannot parse as too old", () => {
    // The discipline `semverGte` was written for: null means unknown, and
    // unknown must read as "say nothing". Telling someone to upgrade a CLI
    // that is already current is unfixable advice.
    for (const current of ["", "dev", "not-a-version", "0.7"]) {
      expect(describeUpdate(current, info({ minCli: "0.7.0" })).kind).toBe(
        "current",
      );
    }
    expect(describeUpdate("0.7.0", info({ latest: "nightly" })).kind).toBe(
      "current",
    );
  });

  it("carries an advisory through on its own, and trimmed", () => {
    const notice = describeUpdate("9.9.9", info({ advisory: "  Rotate.  " }));
    expect(notice.kind).toBe("current");
    expect(notice.advisory).toBe("Rotate.");
    // An empty advisory is not an advisory.
    expect(describeUpdate("9.9.9", info({ advisory: "   " }))).not.toHaveProperty(
      "advisory",
    );
  });

  it("reports the floor even when a newer release also exists", () => {
    // Both are true; only one of them stops the user pairing, and that is the
    // one worth the line.
    expect(
      describeUpdate("0.6.0", info({ minCli: "0.7.0", latest: "0.8.0" })).kind,
    ).toBe("outdated");
  });
});

describe("fetchBrokerVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (status: number, body: unknown) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      }),
    );
  };

  it("reads the fields it knows and ignores the rest", async () => {
    respond(200, {
      protocol: 2,
      floor: 2,
      minCli: "0.7.0",
      latest: "0.7.3",
      advisory: "hi",
      somethingNew: 1,
    });
    expect(await fetchBrokerVersion("http://broker.test")).toEqual({
      protocol: 2,
      floor: 2,
      minCli: "0.7.0",
      latest: "0.7.3",
      advisory: "hi",
    });
  });

  it("returns null rather than throwing, whatever it is handed", async () => {
    respond(404, { error: "nope" });
    expect(await fetchBrokerVersion("http://broker.test")).toBeNull();

    respond(200, "not an object");
    expect(await fetchBrokerVersion("http://broker.test")).toBeNull();

    respond(200, { protocol: "two", floor: 2 });
    expect(await fetchBrokerVersion("http://broker.test")).toBeNull();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await fetchBrokerVersion("http://broker.test")).toBeNull();
  });

  it("drops fields of the wrong type instead of passing them on", async () => {
    respond(200, { protocol: 2, floor: 0, latest: 7, advisory: null });
    expect(await fetchBrokerVersion("http://broker.test")).toEqual({
      protocol: 2,
      floor: 0,
    });
  });
});

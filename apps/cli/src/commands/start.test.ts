import { describe, it, expect } from "vitest";
import {
  NO_FAILURES,
  REARM_LIMITS,
  devicesOnline,
  missingFrom,
  rearmDecision,
  resolveHost,
  resolveLanUrl,
  type RearmState,
} from "./start.js";
import { PairingError } from "../pairing-client.js";

const LAN = { address: "192.168.1.5", iface: "wlp3s0" };

describe("resolveHost", () => {
  it("binds every interface when there is a LAN to serve", () => {
    expect(resolveHost(undefined, LAN)).toBe("0.0.0.0");
  });

  it("stays on loopback when there is no LAN", () => {
    expect(resolveHost(undefined, null)).toBe("127.0.0.1");
  });

  it("always honours an explicit --host", () => {
    expect(resolveHost("127.0.0.1", LAN)).toBe("127.0.0.1");
    expect(resolveHost("10.0.0.4", null)).toBe("10.0.0.4");
    expect(resolveHost("0.0.0.0", null)).toBe("0.0.0.0");
  });
});

describe("resolveLanUrl", () => {
  it("resolves a wildcard bind to the real LAN address", () => {
    expect(resolveLanUrl("0.0.0.0", 14100, LAN)).toBe(
      "http://192.168.1.5:14100",
    );
    expect(resolveLanUrl("::", 14100, LAN)).toBe("http://192.168.1.5:14100");
  });

  it("suppresses the network URL on a loopback bind", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(resolveLanUrl(host, 14100, LAN)).toBeNull();
    }
  });

  it("returns nothing for a wildcard bind with no LAN", () => {
    expect(resolveLanUrl("0.0.0.0", 14100, null)).toBeNull();
  });

  it("echoes an explicitly pinned non-loopback host", () => {
    expect(resolveLanUrl("10.0.0.4", 8080, LAN)).toBe("http://10.0.0.4:8080");
  });

  it("never produces a URL containing 0.0.0.0", () => {
    const urls = [
      resolveLanUrl("0.0.0.0", 14100, LAN),
      resolveLanUrl("0.0.0.0", 14100, null),
    ];
    for (const url of urls) expect(url ?? "").not.toContain("0.0.0.0");
  });
});

describe("rearmDecision", () => {
  const expired = () => new PairingError("expired", undefined, "expired");
  const wrongCode = () => new PairingError("nope", undefined, "no-match");
  const failed = () => new PairingError("burnt", undefined, "failed");
  const lost = () => new PairingError("gone", undefined, "lost");
  const tooMany = () =>
    new PairingError("too many", undefined, "too-many-peers");

  /** No jitter, so the backoff schedule is a fact rather than a range. */
  const fixed = { jitter: () => 1 };

  const state = (over: Partial<RearmState> = {}): RearmState => ({
    ...NO_FAILURES,
    ...over,
  });

  describe("expired — nobody ever touched the code", () => {
    it("keeps arming up to the budget, instantly", () => {
      let s = NO_FAILURES;
      for (let i = 1; i < REARM_LIMITS.expiries; i += 1) {
        const d = rearmDecision(expired(), s, fixed);
        s = d.state;
        expect(d.rearm).toBe(true);
        expect(d.state.expiries).toBe(i);
        expect(d.delayMs).toBe(0);
        expect(d.warn).toBeNull();
      }
    });

    it("stops once the budget is spent", () => {
      const d = rearmDecision(expired(), state({ expiries: 4 }), fixed);
      expect(d.rearm).toBe(false);
      expect(d.state.expiries).toBe(5);
    });

    it("spends only its own counter", () => {
      const d = rearmDecision(expired(), state({ wrong: 3, lost: 2 }), fixed);
      expect(d.state).toEqual({ expiries: 1, wrong: 3, lost: 2 });
    });
  });

  describe("wrong codes — the guessing budget", () => {
    // This is the change the whole phase exists for. The old rule read a wrong
    // code as proof that a human was there and reset the budget, so an attacker
    // sweeping the slot space collected one guess per sweep forever.
    it("never resets the expiry budget", () => {
      const d = rearmDecision(wrongCode(), state({ expiries: 4 }), fixed);
      expect(d.state.expiries).toBe(4);
    });

    it("walks the backoff schedule and then stops", () => {
      const schedule = [0, 0, 0, 5_000, 15_000, 45_000, 120_000];
      let s = NO_FAILURES;
      schedule.forEach((delayMs, i) => {
        const d = rearmDecision(wrongCode(), s, fixed);
        s = d.state;
        expect(d.state.wrong).toBe(i + 1);
        expect(d.delayMs).toBe(delayMs);
        expect(d.rearm).toBe(true);
      });
      // The eighth spends the last of the budget and arms nothing.
      const last = rearmDecision(wrongCode(), s, fixed);
      expect(last.state.wrong).toBe(REARM_LIMITS.wrong);
      expect(last.rearm).toBe(false);
    });

    it("reads as a typo for three, then as guessing", () => {
      let s = NO_FAILURES;
      const warnings: (string | null)[] = [];
      for (let i = 0; i < 5; i += 1) {
        const d = rearmDecision(wrongCode(), s, fixed);
        s = d.state;
        warnings.push(d.warn);
      }
      expect(warnings).toEqual([
        "wrong-code",
        "wrong-code",
        "wrong-code",
        "guessing",
        "guessing",
      ]);
    });

    it("charges a broker-reported failure the same as a wrong code", () => {
      // Since a burn is announced, `failed` also covers "a claim attached and
      // then vanished" — which is a spent code however it is dressed up.
      const d = rearmDecision(failed(), NO_FAILURES, fixed);
      expect(d.state.wrong).toBe(1);
      expect(d.warn).toBe("wrong-code");
    });

    it("gives the scan half a far larger budget", () => {
      // Its secret is 128 bits, so a failure there is a spin-loop guard rather
      // than a guess worth rationing.
      const d = rearmDecision(wrongCode(), state({ wrong: 7 }), {
        wrong: 20,
        ...fixed,
      });
      expect(d.rearm).toBe(true);
    });
  });

  describe("lost sockets", () => {
    it("backs off exponentially to a 30s ceiling", () => {
      let s = NO_FAILURES;
      const delays: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const d = rearmDecision(lost(), s, fixed);
        s = d.state;
        delays.push(d.delayMs);
      }
      expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    });

    it("jitters so agents do not reconnect in lockstep", () => {
      const low = rearmDecision(lost(), NO_FAILURES, { jitter: () => 0 });
      const high = rearmDecision(lost(), NO_FAILURES, { jitter: () => 1 });
      expect(low.delayMs).toBe(1_000);
      expect(high.delayMs).toBe(2_000);
    });

    it("stops after twenty", () => {
      const d = rearmDecision(lost(), state({ lost: 19 }), fixed);
      expect(d.rearm).toBe(false);
    });

    it("treats an unrecognised error as a dropped socket, not engagement", () => {
      // Fail closed: an unclassifiable error must not be a licence to keep
      // minting codes, which is what "not an expiry, so reset" used to mean.
      const d = rearmDecision(new Error("socket died"), NO_FAILURES, fixed);
      expect(d.state.lost).toBe(1);
      expect(d.state.expiries).toBe(0);
    });
  });

  it("stops dead when the broker offers too many peers", () => {
    const d = rearmDecision(tooMany(), NO_FAILURES, fixed);
    expect(d.rearm).toBe(false);
    expect(d.warn).toBe("broker-misbehaving");
  });

  it("only a completed pairing clears the budgets", () => {
    // There is no err that resets, by construction — the reset lives in
    // `startHosted`'s success path. Every failure kind spends.
    for (const err of [expired(), wrongCode(), failed(), lost()]) {
      const d = rearmDecision(
        err,
        state({ expiries: 2, wrong: 2, lost: 2 }),
        fixed,
      );
      const total = d.state.expiries + d.state.wrong + d.state.lost;
      expect(total).toBe(7);
    }
  });
});

/**
 * The connected-devices line.
 *
 * `mtmux start` went silent after the banner, so a device that dropped and a
 * device that never arrived looked the same on screen.
 */
describe("devicesOnline", () => {
  it("says nothing is connected rather than printing a zero", () => {
    expect(devicesOnline(0)).toBe("Nothing is connected now.");
  });

  it("agrees with itself about plurals", () => {
    expect(devicesOnline(1)).toBe("1 device connected.");
    expect(devicesOnline(2)).toBe("2 devices connected.");
  });
});

describe("missingFrom", () => {
  it("finds what arrived and what left", () => {
    expect(missingFrom(["a", "b"], ["a"])).toEqual(["b"]);
    expect(missingFrom(["a"], ["a", "b"])).toEqual([]);
  });

  /**
   * A set would collapse two tabs of the same browser into one entry, so
   * closing one of them would report a disconnect that did not happen.
   */
  it("counts duplicates rather than collapsing them", () => {
    expect(missingFrom(["iPhone", "iPhone"], ["iPhone"])).toEqual(["iPhone"]);
    expect(missingFrom(["iPhone", "iPhone"], ["iPhone", "iPhone"])).toEqual([]);
  });

  it("is empty for identical lists in a different order", () => {
    expect(missingFrom(["a", "b"], ["b", "a"])).toEqual([]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { makeConnectionGate } from "./start.js";

type Req = Parameters<ReturnType<typeof makeConnectionGate>["admit"]>[0];

const socket = (over: Partial<Req> = {}): Req => ({
  tokenId: "token-1",
  deviceId: "device-1",
  label: "iPhone · Safari",
  transport: "tunnel",
  userAgent: null,
  ...over,
});

afterEach(() => vi.useRealTimers());

/**
 * One question per *connection*, which is the change this gate exists to make.
 *
 * Every release before it asked once per credential, at pairing time: after
 * that a browser came and went as it liked, from any network, through the
 * tunnel, in silence. A credential is a file on somebody else's computer, and
 * "it paired once" is a fact about the past.
 *
 * The hard part is not refusing — it is refusing without turning an approved
 * device into a doorbell. These tests are that balance written down.
 */
describe("the connection gate", () => {
  it("asks about a device it has not been told about", async () => {
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("refuses when the answer is no, and says nothing more about it", async () => {
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask: async () => false,
    });
    expect(await gate.admit(socket())).toBe(false);
  });

  it("does not ask twice about one act of approval", async () => {
    // Pairing seeds this. Without it the browser is asked again the instant it
    // connects — the same question, thirty milliseconds later, which is how a
    // product teaches people to hit yes without reading.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    gate.approve("device-1");
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("collapses a burst of sockets into one question", async () => {
    // A browser is not one socket: tabs, the candidate race and a reconnect
    // storm all arrive at once, and asking about each literally would be eight
    // prompts for one act of opening a laptop.
    let settle!: (value: boolean) => void;
    const ask = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    const answers = Promise.all([
      gate.admit(socket()),
      gate.admit(socket()),
      gate.admit(socket()),
    ]);
    settle(true);
    expect(await answers).toEqual([true, true, true]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("keeps covering a device for as long as it stays connected", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => ["device-1"],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    // An hour of tabs and reconnects on a device that never went away.
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /**
   * The case every phone is, and the one the grace was getting wrong.
   *
   * A browser on a phone holds *one* socket. Nothing else arrives to re-stamp
   * the approval while it sits there, so a cover that is only refreshed when a
   * second socket turns up expires two minutes after the pairing — and the
   * next screen lock, cell handover or tab switch is a fresh prompt about a
   * device that never went anywhere. That is the "it asks every few minutes"
   * report, and it is not what `ADMIT_GRACE_MS` says it does.
   */
  it("keeps covering a lone socket that stays connected", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    let online: string[] = [];
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => online,
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    // Its socket is up now, and it is the only one it will ever open.
    online = ["device-1"];
    vi.advanceTimersByTime(60 * 60 * 1000);
    // The screen locks: the socket goes, the phone comes straight back.
    online = [];
    vi.advanceTimersByTime(5_000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks again when a device that was connected has really gone", async () => {
    // The other half of the same rule: presence is what holds the cover open,
    // so once it stops the window has to start closing.
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    let online: string[] = [];
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => online,
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    online = ["device-1"];
    vi.advanceTimersByTime(10 * 60 * 1000);
    online = [];
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  /**
   * A LAN pairing has no peer record — `pairing-local.ts` mints a device id and
   * keeps the token in memory, and nothing is written to `config.json`. So
   * `known()` says no about a device the owner approved by hand a minute ago,
   * and `trust` could not waive its reconnects: the one setting that turns the
   * prompt off did nothing for the commonest way into the product.
   */
  it("lets trust cover a device this run approved, with no peer record", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      known: () => false,
      ask,
    });
    gate.approve("device-1");
    // Long past the grace the pairing seeded, so only recognition can carry it.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("forgets a device the owner removed, approval and all", async () => {
    // A LAN pairing has no token the owner can revoke, so removing it can only
    // hang up the socket — and the credential is good for another day. The
    // approval must not be what lets it back in.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      known: () => false,
      ask,
    });
    gate.approve("device-1");
    gate.forget("device-1");
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("still asks about an approved device when the policy is confirm", async () => {
    // Recognition is not trust. It only decides whether the *policy* gets to
    // waive the question, never the question itself.
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      known: () => false,
      ask,
    });
    gate.approve("device-1");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks again once the device has been gone long enough", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    // A blip is covered…
    vi.advanceTimersByTime(60_000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // …closing the laptop and coming back later is not.
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("holds a refusal, so a device that was told no cannot ring again", async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => false);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(false);
    expect(await gate.admit(socket())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    // Briefly, though: a mistaken `n` must not lock the owner out for long.
    vi.advanceTimersByTime(20_000);
    expect(await gate.admit(socket())).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("admits without asking when the policy says to trust", async () => {
    const ask = vi.fn(async () => false);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("reads the policy at the moment a device connects, not at boot", async () => {
    // `a` on the live panel flips it without a restart, and a gate holding the
    // value it booted with would be the one control on that panel that
    // quietly does nothing.
    let asks = false;
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => asks,
      connected: () => [],
      ask,
    });
    await gate.admit(socket());
    expect(ask).not.toHaveBeenCalled();
    asks = true;
    await gate.admit(socket({ deviceId: "device-2" }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("tells them apart by device, not by socket", async () => {
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    await gate.admit(socket({ deviceId: "device-1" }));
    await gate.admit(socket({ deviceId: "device-2" }));
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("still has a key for a socket with no device behind it", async () => {
    // The machine's own bearer token has no pairing record. It is still a
    // connection, and it is still asked about.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      ask,
    });
    await gate.admit(socket({ deviceId: null, tokenId: null }));
    await gate.admit(socket({ deviceId: null, tokenId: null }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("still asks about a device it has no record of, even under trust", async () => {
    // `trust` is a *reconnect* policy. A credential this machine has never
    // issued a pairing for is not reconnecting, and this is the case the
    // setting was silently covering: a stolen token, a directToken lifted off
    // a shared laptop, a device the owner removed an hour ago.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      known: () => false,
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("lets trust waive the question for a device on the peer list", async () => {
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      known: (id) => id === "device-1",
      ask,
    });
    expect(await gate.admit(socket())).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("admits the machine's own token on loopback without asking", async () => {
    // Whoever sent it is already on the box and read it out of a 0600 file,
    // so the gate would be guarding a shell they already have — and a prompt
    // there is what breaks every headless `mtmux start` with nobody to answer.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      known: () => false,
      ask,
    });
    expect(
      await gate.admit(
        socket({ deviceId: null, tokenId: null, transport: "loopback" }),
      ),
    ).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks about the machine's token the moment it arrives from elsewhere", async () => {
    // A token copied off the machine is precisely what this gate is for, and
    // `trust` must not cover it: it names no device, so nothing about it is
    // a reconnect.
    const ask = vi.fn(async () => true);
    const gate = makeConnectionGate({
      asks: () => false,
      connected: () => [],
      known: () => false,
      ask,
    });
    expect(
      await gate.admit(
        socket({ deviceId: null, tokenId: null, transport: "lan" }),
      ),
    ).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks under the name the owner gave it", async () => {
    const named: string[] = [];
    const gate = makeConnectionGate({
      asks: () => true,
      connected: () => [],
      nameFor: () => "Work phone",
      ask: async (_req, name) => {
        named.push(name);
        return true;
      },
    });
    await gate.admit(socket());
    expect(named).toEqual(["Work phone"]);
  });
});

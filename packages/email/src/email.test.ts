import { afterEach, describe, expect, it, vi } from "vitest";

import { escapeHtml, oneLine } from "./render.js";
import {
  magicLinkEmail,
  passwordResetEmail,
  verificationEmail,
} from "./templates.js";
import { createMailer } from "./mailer.js";

const ALL = [verificationEmail, passwordResetEmail, magicLinkEmail];

describe("escaping", () => {
  it("neutralises the characters that start markup", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("collapses a display name to one line", () => {
    expect(oneLine("  Ada \n Lovelace  ")).toBe("Ada Lovelace");
    expect(oneLine("x".repeat(100))).toHaveLength(64);
  });
});

/**
 * The injection test.
 *
 * A display name is chosen at sign-up, before the address is verified — so the
 * person who types it and the person who receives the mail need not be the
 * same. An unescaped name is therefore a live HTML injection into somebody
 * else's inbox, not a theoretical one.
 */
describe("a hostile display name", () => {
  const HOSTILE = `<img src=x onerror="alert(1)"><script>steal()</script>`;

  for (const template of ALL) {
    it(`is inert in ${template.name}`, () => {
      const mail = template({
        name: HOSTILE,
        url: "https://api.mtmux.com/api/auth/verify?token=abc",
        expiresInMinutes: 60,
      });

      expect(mail.html).not.toContain("<img");
      expect(mail.html).not.toContain("<script");
      // The substring `onerror=` survives — as text. What must not survive is
      // an attribute, which needs a real quote character after the `=`.
      expect(mail.html).not.toContain('onerror="');
      // It is still *present*, just as text — dropping it silently would be a
      // different bug.
      expect(mail.html).toContain("&lt;img src=x");
    });
  }

  it("cannot fake a second paragraph in the plain-text part", () => {
    const mail = magicLinkEmail({
      name: "Ada\n\nYour account was closed. Reply with your password.",
      url: "https://example.test/x",
      expiresInMinutes: 5,
    });
    expect(mail.text).toContain(
      "Hi Ada Your account was closed. Reply with your password.,",
    );
    expect(mail.text.split("\n")[0]).toBe("Sign in to mtmux");
  });
});

describe("every template", () => {
  for (const template of ALL) {
    it(`${template.name} has a subject, both parts, and the link in each`, () => {
      const url = "https://api.mtmux.com/api/auth/magic-link/verify?token=xyz";
      const mail = template({ name: "Ada", url, expiresInMinutes: 5 });

      expect(mail.subject).not.toBe("");
      expect(mail.html).toContain("<!doctype html>");
      // `text:` alongside `html:` is not optional — see the module header.
      expect(mail.text).not.toBe("");
      expect(mail.html).toContain(url.replace(/&/g, "&amp;"));
      expect(mail.text).toContain(url);
      expect(mail.text).toContain("expires in 5 minutes");
      // No network assets: nothing to block, and nothing that works as a read
      // receipt.
      expect(mail.html).not.toMatch(/<img\s/i);
    });
  }

  it("omits the greeting entirely when there is no name", () => {
    const mail = verificationEmail({
      name: "   ",
      url: "https://example.test/x",
      expiresInMinutes: 60,
    });
    expect(mail.text).not.toContain("Hi ,");
    expect(mail.html).not.toContain("Hi ");
  });

  it("says hours once past sixty minutes", () => {
    const mail = passwordResetEmail({
      name: null,
      url: "https://example.test/x",
      expiresInMinutes: 60,
    });
    expect(mail.text).toContain("expires in 1 hour.");
  });
});

describe("createMailer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null with no API key, exactly like createDodoClient", () => {
    expect(createMailer({ apiKey: "", from: "mtmux <a@b.test>" })).toBeNull();
    expect(createMailer({ apiKey: "re_x", from: "" })).toBeNull();
  });

  it("posts both parts to Resend", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const mailer = createMailer({
      apiKey: "re_test",
      from: "mtmux <hello@mtmux.test>",
      replyTo: "help@mtmux.test",
    });
    const result = await mailer?.send(
      "someone@example.test",
      verificationEmail({
        name: "Ada",
        url: "https://example.test/v",
        expiresInMinutes: 60,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.to).toEqual(["someone@example.test"]);
    expect(body.from).toBe("mtmux <hello@mtmux.test>");
    expect(body.reply_to).toBe("help@mtmux.test");
    expect(typeof body.html).toBe("string");
    expect(typeof body.text).toBe("string");
    expect(init.headers.Authorization).toBe("Bearer re_test");
  });

  /**
   * The whole reason this module exists in this shape. If a send can throw,
   * a missing key or a provider outage becomes a 500 on sign-up.
   */
  it("never throws — a refused send is a value, not an exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 422 })),
    );
    const mailer = createMailer({ apiKey: "re_test", from: "a@b.test" });
    const refused = await mailer?.send(
      "x@example.test",
      magicLinkEmail({ url: "https://x.test", expiresInMinutes: 5 }),
    );
    expect(refused).toMatchObject({ ok: false });

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const failed = await mailer?.send(
      "x@example.test",
      magicLinkEmail({ url: "https://x.test", expiresInMinutes: 5 }),
    );
    expect(failed).toMatchObject({ ok: false });
  });
});

import { describe, expect, it } from "vitest";

import { buildShareCommand } from "./share-command";

const base = {
  session: "work",
  readOnly: false,
  files: "none" as const,
  expires: "7d",
};

describe("buildShareCommand", () => {
  it("omits every flag that is already the default", () => {
    // The command people copy most often should be the short one, or they
    // learn to distrust what the dialog produces.
    expect(buildShareCommand(base)).toBe("mtmux share work");
  });

  it("adds the flags that are not defaults", () => {
    expect(
      buildShareCommand({
        ...base,
        readOnly: true,
        files: "ro",
        expires: "24h",
      }),
    ).toBe("mtmux share work --read-only --files ro --expires 24h");
  });

  it("quotes a session name the shell would mangle", () => {
    // Session names allow spaces; pasting `mtmux share my project` would
    // silently share a session called "my".
    expect(buildShareCommand({ ...base, session: "my project" })).toBe(
      "mtmux share 'my project'",
    );
    expect(buildShareCommand({ ...base, session: "a;rm -rf ~" })).toBe(
      "mtmux share 'a;rm -rf ~'",
    );
  });

  it("escapes a single quote rather than closing the quoting early", () => {
    // The POSIX idiom: close the quote, emit an escaped one, reopen. A
    // backslash inside single quotes is a literal backslash, so the obvious
    // \' would produce a different session name rather than an error.
    expect(buildShareCommand({ ...base, session: "it's" })).toBe(
      `mtmux share 'it'\\''s'`,
    );
  });

  it("leaves a comma-separated list unquoted", () => {
    expect(buildShareCommand({ ...base, session: "work,logs" })).toBe(
      "mtmux share work,logs",
    );
  });

  it("shows a placeholder rather than a broken command when empty", () => {
    expect(buildShareCommand({ ...base, session: "   " })).toBe(
      "mtmux share <session>",
    );
  });
});

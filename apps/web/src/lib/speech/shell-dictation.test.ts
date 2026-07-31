import { describe, it, expect } from "vitest";
import {
  dictationToShell,
  repairCommand,
  splitQuoted,
  toShell,
} from "./shell-dictation";

describe("the spoken vocabulary", () => {
  const cases: [string, string][] = [
    ["git checkout dash b feature", "git checkout -b feature"],
    ["git checkout double dash force", "git checkout --force"],
    ["cd slash var slash log", "cd /var/log"],
    ["ls dash la pipe grep foo", "ls -la | grep foo"],
    ["echo dollar home", "echo $home"],
    ["cd tilde slash projects", "cd ~/projects"],
    [
      "npm run build ampersand ampersand npm test",
      "npm run build & & npm test",
    ],
  ];
  for (const [spoken, expected] of cases) {
    it(`"${spoken}" → ${expected}`, () => {
      expect(toShell(spoken)).toBe(expected);
    });
  }
});

describe("whole tokens only", () => {
  it("never rewrites a word that merely contains one", () => {
    // Substring replacement is the obvious implementation and it is wrong:
    // `pipeline` becomes `|line`, `dashboard` becomes `-board`.
    expect(toShell("run the pipeline")).toBe("run the pipeline");
    expect(toShell("open the dashboard")).toBe("open the dashboard");
    expect(toShell("slashdot")).toBe("slashdot");
    expect(toShell("attitude")).toBe("attitude");
  });
});

describe("quoted regions are inert", () => {
  it("leaves the word alone inside a commit message", () => {
    // The message is a sentence about slashes; the word belongs in it.
    expect(toShell('git commit -m "add slash remove"')).toBe(
      'git commit -m "add slash remove"',
    );
  });

  it("still transforms outside the quotes", () => {
    expect(toShell('git commit dash m "a dash b"')).toBe(
      'git commit -m "a dash b"',
    );
  });

  it("treats an unterminated quote as running to the end", () => {
    expect(toShell('echo "dash and slash')).toBe('echo "dash and slash');
  });

  it("splits runs the way a shell would read them", () => {
    expect(splitQuoted('a "b" c')).toEqual([
      { text: "a ", quoted: false },
      { text: '"b"', quoted: true },
      { text: " c", quoted: false },
    ]);
  });
});

describe("escape hatches", () => {
  it("`literally <word>` yields the word", () => {
    expect(toShell("echo literally slash")).toBe("echo slash");
  });

  it("`spell` assembles single letters", () => {
    expect(toShell("spell l s dash la")).toBe("ls -la");
  });
});

describe("command repair", () => {
  it("fixes the first token only", () => {
    // `them` → `vim` is safe as a command and catastrophic as a word.
    expect(repairCommand("them notes.txt")).toBe("vim notes.txt");
    expect(repairCommand("echo tell them about it")).toBe(
      "echo tell them about it",
    );
  });

  it("leaves an unrecognised command alone", () => {
    expect(repairCommand("kubectl get pods")).toBe("kubectl get pods");
  });
});

describe("faithfulness", () => {
  it("transcribes something catastrophic exactly as it was said", () => {
    // The transform is faithful even when the utterance is a disaster — which
    // is precisely why nothing in this feature auto-executes. The Send button
    // is the only thing that runs anything, and the text is on screen first.
    expect(dictationToShell("rm dash rf slash")).toBe("rm -rf /");
  });
});

describe("idempotence", () => {
  it("is a no-op on its own output", () => {
    const inputs = [
      "git checkout dash b feature slash login",
      "cd slash etc",
      'git commit dash m "a message"',
      "ls dash la pipe grep foo",
      "run the pipeline",
      "spell l s",
    ];
    for (const input of inputs) {
      const once = dictationToShell(input);
      expect(dictationToShell(once)).toBe(once);
    }
  });
});

describe("newline is deliberately absent", () => {
  it("does not turn a spoken newline into one", () => {
    // A newline in a shell command means "run it", and nothing dictated is
    // allowed to submit itself.
    expect(toShell("echo hi newline")).toBe("echo hi newline");
    expect(toShell("echo hi newline")).not.toContain("\n");
  });
});

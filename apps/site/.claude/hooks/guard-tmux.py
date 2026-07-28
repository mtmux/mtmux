#!/usr/bin/env python3
"""Deny Bash commands that aim destructive tmux verbs at the default socket.

Reads the PreToolUse hook payload on stdin, writes a permission decision on
stdout. Silent (exit 0, no output) for anything that isn't a bare tmux command,
so it stays out of the way of normal work.
"""
import json
import re
import shlex
import sys

# Verbs that either destroy state or hijack a terminal. `new-session` is absent
# on purpose: creating a session on the default socket is harmless.
DESTRUCTIVE = {
    "kill-server", "kill-session", "kill-window", "kill-pane",
    "attach", "attach-session",
    "respawn-pane", "respawn-window",
    "send-keys", "source-file",
}

# Splits a shell line into separate commands. tmux invocations are checked one
# at a time so `cd foo && tmux kill-server` is still caught.
SEPARATORS = re.compile(r"(?:\|\||&&|[;|\n&])")


def socket_is_explicit(tokens):
    """True if this invocation names a socket that isn't the default one."""
    for i, tok in enumerate(tokens):
        if tok in ("-L", "-S"):
            target = tokens[i + 1] if i + 1 < len(tokens) else ""
            # -S pointed straight back at the default socket is not isolation.
            return not re.search(r"tmux-[^/]*/default$", target)
        if tok.startswith("-L") or tok.startswith("-S"):
            return not re.search(r"tmux-[^/]*/default$", tok[2:])
    return False


def offending_verb(segment):
    try:
        tokens = shlex.split(segment)
    except ValueError:
        tokens = segment.split()
    if not tokens:
        return None

    # Find the tmux binary, skipping wrappers like `sudo` or `timeout 5`.
    for i, tok in enumerate(tokens):
        if tok == "tmux" or tok.endswith("/tmux"):
            tokens = tokens[i:]
            break
    else:
        return None

    if socket_is_explicit(tokens):
        return None

    for tok in tokens[1:]:
        if tok in DESTRUCTIVE:
            return tok
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return 0

    command = (payload.get("tool_input") or {}).get("command") or ""
    if "tmux" not in command:
        return 0

    reasons = []

    for segment in SEPARATORS.split(command):
        verb = offending_verb(segment)
        if verb:
            reasons.append(
                f"`tmux {verb}` with no -L/-S targets the default socket, "
                f"where the user's live agent sessions run."
            )
            break

    if re.search(r"\brm\b[^\n;|&]*/tmp/tmux-", command):
        reasons.append(
            "Removing anything under /tmp/tmux-* deletes a live server's socket."
        )

    if not reasons:
        return 0

    reason = " ".join(reasons) + (
        " Scope it to a throwaway socket instead: "
        "`tmux -L scratch <command>`, and `tmux -L scratch kill-server` to clean up. "
        "See CLAUDE.md > 'Read this before you run tmux'."
    )

    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

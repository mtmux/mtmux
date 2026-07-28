#!/usr/bin/env bash
# PreToolUse/Bash guard: block tmux commands that would hit the default socket.
#
# This box runs long-lived tmux sessions driving real agents. On 2026-07-27 a
# subagent verifying tmux error strings ran `tmux kill-server` and destroyed the
# user's live `ai-agents` session. Agents working on this repo have a standing
# reason to run tmux, so the rule is enforced here rather than left to docs.
#
# Allowed:  tmux -L scratch kill-server     (scoped to a throwaway socket)
# Blocked:  tmux kill-server                (hits whatever the user is running)
exec python3 "$(dirname "$0")/guard-tmux.py"

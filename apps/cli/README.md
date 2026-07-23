# tmuxremote

> Your tmux, in any browser.

Self-hosted browser terminal for [tmux](https://github.com/tmux/tmux). Works great with [Claude Code](https://www.anthropic.com/claude-code), Vim, REPLs, long-running jobs — anything you'd run in tmux.

## Quick start

```bash
npm install -g tmuxremote
tmuxremote start
```

That's it. The CLI generates a token, opens your browser, and connects you to tmux on the same machine. No config file, no docker, no reverse proxy.

## Requirements

- **Node 22+**
- **tmux** on PATH (`brew install tmux` / `apt install tmux`)

## Commands

```bash
tmuxremote start                       # bind to 127.0.0.1:14100
tmuxremote start --port 9000           # custom port
tmuxremote start --host 0.0.0.0        # listen on all interfaces (LAN access)
tmuxremote start --no-open             # don't open the browser
tmuxremote start --token <value>       # one-shot token override

tmuxremote token print                 # show current token
tmuxremote token rotate                # generate a new one
tmuxremote token set <value>           # set a specific token

tmuxremote version
```

The token lives at `~/.tmuxremote/config.json` (mode 600).

## Accessing from another device

By default `tmuxremote` binds to `127.0.0.1` for safety. To open it to your LAN:

```bash
tmuxremote start --host 0.0.0.0
```

For internet access, put it behind a reverse proxy with TLS — `wss://` is required when the page is served over `https://`.

## Source

[github.com/GagnDeep/tmuxremote](https://github.com/GagnDeep/tmuxremote) — issues and PRs welcome.

## What you get in the browser

- Full tmux: sessions, windows, panes, copy mode, resize
- File browser with inline editor (Monaco)
- xterm.js with WebGL rendering, search, Unicode 11
- Mobile-friendly: virtual keyboard toolbar, swipe between sessions, pinch-zoom

## License

[MIT](./LICENSE)

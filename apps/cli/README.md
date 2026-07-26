# mtmux

> Your tmux, in any browser.

Self-hosted browser terminal for [tmux](https://github.com/tmux/tmux). Works great with [Claude Code](https://www.anthropic.com/claude-code), Vim, REPLs, long-running jobs — anything you'd run in tmux.

## Quick start

```bash
npm install -g mtmux
mtmux start
```

That's it. The CLI generates a token, opens your browser, and connects you to tmux on the same machine. No config file, no docker, no reverse proxy.

## Requirements

- **Node 22+**
- **tmux** on PATH (`brew install tmux` / `apt install tmux`)

## Commands

```bash
mtmux start                       # bind to 127.0.0.1:14100
mtmux start --port 9000           # custom port
mtmux start --host 0.0.0.0        # listen on all interfaces (LAN access)
mtmux start --no-open             # don't open the browser
mtmux start --token <value>       # one-shot token override

mtmux token print                 # show current token
mtmux token rotate                # generate a new one
mtmux token set <value>           # set a specific token

mtmux version
```

The token lives at `~/.mtmux/config.json` (mode 600).

## Accessing from another device

By default `mtmux` binds to `127.0.0.1` for safety. To open it to your LAN:

```bash
mtmux start --host 0.0.0.0
```

For internet access, put it behind a reverse proxy with TLS — `wss://` is required when the page is served over `https://`.

## What you get in the browser

- Full tmux: sessions, windows, panes, copy mode, resize
- File browser with inline editor (Monaco)
- xterm.js with WebGL rendering, search, Unicode 11
- Mobile-friendly: virtual keyboard toolbar, swipe between sessions, pinch-zoom

## Known issues

- **Only part of each line is visible on some HiDPI screens.** The WebGL
  renderer can mis-scale cells by the device pixel ratio, hiding everything past
  the first `columns ÷ DPR`. Turn off **Settings → Terminal → GPU Rendering** and
  reload; the terminal then renders correctly at any DPR.

## Renamed from `tmuxremote`

This package was published as `tmuxremote` up to 0.1.1. Upgrading picks up your
existing token from `~/.tmuxremote/config.json` automatically, so bookmarked
login URLs keep working. Uninstall the old package to avoid two copies:

```bash
npm uninstall -g tmuxremote && npm install -g mtmux
```

## Source

[github.com/GagnDeep/tmuxremote](https://github.com/GagnDeep/tmuxremote) — issues and PRs welcome.

## License

[MIT](./LICENSE)

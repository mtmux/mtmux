# ccremote

> Your Claude. Your terminal. Anywhere.

Self-hosted browser terminal for [Claude Code](https://www.anthropic.com/claude-code).

```bash
npm install -g ccremote
ccremote start
```

Auto-generates a token, opens your browser, connects you to tmux. That's it.

## Commands

```bash
ccremote start [--port 14100] [--host 127.0.0.1] [--token …] [--no-open]
ccremote token print|rotate|set <value>
ccremote version
```

## Requirements

- Node 22+
- tmux installed and on PATH

## Docs

Full documentation at **[ccremote.dev](https://ccremote.dev)**.

## License

MIT

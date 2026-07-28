# Contributing to mtmux

Thanks for your interest in contributing to mtmux. This guide will help you get started.

## Prerequisites

- **Node.js** 22 or later
- **pnpm** 9 or later
- **tmux** installed and available on your PATH

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/<your-username>/tmuxremote.git
   cd tmuxremote
   ```

2. Install dependencies and set up the project:

   ```bash
   pnpm setup
   ```

   This runs `pnpm install` and creates a `.env` file from the template.

3. Start development:

   ```bash
   pnpm dev
   ```

4. Open `http://localhost:14100`. Web and relay share that one port — the same
   layout `mtmux start` ships — with the relay WebSocket at `/_relay`. The
   startup banner prints a login URL containing the dev token.

   Use `pnpm dev:split` if you need the split web (`14100`) + relay (`14300`)
   model that the Docker and PM2 deployments use, `pnpm dev:pairing` for the
   hosted-pairing topology with the broker included, and `pnpm dev:docs` for the
   docs site (`14102`).

## Pull Request Process

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

2. Make your changes and ensure they pass checks:

   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

3. Commit using **conventional commits** (see below).

4. Push your branch and open a pull request against `main`.

5. Fill out the PR template and wait for review.

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

**Types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`

**Scopes** — enforced by `commitlint.config.js`, so anything else fails the
commit hook:

`cli`, `web`, `docs`, `relay`, `api`, `protocol`, `crypto`, `ui`, `config`,
`logger`, `infra`, `ci`, `deps`

The scope is optional; when present it must be one of those.

Examples:

```
feat(cli): add mtmux doctor
fix(relay): handle disconnection during PTY resize
feat(crypto): bind the slot into the CPace channel identifier
chore(deps): upgrade to Next.js 16
docs: update setup instructions
```

## Code Style

- **TypeScript** throughout; strict mode enabled.
- **ESM only** (`type: "module"` in all packages). Use `.js` extensions for local imports.
- **Tailwind CSS** with semantic classes (`bg-background`, `text-foreground`). Never use raw color utilities.
- Run `pnpm lint` to check formatting and linting rules before committing.
- Internal packages use the `@repo/*` namespace; apps use `@app/*`.

## Project Structure

See `CLAUDE.md` for a detailed overview of the repository layout, key commands, and architectural patterns.

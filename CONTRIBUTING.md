# Contributing to ccremote

Thanks for your interest in contributing to ccremote. This guide will help you get started.

## Prerequisites

- **Node.js** 22 or later
- **pnpm** 9 or later
- **tmux** installed and available on your PATH

## Getting Started

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/<your-username>/ccremote.git
   cd ccremote
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

4. Open the web client at `http://localhost:14100` and the relay server runs on port `14300`.

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

**Scopes:** `web`, `relay`, `docs`, `protocol`, `ui`, `config`, `logger`, `infra`, `ci`

Examples:

```
feat(web): add session search filter
fix(relay): handle disconnection during PTY resize
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

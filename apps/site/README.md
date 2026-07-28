# @app/site — mtmux.com

The marketing site, docs and blog for **mtmux**. Next.js 16 (App Router, Turbopack), Tailwind
CSS v4, shadcn/ui on Base UI, next-intl, and an MDX blog. Every route is prerendered.

## Develop

From the repo root:

```bash
pnpm install
pnpm --filter @app/site dev      # http://localhost:14101
```

Or from this directory: `pnpm dev`.

## Verify

```bash
pnpm --filter @app/site typecheck
pnpm --filter @app/site lint
pnpm --filter @app/site build     # every route must be ● (SSG), never ƒ (Dynamic)
pnpm --filter @app/site verify    # all three
```

A route that builds as `ƒ (Dynamic)` has lost static rendering — almost always a missing
`setRequestLocale`.

## Deploy

Production is PM2 app **`mtmux-web`** on port **41317**, defined in the repo root's
`ecosystem.config.cjs` and fronted by nginx for `mtmux.com`. See
`.claude/skills/deploy-site/SKILL.md` for the full procedure.

## Conventions

`CLAUDE.md` is the contract for this package: design tokens (no hardcoded colours), i18n,
SEO/metadata rules, and project layout. `AGENT.md` is the short version. Repeatable jobs live in
`.claude/skills/` — `add-page`, `add-blog-post`, `add-language`, `retheme-site`, `deploy-site`.

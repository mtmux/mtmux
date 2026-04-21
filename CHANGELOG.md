# Changelog

All notable changes to ccremote are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Reverse-proxy configs shipped in-repo.** New `nginx/` directory with
  `ccremote.conf.example` for standalone-host deployments and
  `nginx/docker/*` for the Docker sidecar variant. See `nginx/README.md`.
- **Docker sidecar profile.** `docker compose -f docker-compose.prod.yml
  --profile nginx up -d` now brings up web + relay + docs behind an nginx
  reverse proxy. TLS is bring-your-own-cert (documented certbot path).
- **Docs app in production story.** New `docker/Dockerfile.docs`,
  `docs` service in both `docker-compose.yml` and `docker-compose.prod.yml`,
  plus a `docs` entry in `ecosystem.config.cjs` for PM2 deployments.
- **Production safety guard.** The relay server now refuses to boot when
  `NODE_ENV=production` and `AUTH_TOKEN` is empty or the default sentinel
  `change-me-in-production`. Generate a real token with
  `openssl rand -hex 32`.
- **PM2 ecosystem polish.** Log files under `logs/`, `max_memory_restart`
  per app, cluster mode for web, `wait_ready`/`kill_timeout` on relay,
  `env_file` preload, `env_production` common block.
- `CHANGELOG.md` (this file).

### Changed
- **`.env.example`** rewritten into sectioned, commented template: Relay,
  Web, Docs, Reverse Proxy. Documents required-vs-optional, production
  guidance, and the `openssl rand -hex 32` token-generation command.
- **`Dockerfile.web`** pins `pnpm@9.15.4` (matches `Dockerfile.relay`),
  replaces `pnpm add -g turbo` with `pnpm dlx turbo@2.3.3 prune` for
  reproducible builds, and adds a `HEALTHCHECK` directive.
- **`apps/web/next.config.ts`** and **`apps/docs/next.config.ts`** set
  `output: "standalone"` so the Docker images can ship the standalone Next
  build artifacts.
- **`README.md`** — Docker-deploy flow now shows the full `cp .env.example
  → openssl rand → compose up` path; new "Deploy with nginx + TLS" section
  links the in-repo nginx configs.
- **Docs** — `deployment.mdx` nginx example rewritten to match the shipped
  `nginx/ccremote.conf.example`; `self-hosting.mdx` gains a
  "Bundled nginx sidecar" section.

### Removed
- `apps/admin/` — orphaned directory that only contained a stale `.next/`
  build artifact. Not referenced anywhere in the build graph.

[Unreleased]: https://github.com/nicholasgriffintn/ccremote/compare/HEAD...HEAD

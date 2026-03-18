#!/usr/bin/env bash
set -euo pipefail

echo "Resetting database..."

# Force reset
pnpm db:push -- --force-reset

# Re-seed
pnpm db:seed

echo "Database reset complete!"

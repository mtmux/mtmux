#!/usr/bin/env bash
set -euo pipefail

echo "Starting dev environment..."

# Start Docker services
docker compose up -d
echo "Docker services started (Temporal, MinIO)"

# Wait for services
echo "Waiting for services to be ready..."
sleep 5

# Start dev servers
echo "Starting dev servers..."
pnpm dev

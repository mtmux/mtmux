#!/usr/bin/env bash
set -euo pipefail

echo "Setting up Monorepo Starter..."

# Copy env file if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
fi

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Generate Prisma client
echo "Generating Prisma client..."
pnpm db:generate

# Push database schema
echo "Pushing database schema..."
pnpm db:push

# Seed database
echo "Seeding database..."
pnpm db:seed

echo "Setup complete! Run 'pnpm dev' to start development."

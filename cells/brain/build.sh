#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @localdot/brain build
docker build -t localdot/brain:dev .

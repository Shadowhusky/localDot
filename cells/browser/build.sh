#!/usr/bin/env bash
# Bundles browserd, then builds localdot/browser:dev on top of localdot/desktop:dev.
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @localdot/browserd build
docker build -f Dockerfile -t localdot/browser:dev ../..

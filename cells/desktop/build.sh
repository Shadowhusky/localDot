#!/usr/bin/env bash
# Bundles desktopd, then builds localdot/desktop:dev for the host architecture.
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @localdot/desktopd build
docker build --target desktop -t localdot/desktop:dev .

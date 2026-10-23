#!/usr/bin/env bash
# Bundles browserd, then builds localdot/browser:dev on top of localdot/desktop:dev.
# Set INSTALL_CHROME=1 to add Google Chrome from Google's apt repo (you accept Google's terms);
# browserd then prefers it over Chromium. The distributed image leaves it unset.
set -euo pipefail
cd "$(dirname "$0")"
pnpm --filter @localdot/browserd build
docker build -f Dockerfile --build-arg INSTALL_CHROME="${INSTALL_CHROME:-}" -t localdot/browser:dev ../..

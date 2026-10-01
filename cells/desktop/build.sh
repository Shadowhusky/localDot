#!/usr/bin/env bash
# Builds localdot/desktop:dev for the host architecture (arm64 on Apple silicon).
set -euo pipefail
cd "$(dirname "$0")"
docker build --target desktop -t localdot/desktop:dev .

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
../../cells/desktop/scripts/extract-selkies-client.sh "$PWD/client"

#!/usr/bin/env bash
# Builds ldgate for the Docker engine's Linux architecture, then localdot/gate:dev.
set -euo pipefail
cd "$(dirname "$0")"
arch="$(docker version --format '{{.Server.Arch}}')"
(cd ../../keyd && CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -o ../cells/gate/dist/ldgate ./cmd/ldgate)
docker build -t localdot/gate:dev .

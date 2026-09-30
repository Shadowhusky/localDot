#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
V=0.52.0
base="https://github.com/paradigmxyz/iron-proxy/releases/download/v${V}"
curl -fsSL -o bin/iron-proxy.tgz "${base}/iron-proxy_${V}_darwin_arm64.tar.gz"
curl -fsSL -o bin/checksums.txt "${base}/checksums.txt"
(cd bin && grep "darwin_arm64.tar.gz" checksums.txt | sed "s/iron-proxy_${V}_darwin_arm64.tar.gz/iron-proxy.tgz/" | shasum -a 256 -c -)
tar -xzf bin/iron-proxy.tgz -C bin
bin/iron-proxy --version || bin/iron-proxy version

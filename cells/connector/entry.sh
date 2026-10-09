#!/bin/sh
# Trusts keyd's authority for this cell as well as the web's, then runs the program. The certificate
# arrives in the environment and is taken out of it here.
set -eu
umask 077
mkdir -p "$HOME"
printf '%s\n' "${LOCALDOT_CA_PEM:?}" > "$HOME/.keyd-ca.pem"
cat /etc/ssl/certs/ca-certificates.crt "$HOME/.keyd-ca.pem" > "$HOME/.ca-bundle.pem"
unset LOCALDOT_CA_PEM
export NODE_EXTRA_CA_CERTS="$HOME/.keyd-ca.pem" \
  SSL_CERT_FILE="$HOME/.ca-bundle.pem" \
  REQUESTS_CA_BUNDLE="$HOME/.ca-bundle.pem" \
  CURL_CA_BUNDLE="$HOME/.ca-bundle.pem" \
  UV_NATIVE_TLS=1 \
  UV_CACHE_DIR="$HOME/.cache/uv" \
  npm_config_cache="$HOME/.npm" \
  npm_config_update_notifier=false \
  npm_config_fund=false
exec "$@"

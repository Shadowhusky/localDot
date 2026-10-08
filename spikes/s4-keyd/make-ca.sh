#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
cat > out/ca.cnf <<'EOF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = localDot cell CA (spike)
[v3_ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
nameConstraints = critical,permitted;DNS:postman-echo.com,permitted;DNS:api.anthropic.com
subjectKeyIdentifier = hash
EOF
openssl ecparam -name prime256v1 -genkey -noout -out out/ca.key
openssl req -new -x509 -key out/ca.key -out out/ca.crt -days 1 -config out/ca.cnf
openssl x509 -in out/ca.crt -noout -text | grep -A3 "Name Constraints"

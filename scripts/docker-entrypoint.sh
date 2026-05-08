#!/usr/bin/env sh
set -eu

mkdir -p /app/runtime

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/runtime
  extra_ca_path="${EXTRA_CA_CERT_PATH:-/app/runtime/extra-ca.crt}"
  if [ -f "$extra_ca_path" ]; then
    cp "$extra_ca_path" /usr/local/share/ca-certificates/instructor-extra-ca.crt
    chmod 0644 /usr/local/share/ca-certificates/instructor-extra-ca.crt
    update-ca-certificates >/dev/null
  fi
  exec gosu node "$@"
fi

exec "$@"

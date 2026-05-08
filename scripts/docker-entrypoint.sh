#!/usr/bin/env sh
set -eu

mkdir -p /app/runtime

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/runtime
  exec gosu node "$@"
fi

exec "$@"

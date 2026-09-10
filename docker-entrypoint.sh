#!/bin/sh
set -eu

# Named volumes are commonly created root-owned. Prepare only writable runtime
# roots; /config may be a read-only single-file bind mount.
for path in /data /workspace; do
  mkdir -p "$path"
  chown -R porta:porta "$path"
done

if [ ! -r "${PORTA_CONFIG:-/config/porta.json}" ]; then
  echo "Porta configuration is missing: ${PORTA_CONFIG:-/config/porta.json}" >&2
  exit 1
fi

case " $* " in *" --network "*) export PORTA_NETWORK=1 ;; esac
exec su porta -s /bin/sh -c 'exec node /app/dist/src/main-web.js "$@"' -- "$@"

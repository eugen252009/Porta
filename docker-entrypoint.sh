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

# Docker file secrets are commonly mounted root-owned. Copy only the Codex
# credential needed by Porta into /run, preserving a strict UID-owned mode.
if [ -r /run/secrets/openai-codex.json ]; then
  rm -rf /run/porta-auth
  mkdir -m 700 /run/porta-auth
  chown porta:porta /run/porta-auth
  install -o porta -g porta -m 600 /run/secrets/openai-codex.json /run/porta-auth/openai-codex.json
  export PORTA_AUTH_DIR=/run/porta-auth
fi

case " $* " in *" --network "*) export PORTA_NETWORK=1 ;; esac
exec su porta -s /bin/sh -c 'exec node /app/dist/src/main-web.js "$@"' -- "$@"

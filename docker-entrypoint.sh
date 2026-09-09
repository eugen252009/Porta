#!/bin/sh
set -eu
# Mounted directories do not inherit image ownership; prepare only the configured runtime roots.
for path in /config /data /workspaces; do
  mkdir -p "$path"
  chown -R porta:porta "$path"
done
case " $* " in *" --network "*) export PORTA_NETWORK=1 ;; esac
exec su porta -s /bin/sh -c 'exec node /app/dist/src/main-web.js "$@"' -- "$@"

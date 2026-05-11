#!/bin/sh
set -eu

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

SHEETS_WEBAPP_URL_ESCAPED="$(json_escape "${SHEETS_WEBAPP_URL:-}")"
SHEETS_TOKEN_ESCAPED="$(json_escape "${SHEETS_TOKEN:-}")"

cat > /srv/config.js <<EOF
globalThis.__BUYADS_CONFIG__={"sheetsWebappUrl":"$SHEETS_WEBAPP_URL_ESCAPED","sheetsToken":"$SHEETS_TOKEN_ESCAPED"};
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

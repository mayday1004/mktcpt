#!/bin/sh
set -eu

# 先把可選 env vars 補預設,避免 set -u 在後面 `${#VAR}` 之類用法 unbound 直接炸 container
SHEETS_WEBAPP_URL="${SHEETS_WEBAPP_URL:-}"
SHEETS_TOKEN="${SHEETS_TOKEN:-}"
YOURLS_WAKE_URL="${YOURLS_WAKE_URL:-}"
YOURLS_WAKE_TOKEN="${YOURLS_WAKE_TOKEN:-}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

SHEETS_WEBAPP_URL_ESCAPED="$(json_escape "$SHEETS_WEBAPP_URL")"
SHEETS_TOKEN_ESCAPED="$(json_escape "$SHEETS_TOKEN")"
YOURLS_WAKE_URL_ESCAPED="$(json_escape "$YOURLS_WAKE_URL")"
YOURLS_WAKE_TOKEN_ESCAPED="$(json_escape "$YOURLS_WAKE_TOKEN")"

# Debug:把容器拿到的 env 印到 stderr,Railway logs 看得到。
# (URL 印完整、TOKEN 只印前 6 字 + 長度,避免 leak)
echo "[entrypoint] SHEETS_WEBAPP_URL = '${SHEETS_WEBAPP_URL:-(unset)}'" >&2
echo "[entrypoint] SHEETS_TOKEN     = '$(printf '%s' "$SHEETS_TOKEN" | cut -c1-6)...' (length=${#SHEETS_TOKEN})" >&2
echo "[entrypoint] YOURLS_WAKE_URL = '${YOURLS_WAKE_URL:-(unset)}'" >&2
echo "[entrypoint] YOURLS_WAKE_TOKEN = '$(printf '%s' "$YOURLS_WAKE_TOKEN" | cut -c1-6)...' (length=${#YOURLS_WAKE_TOKEN})" >&2

cat > /srv/config.js <<EOF
globalThis.__BUYADS_CONFIG__={"sheetsWebappUrl":"$SHEETS_WEBAPP_URL_ESCAPED","sheetsToken":"$SHEETS_TOKEN_ESCAPED","yourlsWakeUrl":"$YOURLS_WAKE_URL_ESCAPED","yourlsWakeToken":"$YOURLS_WAKE_TOKEN_ESCAPED"};
EOF

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

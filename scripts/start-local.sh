#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_DIR="${ROOT_DIR}/apps/gateway"
GATEWAY_PORT="${GATEWAY_PORT:-8787}"
APPLY_MIGRATIONS="${APPLY_MIGRATIONS:-1}"

log() {
  printf '[local] %s\n' "$*"
}

ensure_dev_var() {
  local name="$1"
  local value="$2"
  local file="${GATEWAY_DIR}/.dev.vars"
  if ! grep -q "^${name}=" "$file"; then
    printf '%s=%s\n' "$name" "$value" >> "$file"
  fi
}

if [ ! -x "${GATEWAY_DIR}/node_modules/.bin/wrangler" ]; then
  printf 'Missing Wrangler binary. Run pnpm install first.\n' >&2
  exit 1
fi

if [ ! -f "${GATEWAY_DIR}/.dev.vars" ]; then
  log "Creating apps/gateway/.dev.vars from example"
  cp "${GATEWAY_DIR}/.dev.vars.example" "${GATEWAY_DIR}/.dev.vars"
fi

ensure_dev_var "ALEPH_TOOLS_API_KEYS" '{"example-client-dev":"dev-key"}'
ensure_dev_var "ALEPH_TOOLS_WEBHOOK_SECRETS" '{"example-client-dev":"dev-webhook-secret"}'
ensure_dev_var "JOB_RETENTION_DAYS" "3"

if ! grep -q '^GOOGLE_VISION_' "${GATEWAY_DIR}/.dev.vars"; then
  cat <<'EOF'
Missing Google Vision credentials in apps/gateway/.dev.vars.
Set GOOGLE_VISION_CREDENTIALS_JSON to a service account JSON value, or GOOGLE_VISION_API_KEY for local testing.
EOF
fi

if [ "$APPLY_MIGRATIONS" = "1" ]; then
  log "Applying local D1 migrations"
  (cd "$GATEWAY_DIR" && ./node_modules/.bin/wrangler d1 migrations apply aleph-tools-local --local --config wrangler.local.jsonc)
fi

log "Starting gateway on http://127.0.0.1:${GATEWAY_PORT}"
log "Use Authorization: Bearer dev-key for local /v1/* requests"
(cd "$GATEWAY_DIR" && ./node_modules/.bin/wrangler dev --config wrangler.local.jsonc --port "$GATEWAY_PORT")

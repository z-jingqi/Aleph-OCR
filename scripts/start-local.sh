#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_DIR="${ROOT_DIR}/apps/gateway"
ENGINE_IMAGE="${ENGINE_IMAGE:-aleph-tools-container:local}"
ENGINE_PLATFORM="${ENGINE_PLATFORM:-}"
ENGINE_CONTAINER="${ENGINE_CONTAINER:-aleph-tools-engine-local}"
ENGINE_PORT="${ENGINE_PORT:-8090}"
GATEWAY_PORT="${GATEWAY_PORT:-8787}"
TOOLS_ENGINE_TOKEN="${TOOLS_ENGINE_TOKEN:-}"
REBUILD_IMAGE="${REBUILD_IMAGE:-0}"
APPLY_MIGRATIONS="${APPLY_MIGRATIONS:-1}"
STARTED_ENGINE=0

log() {
  printf '[local] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

cleanup() {
  if [ "$STARTED_ENGINE" = "1" ]; then
    log "Stopping ${ENGINE_CONTAINER}"
    docker rm -f "$ENGINE_CONTAINER" >/dev/null 2>&1 || true
  fi
}

ensure_dev_var() {
  local name="$1"
  local value="$2"
  local file="${GATEWAY_DIR}/.dev.vars"
  if ! grep -q "^${name}=" "$file"; then
    printf '%s=%s\n' "$name" "$value" >> "$file"
  fi
}

read_dev_var() {
  local name="$1"
  local file="${GATEWAY_DIR}/.dev.vars"
  awk -F= -v name="$name" '$1 == name { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

set_dev_var() {
  local name="$1"
  local value="$2"
  local file="${GATEWAY_DIR}/.dev.vars"
  local tmp="${file}.tmp"
  awk -v name="$name" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" name "=" { print name "=" value; done = 1; next }
    { print }
    END { if (!done) print name "=" value }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

trap cleanup EXIT

require_command docker
require_command curl

if [ ! -x "${GATEWAY_DIR}/node_modules/.bin/wrangler" ]; then
  printf 'Missing Wrangler binary. Run pnpm install first.\n' >&2
  exit 1
fi

if [ ! -f "${GATEWAY_DIR}/.dev.vars" ]; then
  log "Creating apps/gateway/.dev.vars from example"
  cp "${GATEWAY_DIR}/.dev.vars.example" "${GATEWAY_DIR}/.dev.vars"
fi

if [ -z "$TOOLS_ENGINE_TOKEN" ]; then
  TOOLS_ENGINE_TOKEN="$(read_dev_var "TOOLS_ENGINE_TOKEN" || true)"
fi
TOOLS_ENGINE_TOKEN="${TOOLS_ENGINE_TOKEN:-dev-internal-token}"

ensure_dev_var "ALEPH_TOOLS_API_KEYS" '{"example-client-dev":"dev-key"}'
set_dev_var "ALEPH_TOOLS_ENGINE_URL" "http://127.0.0.1:${ENGINE_PORT}"
set_dev_var "TOOLS_ENGINE_TOKEN" "$TOOLS_ENGINE_TOKEN"
ensure_dev_var "JOB_RETENTION_DAYS" "7"

if [ "$REBUILD_IMAGE" = "1" ] || ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1; then
  log "Building ${ENGINE_IMAGE}"
  if [ -n "$ENGINE_PLATFORM" ]; then
    docker build --platform "$ENGINE_PLATFORM" -t "$ENGINE_IMAGE" "${ROOT_DIR}/apps/ocr-container"
  else
    docker build -t "$ENGINE_IMAGE" "${ROOT_DIR}/apps/ocr-container"
  fi
fi

if docker ps -a --format '{{.Names}}' | grep -Fxq "$ENGINE_CONTAINER"; then
  log "Removing existing ${ENGINE_CONTAINER}"
  docker rm -f "$ENGINE_CONTAINER" >/dev/null
fi

log "Starting tools engine on http://127.0.0.1:${ENGINE_PORT}"
if [ -n "$ENGINE_PLATFORM" ]; then
  docker run -d --rm \
    --platform "$ENGINE_PLATFORM" \
    --name "$ENGINE_CONTAINER" \
    -p "127.0.0.1:${ENGINE_PORT}:8090" \
    -e "TOOLS_ENGINE_TOKEN=${TOOLS_ENGINE_TOKEN}" \
    "$ENGINE_IMAGE" >/dev/null
else
  docker run -d --rm \
    --name "$ENGINE_CONTAINER" \
    -p "127.0.0.1:${ENGINE_PORT}:8090" \
    -e "TOOLS_ENGINE_TOKEN=${TOOLS_ENGINE_TOKEN}" \
    "$ENGINE_IMAGE" >/dev/null
fi
STARTED_ENGINE=1

log "Waiting for tools engine health"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null

if [ "$APPLY_MIGRATIONS" = "1" ]; then
  log "Applying local D1 migrations"
  (cd "$GATEWAY_DIR" && ./node_modules/.bin/wrangler d1 migrations apply aleph-tools-local --local --config wrangler.local.jsonc)
fi

log "Starting gateway on http://127.0.0.1:${GATEWAY_PORT}"
log "Use Authorization: Bearer dev-key for local /v1/* requests"
(cd "$GATEWAY_DIR" && ./node_modules/.bin/wrangler dev --config wrangler.local.jsonc --port "$GATEWAY_PORT")

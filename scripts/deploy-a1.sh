#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[deploy-a1] %s\n' "$*"
}

fail() {
  printf '[deploy-a1] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

wait_for_health() {
  local label="$1"
  local url="$2"
  local timeout_seconds="$3"
  local interval_seconds="$4"
  local started_at now elapsed

  started_at="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/tmp/papercompany-a1-health.json; then
      log "$label health ok: $(cat /tmp/papercompany-a1-health.json)"
      rm -f /tmp/papercompany-a1-health.json
      return 0
    fi

    now="$(date +%s)"
    elapsed=$((now - started_at))
    if [ "$elapsed" -ge "$timeout_seconds" ]; then
      rm -f /tmp/papercompany-a1-health.json
      fail "$label health check timed out after ${timeout_seconds}s ($url)"
    fi

    sleep "$interval_seconds"
  done
}

require_command git
require_command pnpm
require_command curl
require_command systemctl
require_command flock

DEPLOY_PATH="${A1_DEPLOY_PATH:-/srv/papercompany/papercompany-runtime}"
DEPLOY_BRANCH="${A1_DEPLOY_BRANCH:-main}"
DEPLOY_REF="${A1_DEPLOY_REF:-origin/${DEPLOY_BRANCH}}"
EXPECTED_SHA="${A1_DEPLOY_EXPECTED_SHA:-}"
SERVICE_NAME="${A1_SERVICE_NAME:-papercompany-runtime.service}"
INTERNAL_HEALTH_URL="${A1_INTERNAL_HEALTH_URL:-http://127.0.0.1:3100/api/health}"
PUBLIC_HEALTH_URL="${A1_PUBLIC_HEALTH_URL:-https://papercompany.showk.ing/api/health}"
HEALTH_TIMEOUT_SECONDS="${A1_HEALTH_TIMEOUT_SECONDS:-120}"
HEALTH_INTERVAL_SECONDS="${A1_HEALTH_INTERVAL_SECONDS:-3}"
LOCK_FILE="${A1_DEPLOY_LOCK_FILE:-/tmp/papercompany-a1-deploy.lock}"

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another A1 deployment is already running"

[ -d "$DEPLOY_PATH/.git" ] || fail "deploy path is not a git checkout: $DEPLOY_PATH"
cd "$DEPLOY_PATH"

if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
  git status --short
  fail "deploy checkout has local changes; refusing to deploy"
fi

current_branch="$(git symbolic-ref --quiet --short HEAD || true)"
if [ "$current_branch" != "$DEPLOY_BRANCH" ]; then
  log "checking out $DEPLOY_BRANCH"
  git checkout "$DEPLOY_BRANCH"
fi

before_sha="$(git rev-parse HEAD)"
log "before=$before_sha branch=$DEPLOY_BRANCH target=$DEPLOY_REF"

git fetch --prune origin "$DEPLOY_BRANCH"
if ! git cat-file -e "${DEPLOY_REF}^{commit}" 2>/dev/null; then
  git fetch origin "$DEPLOY_REF"
fi
git merge --ff-only "$DEPLOY_REF"

after_sha="$(git rev-parse HEAD)"
if [ -n "$EXPECTED_SHA" ] && [ "$after_sha" != "$EXPECTED_SHA" ]; then
  fail "deployed SHA mismatch: expected $EXPECTED_SHA, got $after_sha"
fi

log "installing dependencies"
pnpm install --frozen-lockfile

log "building workspace, including UI"
pnpm build

log "restarting $SERVICE_NAME"
sudo -n systemctl restart "$SERVICE_NAME"
systemctl is-active --quiet "$SERVICE_NAME" || {
  systemctl status "$SERVICE_NAME" --no-pager -l || true
  fail "$SERVICE_NAME is not active after restart"
}

wait_for_health "internal" "$INTERNAL_HEALTH_URL" "$HEALTH_TIMEOUT_SECONDS" "$HEALTH_INTERVAL_SECONDS"

if [ -n "$PUBLIC_HEALTH_URL" ]; then
  wait_for_health "public" "$PUBLIC_HEALTH_URL" "$HEALTH_TIMEOUT_SECONDS" "$HEALTH_INTERVAL_SECONDS"
fi

log "deployed $before_sha -> $after_sha"

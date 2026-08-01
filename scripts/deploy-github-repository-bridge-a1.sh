#!/usr/bin/env bash
set -Eeuo pipefail

log() {
  printf '[deploy-github-repository-bridge-a1] %s\n' "$*"
}

fail() {
  printf '[deploy-github-repository-bridge-a1] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_command curl
require_command date
require_command flock
require_command git
require_command jq
require_command node
require_command pnpm

PLUGINS_PATH="${A1_PLUGIN_DEPLOY_PATH:-/srv/papercompany/papercompany-plugins}"
EXPECTED_SHA="${A1_PLUGIN_DEPLOY_EXPECTED_SHA:-}"
APPROVAL_ID="${A1_PLUGIN_DEPLOY_APPROVAL_ID:-}"
PAPERCLIP_API_URL="${PAPERCLIP_API_URL:-https://papercompany.showk.ing}"
PAPERCLIP_AUTH_PATH="${PAPERCLIP_AUTH_PATH:-/home/opc/.paperclip/auth.json}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-148e635e-d728-432d-9346-b92ff93b8e70}"
PLUGIN_STABLE_KEY="insightflo.github-repository-bridge"
PLUGIN_INSTALLATION_ID="10982117-aa04-4fb2-950a-4b2a8b2e65b2"
PLUGIN_PACKAGE_PATH="$PLUGINS_PATH/packages/github-repository-bridge/package.json"
PLUGIN_PACKAGE_DIR="$PLUGINS_PATH/packages/github-repository-bridge"
LOCK_FILE="${A1_DEPLOY_LOCK_FILE:-/tmp/papercompany-a1-deploy.lock}"
APPROVAL_MAX_AGE_SECONDS="${A1_PLUGIN_DEPLOY_APPROVAL_MAX_AGE_SECONDS:-1800}"
VERIFY_ONLY="${A1_PLUGIN_DEPLOY_VERIFY_ONLY:-false}"

[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{40}$ ]] || fail "expected SHA must be a lowercase 40-character commit SHA"
[[ "$APPROVAL_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || fail "approval ID must be a UUID"
[[ "$APPROVAL_MAX_AGE_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail "approval max age must be a positive integer"
[[ "$VERIFY_ONLY" = "true" || "$VERIFY_ONLY" = "false" ]] || fail "verify-only mode must be true or false"
[[ -d "$PLUGINS_PATH/.git" ]] || fail "plugin deploy path is not a git checkout: $PLUGINS_PATH"
[[ -f "$PLUGIN_PACKAGE_PATH" ]] || fail "plugin package manifest is missing: $PLUGIN_PACKAGE_PATH"
[[ -r "$PAPERCLIP_AUTH_PATH" ]] || fail "Papercompany auth file is not readable: $PAPERCLIP_AUTH_PATH"

auth_token="$(jq -er --arg api_url "$PAPERCLIP_API_URL" '.credentials[$api_url].token // empty' "$PAPERCLIP_AUTH_PATH")" \
  || fail "could not read the Papercompany API token"

approval_response="$(curl -fsS \
  -H "Authorization: Bearer $auth_token" \
  "$PAPERCLIP_API_URL/api/approvals/$APPROVAL_ID")" \
  || fail "deployment approval readback failed"

jq -e \
  --arg approval_id "$APPROVAL_ID" \
  --arg company_id "$COMPANY_ID" \
  --arg plugin_id "$PLUGIN_INSTALLATION_ID" \
  --arg expected_sha "$EXPECTED_SHA" \
  '.id == $approval_id
    and .companyId == $company_id
    and .requestedByPluginId == $plugin_id
    and .type == "external_automation"
    and .status == "approved"
    and .payload.repository == "insightflo/papercompany-plugins"
    and .payload.commit == $expected_sha
    and (.decidedAt | type == "string")' \
  >/dev/null <<<"$approval_response" \
  || fail "approval is not a plugin-issued approval for this exact plugin revision"

approval_decided_at="$(jq -er '.decidedAt' <<<"$approval_response")"
approval_decided_epoch="$(date -u -d "$approval_decided_at" +%s)" \
  || fail "approval decision time is invalid"
now_epoch="$(date -u +%s)"
approval_age_seconds=$((now_epoch - approval_decided_epoch))
(( approval_age_seconds >= 0 && approval_age_seconds <= APPROVAL_MAX_AGE_SECONDS )) \
  || fail "approval proof is expired or has an invalid decision time"

if [ "$VERIFY_ONLY" = "true" ]; then
  log "approval proof is valid for $EXPECTED_SHA"
  exit 0
fi

exec 9>"$LOCK_FILE"
flock -n 9 || fail "another A1 deployment is already running"

cd "$PLUGINS_PATH"
working_tree_status="$(git status --porcelain=v1 --untracked-files=all)"
if [ -n "$working_tree_status" ]; then
  printf '%s\n' "$working_tree_status"
  fail "plugin checkout has tracked or untracked changes; refusing to deploy"
fi
if ! git diff --quiet -- . || ! git diff --cached --quiet -- .; then
  git status --short
  fail "plugin checkout has local changes; refusing to deploy"
fi

git fetch --quiet origin main
git merge-base --is-ancestor "$EXPECTED_SHA" origin/main || fail "expected SHA is not contained in origin/main: $EXPECTED_SHA"
resolved_sha="$(git rev-parse "${EXPECTED_SHA}^{commit}")"
[[ "$resolved_sha" = "$EXPECTED_SHA" ]] || fail "resolved commit SHA differs from requested SHA"

log "checking out approved plugin revision $resolved_sha"
git checkout --detach --quiet "$resolved_sha"

log "building GitHub Repository Bridge"
pnpm --dir "$PLUGINS_PATH" --filter @insightflo/paperclip-github-repository-bridge build

expected_version="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PLUGIN_PACKAGE_PATH")"
[[ -n "$expected_version" ]] || fail "could not read plugin version from package manifest"

deployment_started_epoch="$(date -u +%s)"
upgrade_response="$(curl -fsS \
  -X POST \
  -H "Authorization: Bearer $auth_token" \
  -H 'Content-Type: application/json' \
  "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_STABLE_KEY/upgrade" \
  --data '{}')" || fail "plugin upgrade API request failed"

jq -e --arg expected_version "$expected_version" --arg expected_package_path "$PLUGIN_PACKAGE_DIR" \
  '.version == $expected_version and .status == "ready" and .packagePath == $expected_package_path' \
  >/dev/null <<<"$upgrade_response" \
  || fail "plugin upgrade did not report the expected ready version"

upgrade_updated_at="$(jq -er '.updatedAt' <<<"$upgrade_response")"
upgrade_updated_epoch="$(date -u -d "$upgrade_updated_at" +%s)" \
  || fail "plugin upgrade did not report a valid update time"
(( upgrade_updated_epoch >= deployment_started_epoch )) \
  || fail "plugin upgrade response predates this deployment"

health_response="$(curl -fsS \
  -H "Authorization: Bearer $auth_token" \
  "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_STABLE_KEY/health")" \
  || fail "plugin health API request failed"

jq -e '.healthy == true' >/dev/null <<<"$health_response" \
  || fail "plugin health check did not report healthy"

log "GitHub Repository Bridge $expected_version is ready at $resolved_sha"

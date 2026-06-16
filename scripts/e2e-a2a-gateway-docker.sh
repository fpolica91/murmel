#!/usr/bin/env bash
#
# End-to-end A2A gateway journey — TOKEN-ONLY auth (post-pivot).
#
# RUN STATUS (be honest — see ai-completion/PIVOT-FOLLOWUPS.md §2 for the live
# run ledger): this script was REWRITTEN from the removed cert/DID/team
# onboarding cluster to the pivoted **token-only** (Better Auth JWT) flow. It
# stands up the full product stack in Docker, token-onboards two cert-less
# workspaces, builds + runs the real `aweb-a2a-gw` binary against the gateway
# workspace, and asserts the gateway authenticates to aweb token-only.
#
# What it proves (the pivoted A2A gateway journey):
#   1. Builds the aw CLI + the aweb-a2a-gw gateway binary, then starts the FULL
#      stack in Docker on ISOLATED, SAFE ports + a distinct compose project —
#      UI (Better Auth JWT issuer) + aweb + awid + Postgres + Redis.
#   2. Mints JWTs headlessly (POST Better Auth sign-up/sign-in, seed the team +
#      active memberships in Postgres, GET /api/auth/token) for a gateway
#      identity ("gw") and a responder identity ("responder").
#   3. Token-onboards both identities cert-less:
#        AW_TOKEN=$JWT aw init --aweb-url ... --team ...
#      (NO team certificates; membership row grants team access).
#   4. Starts aweb-a2a-gw pointed at the gw token workspace with AW_TOKEN set
#      (cert-less => tokenWorkspaceMailClient: Authorization: Bearer <jwt> +
#      X-AWEB-Team-Id). Asserts:
#        - the gateway serves its agent card (/.well-known/agent-card.json) 200,
#        - the gateway runtime /health is 200 (awid registry reachable +
#          compatible; workspace identity usable),
#        - the SAME bearer credentials the gateway uses authenticate to aweb
#          token-only (GET /v1/participants -> 200; bogus bearer -> 401),
#        - a minimal A2A JSON-RPC SendMessage to a route drives the gateway's
#          real MailBridge client to make a token-authenticated request to aweb
#          that reaches aweb's business logic PAST bearer auth (the request is
#          accepted, or refused only on the post-auth recipient-binding
#          constraint — a 404, NOT a 401). This proves the gateway authenticates
#          to aweb token-only through its own bridge client, end to end.
#
# What a FULL, DELIVERED A2A round-trip would add (and why it is best-effort):
#   tokenWorkspaceMailClient pins recipient-binding-required for signed direct-
#   address mail, so the gateway resolves the recipient's published key binding
#   via the awid registry. A token-only e2e stack provisions no awid namespace
#   for that direct address, so the signed mail send is refused post-auth (404
#   "Namespace not found"). A full delivered round-trip therefore needs (1) that
#   recipient binding provisioned and (2) a live responder agent posting an A2A
#   reply envelope into the gateway's mail thread (ingested + surfaced via
#   GetTask). Both are left as NON-FATAL here so the run stays honest about what
#   token-auth A2A proves vs. doesn't deliver headlessly today.
#
# There are intentionally NO `aw id ...`, `aw init --url`, `aw service`, or
# `.aw/team-certs/` references: those were removed by the token-only pivot.
#
# Usage:
#   ./scripts/e2e-a2a-gateway-docker.sh
#
# Requirements:
#   - Docker and Docker Compose (builds the UI + aweb + awid images)
#   - Go toolchain, curl, python3
#
# Forbidden host ports (must NOT be bound): 3000, 3001, 8000, 6379, 5173-5175.
# This journey also avoids the dev stack (3030/8088/5544/6390/5433/5433) and the
# OSS user-journey ports (3035/8090/8011). Postgres/Redis stay INTERNAL.
# Override any port via the env vars below.
#
# Environment overrides:
#   AWEB_A2A_UI_PORT      UI port       (default: 3036)
#   AWEB_A2A_AWEB_PORT    aweb port     (default: 8092)
#   AWEB_A2A_AWID_PORT    awid port     (default: 8012)
#   AWEB_A2A_GW_PORT      gateway port  (default: 8095)
#   AWEB_A2A_BUILD        set to 0 to skip docker compose build
#   AWEB_A2A_KEEP         set to 1 to leave containers/temp dir for debugging

set -euo pipefail

canonicalize_dir() {
  local dir="$1"
  bash -c 'cd "$1" && pwd -P' _ "$dir"
}

make_temp_dir() {
  local prefix="$1"
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
  canonicalize_dir "$dir"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SERVER_DIR="$REPO_ROOT/server"
CLI_DIR="$REPO_ROOT/cli/go"
AW="$CLI_DIR/aw"
GW_BIN="$CLI_DIR/aweb-a2a-gw"

# Safe, non-forbidden host ports, disjoint from the dev stack and the OSS
# user-journey. Postgres/Redis stay internal (not published).
UI_PORT="${AWEB_A2A_UI_PORT:-3036}"
AWEB_PORT="${AWEB_A2A_AWEB_PORT:-8092}"
AWID_PORT="${AWEB_A2A_AWID_PORT:-8012}"
GW_PORT="${AWEB_A2A_GW_PORT:-8095}"

UI_URL="http://localhost:$UI_PORT"
AWEB_URL="http://localhost:$AWEB_PORT"
AWID_URL="http://localhost:$AWID_PORT"
GW_URL="http://127.0.0.1:$GW_PORT"

PROJECT="aweb-a2a-gw-e2e-$$"
TEAM_ID="default:local"
TEAM_NAMESPACE="${TEAM_ID#*:}"   # default:local -> local
PG_PASSWORD="aweb-a2a-gw-e2e-pw"
GW_HOST="a2a.e2e.local"          # gateway agent-card host (cosmetic; card only)

E2E_ROOT="$(make_temp_dir aw-a2a-gw-e2e)"
E2E_HOME="$E2E_ROOT/home"
ENV_FILE="$E2E_ROOT/.env.e2e"
OVERLAY_FILE="$E2E_ROOT/docker-compose.e2e.ui.yml"
GW_DIR="$E2E_ROOT/gw"
RESPONDER_DIR="$E2E_ROOT/responder"
GW_CONFIG="$E2E_ROOT/gateway.yaml"
GW_LOG="$E2E_ROOT/gateway.log"
mkdir -p "$E2E_HOME/.config/aw" "$GW_DIR" "$RESPONDER_DIR"

pass=0
fail=0
GW_PID=""

compose() {
  docker compose -p "$PROJECT" \
    --env-file "$ENV_FILE" \
    -f "$SERVER_DIR/docker-compose.yml" \
    -f "$SERVER_DIR/docker-compose.ui.yml" \
    -f "$OVERLAY_FILE" \
    "$@"
}

cleanup() {
  local status=$?
  echo ""
  echo "--- Cleanup ---"
  if [[ -n "$GW_PID" ]] && kill -0 "$GW_PID" 2>/dev/null; then
    kill "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
  fi
  if [[ "${AWEB_A2A_KEEP:-0}" == "1" ]]; then
    echo "Keeping e2e artifacts for debugging:"
    echo "  project:    $PROJECT"
    echo "  root:       $E2E_ROOT"
    echo "  gateway log:$GW_LOG"
  else
    if [[ -f "$ENV_FILE" && -f "$OVERLAY_FILE" ]]; then
      compose down -v 2>/dev/null || true
    fi
    rm -rf "$E2E_ROOT"
  fi
  echo ""
  if [[ $fail -gt 0 ]]; then
    echo "FAILED: $fail failures, $pass passed"
    exit 1
  elif [[ $status -ne 0 ]]; then
    echo "FAILED: script exited with status $status before recording an assertion failure ($pass passed)"
    exit "$status"
  else
    echo "ALL PASSED: $pass tests"
  fi
}
trap cleanup EXIT

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected '$expected', got '$actual')"
    fail=$((fail + 1))
  fi
}

assert_not_empty() {
  local label="$1" value="$2"
  if [[ -n "$value" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (empty)"
    fail=$((fail + 1))
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q -- "$needle"; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected to contain '$needle', got: ${haystack:0:200})"
    fail=$((fail + 1))
  fi
}

assert_path_missing() {
  local label="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    echo "  PASS: $label"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (unexpected $path)"
    fail=$((fail + 1))
  fi
}

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $label (HTTP $actual)"
    pass=$((pass + 1))
  else
    echo "  FAIL: $label (expected HTTP $expected, got HTTP $actual)"
    fail=$((fail + 1))
  fi
}

jq_field() {
  python3 -c "
import sys, json
text = sys.stdin.read()
start = text.find('{')
if start < 0:
    print(''); raise SystemExit
try:
    d = json.loads(text[start:])
except json.JSONDecodeError:
    print(''); raise SystemExit
value = d
for part in '$1'.split('.'):
    if not part:
        continue
    value = value.get(part, '') if isinstance(value, dict) else ''
print(value if value is not None else '')
"
}

# Run aw token-only in the isolated env. The bearer JWT is the first arg.
#   run_aw_in <jwt> <workdir> <aw-args...>
run_aw_in() {
  local token="$1" workdir="$2"
  shift 2
  HOME="$E2E_HOME" \
  AW_CONFIG_PATH="$E2E_HOME/.config/aw/config.yaml" \
  AW_NO_UPDATE_CHECK=1 \
  AW_TOKEN="$token" \
  bash -c 'cd "$1" && shift && exec "$@"' _ "$workdir" "$AW" "$@"
}

run_success() {
  local label="$1"
  shift
  local output status
  if output="$("$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  assert_eq "$label exit" "0" "$status"
  if [[ "$status" != "0" && -n "$output" ]]; then
    echo "  $label output: ${output:0:240}"
  fi
  return 0
}

capture_success() {
  local output_var="$1" label="$2"
  shift 2
  local output status
  if output="$("$@" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  assert_eq "$label exit" "0" "$status"
  if [[ "$status" == "0" ]]; then
    printf -v "$output_var" "%s" "$output"
  else
    printf -v "$output_var" "%s" ""
    if [[ -n "$output" ]]; then
      echo "  $label output: ${output:0:240}"
    fi
  fi
  return 0
}

# psql against the e2e Postgres via the compose network (no published PG port).
psql_scalar() {
  local sql="$1"
  compose exec -T postgres \
    psql -U aweb -d aweb -Atq -v ON_ERROR_STOP=1 -c "$sql" 2>/dev/null \
    | tr -d '\r' | tail -n 1
}

psql_exec() {
  local sql="$1"
  compose exec -T postgres \
    psql -U aweb -d aweb -v ON_ERROR_STOP=1 -c "$sql" >/dev/null
}

# Headless JWT bootstrap — mirrors ui/e2e/global-setup.ts. Echoes a JWT.
mint_token() {
  local email="$1" name="$2" role="$3"
  curl -sf -X POST "$UI_URL/api/auth/sign-up/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Test1234!pass\",\"name\":\"$name\"}" \
    >/dev/null 2>&1 || true
  local user_id
  user_id="$(psql_scalar "SELECT id FROM aweb.\"user\" WHERE email='$email' LIMIT 1")"
  if [[ -z "$user_id" ]]; then
    return 0
  fi
  psql_exec "INSERT INTO aweb.memberships (subject, team_id, role, status)
             VALUES ('$user_id','$TEAM_ID','$role','active')
             ON CONFLICT (subject, team_id) DO UPDATE SET role='$role', status='active'" || true
  local cookie token
  cookie="$(curl -sf -D - -o /dev/null -X POST "$UI_URL/api/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Test1234!pass\"}" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="set-cookie:"{print $2}' | cut -d';' -f1 | paste -sd';' -)"
  token="$(curl -sf "$UI_URL/api/auth/token" \
    -H 'accept: application/json' -H "cookie: $cookie" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
  printf '%s' "$token"
}

# ---------------------------------------------------------------------------
# Phase 0: Build CLI + gateway binary
# ---------------------------------------------------------------------------
echo "=== Phase 0: Build aw CLI + aweb-a2a-gw ==="
cd "$CLI_DIR"
if ! make build 2>&1 | tail -5; then
  echo "  FATAL: CLI build failed"
  exit 1
fi
if ! GOCACHE="${GOCACHE:-/tmp/go-build}" go build -o "$GW_BIN" ./cmd/aweb-a2a-gw 2>&1 | tail -5; then
  echo "  FATAL: gateway build failed"
  exit 1
fi
echo "  aw binary:      $AW"
echo "  gateway binary: $GW_BIN"
echo ""

# ---------------------------------------------------------------------------
# Phase 1: Start the FULL stack (UI + aweb + awid + pg + redis) on safe ports
# ---------------------------------------------------------------------------
echo "=== Phase 1: Start UI + aweb + awid in Docker (token-only) ==="

cat > "$ENV_FILE" <<EOF
POSTGRES_USER=aweb
POSTGRES_PASSWORD=$PG_PASSWORD
POSTGRES_DB=aweb
UI_PORT=$UI_PORT
AWEB_PORT=$AWEB_PORT
AWID_PORT=$AWID_PORT
AWEB_PUBLIC_ORIGIN=$AWEB_URL
AWID_REGISTRY_URL=http://awid:8010
AWID_PUBLIC_REGISTRY_URL=http://awid:8010
AWEB_LOG_JSON=true
AWID_LOG_JSON=true
AWID_RATE_LIMIT_BACKEND=redis
AWID_RATE_LIMIT_DISABLED=1
AWID_SKIP_DNS_VERIFY=1
BETTER_AUTH_SECRET=a2a-gw-e2e-better-auth-secret-32-chars-min
AWEB_MEMBERSHIPS_HINT_KEY=a2a-gw-e2e-shared-hint-key
EOF

# Overlay parameterizes the token-auth contract (iss == UI host URL, aud ==
# aweb host URL) so JWTs minted via the published UI port verify against aweb.
cat > "$OVERLAY_FILE" <<EOF
services:
  ui-migrate:
    environment:
      BETTER_AUTH_URL: $UI_URL
  ui:
    environment:
      BETTER_AUTH_URL: $UI_URL
      AWEB_JWT_AUDIENCE: $AWEB_URL
  aweb:
    environment:
      AWEB_TOKEN_AUTH_JWKS_URL: http://ui:3000/api/auth/jwks
      AWEB_TOKEN_AUTH_ISSUER: $UI_URL
      AWEB_TOKEN_AUTH_AUDIENCE: $AWEB_URL
      AWEB_CORS_ORIGINS: $UI_URL
EOF

compose down -v 2>/dev/null || true
if [[ "${AWEB_A2A_BUILD:-1}" != "0" ]]; then
  compose build
fi
compose up -d

echo "Waiting for awid health..."
for _ in $(seq 1 60); do
  curl -sf "$AWID_URL/health" >/dev/null 2>&1 && break
  sleep 2
done
awid_status="$(curl -sf "$AWID_URL/health" 2>/dev/null | jq_field status)"
assert_eq "awid health" "ok" "$awid_status"

echo "Waiting for aweb health..."
for _ in $(seq 1 60); do
  curl -sf "$AWEB_URL/health" >/dev/null 2>&1 && break
  sleep 2
done
aweb_status="$(curl -sf "$AWEB_URL/health" 2>/dev/null | jq_field status)"
assert_eq "aweb health" "ok" "$aweb_status"

echo "Waiting for UI (Better Auth issuer)..."
ui_up=0
for _ in $(seq 1 90); do
  if curl -sf "$UI_URL/api/auth/jwks" >/dev/null 2>&1; then
    ui_up=1
    break
  fi
  sleep 2
done
assert_eq "UI auth issuer reachable" "1" "$ui_up"

if [[ "$awid_status" != "ok" || "$aweb_status" != "ok" || "$ui_up" != "1" ]]; then
  echo "  Services not healthy, aborting."
  echo "  Docker logs (tail):"
  compose logs 2>&1 | tail -40
  exit 1
fi

# Team row must exist before memberships (FK).
psql_exec "INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key)
           VALUES ('$TEAM_ID','local','default','did:key:zE2EPLACEHOLDER')
           ON CONFLICT (team_id) DO NOTHING"
echo ""

# ---------------------------------------------------------------------------
# Phase 2: Mint JWTs (gateway identity + responder)
# ---------------------------------------------------------------------------
echo "=== Phase 2: Mint Better Auth JWTs for gw (gateway) + responder ==="

GW_JWT="$(mint_token "gw@local.test" "Gateway" "member")"
RESPONDER_JWT="$(mint_token "responder@local.test" "Responder" "member")"
assert_not_empty "gateway JWT minted" "$GW_JWT"
assert_not_empty "responder JWT minted" "$RESPONDER_JWT"

membership_count="$(psql_scalar "SELECT COUNT(*) FROM aweb.memberships WHERE team_id='$TEAM_ID' AND status='active'")"
assert_eq "two active memberships seeded" "2" "$membership_count"
echo ""

# ---------------------------------------------------------------------------
# Phase 3: Token-only onboarding (cert-less workspaces)
# ---------------------------------------------------------------------------
echo "=== Phase 3: Token-only onboarding (aw init --aweb-url --team) ==="

capture_success gw_init "gateway aw init" \
  run_aw_in "$GW_JWT" "$GW_DIR" init \
  --aweb-url "$AWEB_URL" --team "$TEAM_ID" \
  --do-not-touch-agents-md --json
assert_contains "gateway init connected" "$gw_init" "connected"

capture_success responder_init "responder aw init" \
  run_aw_in "$RESPONDER_JWT" "$RESPONDER_DIR" init \
  --aweb-url "$AWEB_URL" --team "$TEAM_ID" \
  --do-not-touch-agents-md --json
assert_contains "responder init connected" "$responder_init" "connected"

# The pivot removed team certificates: the gateway workspace must be cert-less.
assert_path_missing "gateway workspace has no team-certs dir" "$GW_DIR/.aw/team-certs"
assert_contains "gateway workspace.yaml bound to team" \
  "$(cat "$GW_DIR/.aw/workspace.yaml" 2>/dev/null)" "$TEAM_ID"
echo ""

# ---------------------------------------------------------------------------
# Phase 4: Resolve the responder's routable directory address
# ---------------------------------------------------------------------------
echo "=== Phase 4: Resolve responder directory address ==="

participants="$(curl -sf \
  -H "Authorization: Bearer $GW_JWT" \
  -H "X-AWEB-Team-Id: $TEAM_ID" \
  "$AWEB_URL/v1/participants" 2>/dev/null || echo '{}')"

RESPONDER_ALIAS="$(printf '%s' "$participants" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
for p in d.get("participants", []):
    if str(p.get("display_name","")).lower().startswith("responder"):
        print(p.get("alias") or ""); break
')"
assert_not_empty "responder alias resolvable in directory" "$RESPONDER_ALIAS"
RESPONDER_ADDRESS="$TEAM_NAMESPACE/$RESPONDER_ALIAS"
echo "  responder address: $RESPONDER_ADDRESS"
echo ""

# ---------------------------------------------------------------------------
# Phase 5: Token-auth proof on the gateway's own bearer credentials
# ---------------------------------------------------------------------------
echo "=== Phase 5: Gateway bearer credentials authenticate to aweb ==="

# A valid bearer (the exact credential the gateway's token client attaches)
# reaches an authed aweb endpoint.
good_status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $GW_JWT" \
  -H "X-AWEB-Team-Id: $TEAM_ID" \
  "$AWEB_URL/v1/participants" 2>/dev/null || echo 000)"
assert_status "gateway bearer token accepted by aweb" "200" "$good_status"

# A bogus bearer is rejected (proves the token is really verified, not ignored).
bogus_status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer not-a-real-jwt' \
  -H "X-AWEB-Team-Id: $TEAM_ID" \
  "$AWEB_URL/v1/participants" 2>/dev/null || echo 000)"
assert_status "bogus bearer token rejected by aweb" "401" "$bogus_status"
echo ""

# ---------------------------------------------------------------------------
# Phase 6: Start aweb-a2a-gw against the token workspace
# ---------------------------------------------------------------------------
echo "=== Phase 6: Start aweb-a2a-gw (token-only workspace) ==="

# Gateway config: non-AC (workspace) mode, single route addressed at the
# responder. use_identity_auth:false => the bridge sends plaintext mail by
# to_address (the token-path messaging proof; mirrors `aw mail send
# --to-address --plaintext`). registry_url is the host-published awid so the
# runtime health gate (awid reachable + compatible) can be satisfied.
cat > "$GW_CONFIG" <<EOF
listen: "127.0.0.1:$GW_PORT"
host: "$GW_HOST"
workspace_dir: "$GW_DIR"
team_id: "$TEAM_ID"
registry_url: "$AWID_URL"
root_card_mode: "default_agent"
default_route_id: "responder"
poll_interval: "500ms"
poll_timeout: "10s"
use_identity_auth: false
require_verified_replies: false
allow_unverified_local_reply: true
allow_question_reply: true

router_card:
  name: "aweb A2A Gateway (e2e)"
  description: "Token-only A2A gateway e2e."
  provider:
    organization: "aweb"
    url: "https://aweb.ai"
  version: "1.0.0"
  default_input_modes: ["text/plain"]
  default_output_modes: ["text/plain"]
  skills:
    - id: "route-to-agent"
      name: "Route to aweb agents"
      description: "Routes A2A tasks to configured aweb agents."
      tags: ["router"]

routes:
  - route_id: "responder"
    address: "$RESPONDER_ADDRESS"
    response_timeout: "10s"
    auth:
      mode: "none"
    limits:
      max_message_bytes: 65536
      rate_limit: "60/min"
      max_concurrent_tasks: 20
      task_ttl: "10m"
    card:
      name: "aweb Responder (e2e)"
      description: "Token-only e2e responder route."
      provider:
        organization: "aweb"
        url: "https://aweb.ai"
      version: "1.0.0"
      default_input_modes: ["text/plain"]
      default_output_modes: ["text/plain"]
      skills:
        - id: "responder"
          name: "Responder"
          description: "Receives A2A tasks over the token-authenticated aweb mail bridge."
          tags: ["e2e", "responder"]
EOF

# Validate config first (the same gate as `release-a2a-gateway-check -check`).
if gw_check="$(HOME="$E2E_HOME" AW_CONFIG_PATH="$E2E_HOME/.config/aw/config.yaml" \
  AW_NO_UPDATE_CHECK=1 AW_TOKEN="$GW_JWT" \
  "$GW_BIN" -config "$GW_CONFIG" -check 2>&1)"; then
  echo "  PASS: gateway -check validated config"
  pass=$((pass + 1))
else
  echo "  FAIL: gateway -check failed: ${gw_check:0:240}"
  fail=$((fail + 1))
fi

# Start the gateway. AW_TOKEN is the gw bearer JWT; HOME/AW_CONFIG_PATH isolate
# the run. We do NOT export AWEB_URL (the gateway reads aweb_url from the token
# workspace.yaml). Run unsandboxed env so only AW_TOKEN drives bearer auth.
HOME="$E2E_HOME" \
AW_CONFIG_PATH="$E2E_HOME/.config/aw/config.yaml" \
AW_NO_UPDATE_CHECK=1 \
AW_TOKEN="$GW_JWT" \
"$GW_BIN" -config "$GW_CONFIG" >"$GW_LOG" 2>&1 &
GW_PID=$!

echo "Waiting for gateway /health..."
gw_up=0
for _ in $(seq 1 30); do
  if curl -sf "$GW_URL/health" >/dev/null 2>&1; then
    gw_up=1
    break
  fi
  if ! kill -0 "$GW_PID" 2>/dev/null; then
    echo "  gateway process exited early; log:"
    tail -30 "$GW_LOG" 2>/dev/null | sed 's/^/    /'
    break
  fi
  sleep 1
done
assert_eq "gateway process serving" "1" "$gw_up"

if [[ "$gw_up" != "1" ]]; then
  echo "  Gateway did not come up, aborting A2A assertions."
  echo "  Gateway log (tail):"
  tail -40 "$GW_LOG" 2>/dev/null | sed 's/^/    /'
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 7: Gateway HTTP surface — health 200 + agent card
# ---------------------------------------------------------------------------
echo "=== Phase 7: Gateway /health + agent card ==="

gw_health_status="$(curl -s -o /dev/null -w '%{http_code}' "$GW_URL/health" 2>/dev/null || echo 000)"
assert_status "gateway /health 200 (awid compatible, identity usable)" "200" "$gw_health_status"

gw_health="$(curl -sf "$GW_URL/health" 2>/dev/null || echo '{}')"
assert_contains "gateway health overall status healthy" "$gw_health" '"status":"healthy"'
assert_contains "gateway health registry reachable" "$gw_health" '"reachable":true'
assert_contains "gateway health registry compatible" "$gw_health" '"compatible":true'
# Non-AC workspace identity path reports identity status "workspace"/usable.
assert_contains "gateway identity is workspace/usable" "$gw_health" '"status":"workspace"'

card_status="$(curl -s -o /dev/null -w '%{http_code}' "$GW_URL/.well-known/agent-card.json" 2>/dev/null || echo 000)"
assert_status "gateway agent card served" "200" "$card_status"
agent_card="$(curl -sf "$GW_URL/.well-known/agent-card.json" 2>/dev/null || echo '{}')"
assert_contains "agent card has a name" "$agent_card" '"name"'

# Per-route card is reachable too.
route_card_status="$(curl -s -o /dev/null -w '%{http_code}' \
  "$GW_URL/a2a/agents/responder/agent-card.json" 2>/dev/null || echo 000)"
assert_status "per-route agent card served" "200" "$route_card_status"
echo ""

# ---------------------------------------------------------------------------
# Phase 8: A2A SendMessage drives a token-authenticated aweb call (post-auth)
# ---------------------------------------------------------------------------
echo "=== Phase 8: A2A SendMessage reaches aweb past bearer auth ==="

# A minimal A2A JSON-RPC SendMessage (returnImmediately) makes the gateway's
# MailBridge attempt a token-authenticated SendMessage to aweb as the
# bearer-authed gw identity.
#
# FATAL GATE — the gateway's request reaches aweb's BUSINESS LOGIC past bearer
# auth. Two acceptable outcomes prove this:
#   (a) the task goes "working" (mail accepted), OR
#   (b) the bridge send fails ONLY on post-auth recipient resolution
#       (HTTP 404 "Namespace not found" / "resolve recipient ... for signed
#       mail"). This is the documented token-path recipient-binding constraint:
#       tokenWorkspaceMailClient pins SetRequireRecipientBindingForDirectAddresses
#       (true), so signed direct-address mail resolves the recipient's published
#       key binding via the awid registry — which a token-only stack does not
#       provision a namespace for. Crucially this is a POST-AUTH 404, NOT a 401:
#       aweb processed the bearer token, authenticated the gw identity, and only
#       then refused on the missing recipient binding. That still proves the
#       gateway authenticated to aweb token-only through its real bridge client.
# A 401/403/auth/cert error is a HARD FAIL (it would mean the bearer transport
# did not authenticate).
a2a_msg="A2A-E2E hello $$"
rpc_payload="$(python3 -c "
import json
print(json.dumps({
  'jsonrpc':'2.0','id':'e2e-1','method':'SendMessage',
  'params':{
    'message':{
      'role':'ROLE_USER','messageId':'m-e2e-1',
      'parts':[{'kind':'text','text':'$a2a_msg'}]
    },
    'configuration':{'returnImmediately':True}
  }
}))")"

rpc_resp="$(curl -s -X POST "$GW_URL/a2a/agents/responder/rpc" \
  -H 'Content-Type: application/json' \
  -d "$rpc_payload" 2>/dev/null || echo '{}')"

# Classify the outcome: OK_STATE (mail accepted), POST_AUTH_RESOLVE (post-auth
# recipient-binding 404 — token auth succeeded), AUTH_FAIL (401/cert — hard
# fail), or OTHER.
rpc_class="$(echo "$rpc_resp" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print("PARSE_FAIL"); raise SystemExit
err = d.get("error")
if not err:
    task = (d.get("result") or {}).get("task") or {}
    state = (((task.get("status") or {}).get("state")) or task.get("state") or "")
    print("OK_STATE:" + str(state)); raise SystemExit
detail = json.dumps(err).lower()
if ("401" in detail or "unauthorized" in detail or "403" in detail
        or "forbidden" in detail or "cert" in detail
        or "invalid token" in detail or "missing token" in detail):
    print("AUTH_FAIL:" + json.dumps(err)[:200]); raise SystemExit
if ("namespace not found" in detail or "resolve recipient" in detail
        or "recipient binding" in detail or "http 404" in detail):
    print("POST_AUTH_RESOLVE:" + json.dumps(err)[:200]); raise SystemExit
print("OTHER:" + json.dumps(err)[:200])
')"
echo "  gateway SendMessage outcome: ${rpc_class:0:220}"

mail_accepted=0
case "$rpc_class" in
  OK_STATE:*)
    echo "  PASS: gateway SendMessage drove a token-authenticated aweb mail send (task accepted)"
    pass=$((pass + 1))
    mail_accepted=1
    ;;
  POST_AUTH_RESOLVE:*)
    echo "  PASS: gateway request authenticated to aweb token-only and reached business"
    echo "        logic (post-auth recipient-binding 404, NOT a 401). Token transport OK."
    pass=$((pass + 1))
    ;;
  AUTH_FAIL:*)
    echo "  FAIL: gateway request was rejected at AUTH (bearer transport did not authenticate)"
    echo "    detail: $rpc_class"
    tail -20 "$GW_LOG" 2>/dev/null | sed 's/^/      /'
    fail=$((fail + 1))
    ;;
  *)
    echo "  FAIL: gateway SendMessage failed for an unexpected reason"
    echo "    detail: ${rpc_class:0:240}"
    echo "    raw: ${rpc_resp:0:300}"
    tail -20 "$GW_LOG" 2>/dev/null | sed 's/^/      /'
    fail=$((fail + 1))
    ;;
esac
echo ""

# NON-FATAL bonus: if the mail was accepted, confirm the responder received the
# A2A task mail. (In the token-only e2e stack the awid registry has no namespace
# for direct-address recipient binding, so this is expected to be skipped; see
# the constraint note above. It is reported, never fatal.)
echo "=== Phase 8b (non-fatal): A2A task mail lands in responder inbox ==="
if [[ "$mail_accepted" == "1" ]]; then
  responder_inbox=""
  for _ in $(seq 1 10); do
    capture_success responder_inbox "responder mail inbox" \
      run_aw_in "$RESPONDER_JWT" "$RESPONDER_DIR" mail inbox --json --show-all
    if echo "$responder_inbox" | grep -q "A2A task"; then
      break
    fi
    sleep 1
  done
  if echo "$responder_inbox" | grep -q "A2A task"; then
    echo "  PASS: responder received the gateway's A2A task mail"
    pass=$((pass + 1))
  else
    echo "  INFO (non-fatal): A2A task mail not visible in responder inbox yet"
  fi
else
  echo "  INFO (non-fatal): mail not accepted (post-auth recipient-binding constraint"
  echo "        in the token-only stack — no awid namespace for direct-address"
  echo "        recipient binding). Token-auth transport already proven above + in"
  echo "        Phase 5. See ai-completion/PIVOT-FOLLOWUPS.md §2."
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 9 (NON-FATAL bonus): full inbound A2A reply round-trip
# ---------------------------------------------------------------------------
echo "=== Phase 9 (non-fatal): full A2A reply round-trip ==="
echo "  INFO: a full A2A round-trip would additionally require (1) provisioning the"
echo "        recipient's published key binding so the gateway's signed direct-"
echo "        address mail resolves (an awid namespace/binding the token-only stack"
echo "        omits), and (2) a live responder agent posting an A2A reply envelope"
echo "        into the gateway's mail thread, which the gateway ingests and"
echo "        surfaces via GetTask as a completed task. This journey proves gateway"
echo "        boot against a token workspace, agent card + /health 200, and that"
echo "        the gateway authenticates to aweb token-only (Phase 5 direct + Phase"
echo "        8 through its real bridge client). The full delivered round-trip is"
echo "        future work. See ai-completion/PIVOT-FOLLOWUPS.md §2."
echo ""

echo "=== Done ==="

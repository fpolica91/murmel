#!/usr/bin/env bash
#
# End-to-end OSS federation journey — TOKEN-ONLY federation (Option A.2).
#
# RUN STATUS (be honest — see ai-completion/PIVOT-FOLLOWUPS.md §2 for the live
# run ledger): this script was REWRITTEN from the removed cert/DID/namespace
# federation surface to the now-implemented **token-only federation** model
# (Option A.2, commit 7825fe3b; server suite + tests/test_federation_assertion.py
# 21 passing). The trust model it exercises end-to-end across two REAL aweb
# stacks:
#
#   per-server Ed25519 signing key (AWEB_FEDERATION_SIGNING_SEED)
#     -> explicit peer allowlist (AWEB_FEDERATION_PEERS: peer domain/origin ->
#        pinned server DID + delivery origin)
#       -> a server-vouched OUTER delivery assertion wrapping the inner
#          participant-signed envelope, verified on receive in order:
#            allowlisted origin -> outer sig vs PINNED key -> inner participant
#            sig -> local directory resolution -> replay/idempotency claim.
#
# There is NO awid identity registry in the trust path (A.2 drops it): a peer
# server vouches for its own member; the receiver resolves the recipient against
# its OWN local agent directory (membership on the home server). The removed
# `aw id create` / `aw id team` / `aw id namespace set-delivery-origin` cluster
# is NOT used anywhere.
#
# What it does:
#   1. Stands up TWO fully isolated aweb stacks (A + B), each = aweb + its Better
#      Auth UI issuer + Postgres + Redis, under DISTINCT compose projects and
#      DISJOINT SAFE host ports. Postgres/Redis are internal-only.
#   2. Cross-configures them as federation peers: each pins the other's
#      seed-derived server DID via AWEB_FEDERATION_PEERS, and each derives its own
#      server key from a fixed AWEB_FEDERATION_SIGNING_SEED. Verifies the pin
#      against each live GET /v1/federation/server-key.
#   3. Token-onboards a human on each stack (Better Auth sign-up -> membership ->
#      JWT -> `AW_TOKEN aw init`) to prove the membership/token model boots and
#      that recipients are resolved by membership on their HOME server.
#   4. Seeds a self-custodial (real Ed25519 did:key) recipient agent on each
#      home server — this is what the A.2 receive path resolves locally. The
#      sender's self-custodial key is generated in-harness. The inner envelope
#      and outer assertion are produced by the SERVER'S OWN code (run via
#      `compose exec aweb python`), so the canonical-JSON / signing bytes are
#      byte-identical to production — no reimplementation drift.
#   5. HAPPY PATH: stack A vouches + delivers a cross-server mail to stack B's
#      recipient; asserts B stored + delivered it (the full inbound chain ran).
#      Reverse (B -> A) for mutuality.
#   6. ATTACKS against the LIVE receiver (each MUST be rejected):
#        - un-allowlisted origin           -> 403
#        - outer sig from a non-pinned key -> 403
#        - tampered inner payload          -> 422
#        - replayed message_id (same id)   -> idempotent 200, then 409 on
#                                             conflicting content
#   7. Teardown both stacks (compose down -v).
#
# Why direct federated POST (not `aw mail send` across stacks): commit 7825fe3b
# shipped the SERVER receive/send wire + config, but did NOT ship a CLI
# self-custodial federated-send path, and the outbound first-contact `external`
# trigger still depends on an awid resolve that A.2 deliberately removes from the
# trust path. The faithful, registry-free way to drive a genuine cross-stack
# delivery is therefore to build the real signed FederatedDeliveryRequest with
# the server's own modules and POST it to the peer's /v1/federation/messages —
# exactly the wire two cooperating aweb servers speak. This exercises the entire
# implemented A.2 mechanism on a LIVE peer. The residual CLI-origination gap is
# documented in PIVOT-FOLLOWUPS.md §2.
#
# Usage:
#   ./scripts/e2e-oss-federation.sh
#
# Requirements: Docker + Docker Compose, Go toolchain, curl, python3.
#
# Forbidden host ports (must NOT be bound): 3000, 3001, 8000, 6379, 5173-5175,
# and the running dev stack on 3030/8088/5544/6390. This journey publishes only
# safe ports and keeps Postgres/Redis INTERNAL, so it never collides.
#
# Environment overrides:
#   AWEB_FED_E2E_BUILD   set to 0 to skip docker compose build
#   AWEB_FED_E2E_KEEP    set to 1 to leave containers/temp dir for debugging

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

# ---- Disjoint SAFE host ports for the two stacks ----------------------------
# Stack A: UI 3036, aweb 8091.  Stack B: UI 3037, aweb 8092.
# None overlap the forbidden set or the dev stack (3030/8088/5544/6390).
A_UI_PORT=3036
A_AWEB_PORT=8091
B_UI_PORT=3037
B_AWEB_PORT=8092

A_AWEB_URL="http://localhost:$A_AWEB_PORT"
B_AWEB_URL="http://localhost:$B_AWEB_PORT"
A_UI_URL="http://localhost:$A_UI_PORT"
B_UI_URL="http://localhost:$B_UI_PORT"

# Addressing domains + public delivery origins (what each server advertises and
# what the peer pins / POSTs to). Use the host-reachable URL so the harness can
# verify server-key advertisement from the host; the in-network POST is made by
# the harness from the host too, so a host-reachable origin is correct here.
A_DOMAIN="local"
B_DOMAIN="local"
A_ORIGIN="$A_AWEB_URL"
B_ORIGIN="$B_AWEB_URL"

# Distinct compose projects so volumes/containers/networks never clash.
A_PROJECT="aweb-fed-e2e-a-$$"
B_PROJECT="aweb-fed-e2e-b-$$"

TEAM_ID="default:local"
PG_PASSWORD="aweb-fed-e2e-pw"

E2E_ROOT="$(make_temp_dir aw-fed-e2e)"
E2E_HOME="$E2E_ROOT/home"
A_ENV_FILE="$E2E_ROOT/.env.a"
B_ENV_FILE="$E2E_ROOT/.env.b"
A_OVERLAY="$E2E_ROOT/overlay.a.yml"
B_OVERLAY="$E2E_ROOT/overlay.b.yml"
A_WS="$E2E_ROOT/ws-a"
B_WS="$E2E_ROOT/ws-b"
mkdir -p "$E2E_HOME/.config/aw" "$A_WS" "$B_WS"

pass=0
fail=0

compose_a() {
  docker compose -p "$A_PROJECT" \
    --env-file "$A_ENV_FILE" \
    -f "$SERVER_DIR/docker-compose.yml" \
    -f "$SERVER_DIR/docker-compose.ui.yml" \
    -f "$A_OVERLAY" \
    "$@"
}

compose_b() {
  docker compose -p "$B_PROJECT" \
    --env-file "$B_ENV_FILE" \
    -f "$SERVER_DIR/docker-compose.yml" \
    -f "$SERVER_DIR/docker-compose.ui.yml" \
    -f "$B_OVERLAY" \
    "$@"
}

cleanup() {
  local status=$?
  echo ""
  echo "--- Cleanup ---"
  if [[ "${AWEB_FED_E2E_KEEP:-0}" == "1" ]]; then
    echo "Keeping e2e artifacts for debugging:"
    echo "  projects: $A_PROJECT  $B_PROJECT"
    echo "  root:     $E2E_ROOT"
  else
    if [[ -f "$A_ENV_FILE" && -f "$A_OVERLAY" ]]; then
      compose_a down -v 2>/dev/null || true
    fi
    if [[ -f "$B_ENV_FILE" && -f "$B_OVERLAY" ]]; then
      compose_b down -v 2>/dev/null || true
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

# psql against a stack's internal Postgres (no published PG port).
psql_a_scalar() { compose_a exec -T postgres psql -U aweb -d aweb -Atq -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null | tr -d '\r' | tail -n 1; }
psql_a_exec()   { compose_a exec -T postgres psql -U aweb -d aweb -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }
psql_b_scalar() { compose_b exec -T postgres psql -U aweb -d aweb -Atq -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null | tr -d '\r' | tail -n 1; }
psql_b_exec()   { compose_b exec -T postgres psql -U aweb -d aweb -v ON_ERROR_STOP=1 -c "$1" >/dev/null; }

json_get() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))" 2>/dev/null || true; }

# Headless JWT bootstrap against a stack's UI (mirrors ui/e2e/global-setup.ts +
# the user-journey). Echoes the JWT (empty on failure). Args: ui_url, psql_exec
# fn name, psql_scalar fn name, email, name, role.
mint_token() {
  local ui_url="$1" pexec="$2" pscalar="$3" email="$4" name="$5" role="$6"
  curl -sf -X POST "$ui_url/api/auth/sign-up/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Test1234!pass\",\"name\":\"$name\"}" \
    >/dev/null 2>&1 || true
  local user_id
  user_id="$($pscalar "SELECT id FROM aweb.\"user\" WHERE email='$email' LIMIT 1")"
  if [[ -z "$user_id" ]]; then return 0; fi
  $pexec "INSERT INTO aweb.memberships (subject, team_id, role, status)
          VALUES ('$user_id','$TEAM_ID','$role','active')
          ON CONFLICT (subject, team_id) DO UPDATE SET role='$role', status='active'" || true
  local cookie token
  cookie="$(curl -sf -D - -o /dev/null -X POST "$ui_url/api/auth/sign-in/email" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"Test1234!pass\"}" 2>/dev/null \
    | tr -d '\r' | awk 'tolower($1)=="set-cookie:"{print $2}' | cut -d';' -f1 | paste -sd';' -)"
  token="$(curl -sf "$ui_url/api/auth/token" \
    -H 'accept: application/json' -H "cookie: $cookie" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token",""))' 2>/dev/null || true)"
  printf '%s' "$token"
}

run_aw_in() {
  local token="$1" workdir="$2"
  shift 2
  HOME="$E2E_HOME" \
  AW_CONFIG_PATH="$E2E_HOME/.config/aw/config.yaml" \
  AW_NO_UPDATE_CHECK=1 \
  AW_TOKEN="$token" \
  bash -c 'cd "$1" && shift && exec "$@"' _ "$workdir" "$AW" "$@"
}

# Host-side python with the server venv (PyNaCl + awid + aweb importable). Used
# for offline key/DID derivation BEFORE the stacks boot (peer pinning) and for
# uuid generation. Reads a script from stdin. The in-container signer uses the
# container python instead (canonical bytes identical to the live server).
pyhost() {
  ( cd "$SERVER_DIR" && uv run --quiet python "$@" )
}

# Derive a did:key from a base64 32-byte seed (host venv).
did_from_seed() {
  printf '%s' "$1" | pyhost -c '
import sys, base64
from nacl.signing import SigningKey
from awid.did import did_from_public_key
raw = sys.stdin.read().strip(); raw += "=" * (-len(raw) % 4)
print(did_from_public_key(bytes(SigningKey(base64.b64decode(raw)).verify_key)))
'
}

# A deterministic base64 32-byte seed from a label (host venv-independent: stdlib).
seed_from_label() {
  printf '%s' "$1" | pyhost -c 'import sys,hashlib,base64;print(base64.b64encode(hashlib.sha256(sys.stdin.buffer.read()).digest()).decode())'
}

new_uuid() { pyhost -c 'import uuid;print(uuid.uuid4())'; }

# ---------------------------------------------------------------------------
# The federated-request signer. Runs INSIDE a stack's aweb container so the
# canonical-JSON / Ed25519 signing is byte-identical to the live server. Reads a
# spec JSON on stdin; emits the full FederatedDeliveryRequest JSON on stdout.
#
# spec fields:
#   server_seed_b64   : 32-byte base64 seed for the OUTER server signature
#                       (use the WRONG seed to exercise the non-pinned-key attack)
#   server_origin     : assertion server_origin (un-allowlisted origin attack
#                       sets this to a value the receiver does not pin)
#   sender_seed_b64   : 32-byte base64 seed for alice's self-custodial key
#   sender_address    : domain/name
#   sender_did_aw     : did:aw:... routing id
#   target_address    : domain/name (resolved locally by the receiver)
#   target_did_aw     : did:aw:... of the seeded recipient
#   target_did_key    : recipient's real did:key (== seeded agents.did_key)
#   target_origin     : receiver's public delivery origin
#   subject, body
#   message_id, conversation_id : optional (default fresh uuids)
#   tamper_body       : if set, mutate envelope.body AFTER signing+vouching
#                       (envelope_hash attack)
# ---------------------------------------------------------------------------
FED_SIGNER='
import sys, json, hashlib, base64
from datetime import datetime, timezone
from uuid import uuid4
from nacl.signing import SigningKey
from awid.did import did_from_public_key
from awid.signing import canonical_json_bytes, sign_message
from aweb.federation.envelope import (
    FederationEnvelope, ServerDeliveryAssertion,
    assertion_signing_bytes, compute_envelope_hash,
)

spec = json.load(sys.stdin)

def seed(b64):
    raw = b64.strip()
    raw += "=" * (-len(raw) % 4)
    return base64.b64decode(raw)

now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
message_id = spec.get("message_id") or str(uuid4())
conversation_id = spec.get("conversation_id") or str(uuid4())

sender_sk = SigningKey(seed(spec["sender_seed_b64"]))
sender_did_key = did_from_public_key(bytes(sender_sk.verify_key))

sender_address = spec["sender_address"]
target_address = spec["target_address"]
subject = spec.get("subject", "federated hello")
body = spec.get("body", "hello cross-server over A.2")

signed = canonical_json_bytes({
    "body": body,
    "conversation_id": conversation_id,
    "from": sender_address,
    "from_did": sender_did_key,
    "from_stable_id": spec["sender_did_aw"],
    "message_id": message_id,
    "priority": "normal",
    "subject": subject,
    "timestamp": now,
    "to": target_address,
    "to_did": spec["target_did_key"],
    "to_stable_id": spec["target_did_aw"],
    "type": "mail",
}).decode()
inner_sig = sign_message(bytes(sender_sk), signed.encode())

envelope = FederationEnvelope(
    version=1, type="mail",
    sender_did_aw=spec["sender_did_aw"],
    sender_current_did_key=sender_did_key,
    sender_address=sender_address,
    sender_delivery_origin=spec["server_origin"],
    target_address=target_address,
    target_did_aw=spec["target_did_aw"],
    target_current_did_key=spec["target_did_key"],
    target_delivery_origin=spec["target_origin"],
    body=body, message_id=message_id, timestamp=now,
    signed_payload=signed, conversation_id=conversation_id,
    subject=subject, priority="normal",
)

assertion = ServerDeliveryAssertion(
    version=1,
    server_origin=spec["server_origin"],
    sender_did_key=sender_did_key,
    sender_address=sender_address,
    target_address=target_address,
    envelope_hash=compute_envelope_hash(envelope),
    message_id=envelope.message_id,
    timestamp=envelope.timestamp,
    nonce=str(uuid4()),
    server_signature="placeholder",
)
server_sk = seed(spec["server_seed_b64"])
assertion = assertion.model_copy(update={
    "server_signature": sign_message(server_sk, assertion_signing_bytes(assertion))
})

out = {
    "envelope": envelope.model_dump(mode="json", exclude_none=True),
    "signature": inner_sig,
    "assertion": assertion.model_dump(mode="json"),
}
# envelope_hash tamper: mutate the inner body AFTER vouching so the assertion
# envelope_hash no longer matches (receiver rejects at the binding step).
if spec.get("tamper_body"):
    out["envelope"]["body"] = spec["tamper_body"]
print(json.dumps(out))
'

# Run the signer in stack A or B container. Args: <a|b> <spec-json>
sign_fed_request() {
  local stack="$1" spec="$2"
  if [[ "$stack" == "a" ]]; then
    printf '%s' "$spec" | compose_a exec -T aweb python -c "$FED_SIGNER"
  else
    printf '%s' "$spec" | compose_b exec -T aweb python -c "$FED_SIGNER"
  fi
}

# POST a FederatedDeliveryRequest to a receiver's public origin; echo HTTP code.
post_fed() {
  local target_url="$1" body="$2" outfile="$3"
  curl -s -o "$outfile" -w '%{http_code}' \
    -X POST "$target_url/v1/federation/messages" \
    -H 'content-type: application/json' \
    --data-binary "$body" 2>/dev/null || echo 000
}

# ---------------------------------------------------------------------------
# Phase 0: Build CLI
# ---------------------------------------------------------------------------
echo "=== Phase 0: Build aw CLI ==="
cd "$CLI_DIR"
if ! go build -o "$AW" ./cmd/aw 2>&1 | tail -5; then
  echo "  FATAL: CLI build failed"
  exit 1
fi
echo "  aw binary: $AW"
echo ""

# ---------------------------------------------------------------------------
# Phase 1: Write env + overlay for each stack (cross-pinned peers)
# ---------------------------------------------------------------------------
echo "=== Phase 1: Configure two cross-pinned federation peers ==="

# Fixed 32-byte seeds (base64) so each server's signing key is deterministic and
# the peer pin is stable. Derived from a constant label per stack via the server
# venv (PyNaCl + awid).
A_SEED="$(seed_from_label 'aweb-fed-e2e-stack-A-signing-seed')"
B_SEED="$(seed_from_label 'aweb-fed-e2e-stack-B-signing-seed')"

# Derive each stack's server DID from its seed (offline) so we can pre-pin the
# peer before boot, then verify the live /server-key endpoint matches it.
A_DID="$(did_from_seed "$A_SEED" 2>/dev/null || true)"
B_DID="$(did_from_seed "$B_SEED" 2>/dev/null || true)"

if [[ -z "$A_DID" || -z "$B_DID" ]]; then
  echo "  FATAL: could not derive server DIDs from seeds (server venv unavailable)."
  echo "         Ensure 'cd server && uv run python' works (uv + PyNaCl + awid)."
  exit 1
fi
echo "  Stack A server DID: $A_DID"
echo "  Stack B server DID: $B_DID"

# A pins B; B pins A. addressing_domain is the recipient address domain.
A_PEERS_JSON="$(pyhost -c "import json;print(json.dumps({'peers':[{'addressing_domain':'$B_DOMAIN','delivery_origin':'$B_ORIGIN','pinned_server_did':'$B_DID'}]}))")"
B_PEERS_JSON="$(pyhost -c "import json;print(json.dumps({'peers':[{'addressing_domain':'$A_DOMAIN','delivery_origin':'$A_ORIGIN','pinned_server_did':'$A_DID'}]}))")"

write_env() {
  local file="$1" ui_port="$2" aweb_port="$3" aweb_url="$4" seed="$5" peers="$6"
  cat > "$file" <<EOF
POSTGRES_USER=aweb
POSTGRES_PASSWORD=$PG_PASSWORD
POSTGRES_DB=aweb
UI_PORT=$ui_port
AWEB_PORT=$aweb_port
AWID_PORT=0
AWEB_PUBLIC_ORIGIN=$aweb_url
AWID_REGISTRY_URL=http://awid:8010
AWID_PUBLIC_REGISTRY_URL=http://awid:8010
AWEB_LOG_JSON=true
AWID_LOG_JSON=true
AWID_RATE_LIMIT_BACKEND=redis
AWID_RATE_LIMIT_DISABLED=1
AWID_SKIP_DNS_VERIFY=1
BETTER_AUTH_SECRET=oss-fed-e2e-better-auth-secret-32chars
AWEB_MEMBERSHIPS_HINT_KEY=oss-fed-e2e-shared-hint-key
AWEB_FEDERATION_SIGNING_SEED=$seed
AWEB_FEDERATION_PEERS=$peers
EOF
}

write_overlay() {
  local file="$1" ui_url="$2" aweb_url="$3"
  cat > "$file" <<EOF
services:
  ui-migrate:
    environment:
      BETTER_AUTH_URL: $ui_url
  ui:
    environment:
      BETTER_AUTH_URL: $ui_url
      AWEB_JWT_AUDIENCE: $aweb_url
  aweb:
    environment:
      AWEB_TOKEN_AUTH_JWKS_URL: http://ui:3000/api/auth/jwks
      AWEB_TOKEN_AUTH_ISSUER: $ui_url
      AWEB_TOKEN_AUTH_AUDIENCE: $aweb_url
      AWEB_CORS_ORIGINS: $ui_url
      AWEB_FEDERATION_SIGNING_SEED: \${AWEB_FEDERATION_SIGNING_SEED}
      AWEB_FEDERATION_PEERS: \${AWEB_FEDERATION_PEERS}
EOF
}

write_env "$A_ENV_FILE" "$A_UI_PORT" "$A_AWEB_PORT" "$A_AWEB_URL" "$A_SEED" "$A_PEERS_JSON"
write_env "$B_ENV_FILE" "$B_UI_PORT" "$B_AWEB_PORT" "$B_AWEB_URL" "$B_SEED" "$B_PEERS_JSON"
write_overlay "$A_OVERLAY" "$A_UI_URL" "$A_AWEB_URL"
write_overlay "$B_OVERLAY" "$B_UI_URL" "$B_AWEB_URL"
echo "  env + overlay written for both stacks"
echo ""

# ---------------------------------------------------------------------------
# Phase 2: Boot both stacks
# ---------------------------------------------------------------------------
echo "=== Phase 2: Start stack A + stack B (aweb + UI + pg + redis) ==="
compose_a down -v 2>/dev/null || true
compose_b down -v 2>/dev/null || true
if [[ "${AWEB_FED_E2E_BUILD:-1}" != "0" ]]; then
  compose_a build
  compose_b build
fi
compose_a up -d
compose_b up -d

wait_health() {
  local url="$1" name="$2"
  for _ in $(seq 1 60); do
    curl -sf "$url/health" >/dev/null 2>&1 && break
    sleep 2
  done
  curl -sf "$url/health" 2>/dev/null | json_get status
}

a_status="$(wait_health "$A_AWEB_URL" "A")"
b_status="$(wait_health "$B_AWEB_URL" "B")"
assert_eq "stack A aweb health" "ok" "$a_status"
assert_eq "stack B aweb health" "ok" "$b_status"

if [[ "$a_status" != "ok" || "$b_status" != "ok" ]]; then
  echo "  Services not healthy, aborting."
  echo "  --- stack A logs (tail) ---"; compose_a logs 2>&1 | tail -30
  echo "  --- stack B logs (tail) ---"; compose_b logs 2>&1 | tail -30
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Phase 3: Verify each server advertises the pinned key (server-key endpoint)
# ---------------------------------------------------------------------------
echo "=== Phase 3: /v1/federation/server-key advertisement matches the pin ==="
a_pub="$(curl -sf "$A_AWEB_URL/v1/federation/server-key" 2>/dev/null | json_get public_did)"
b_pub="$(curl -sf "$B_AWEB_URL/v1/federation/server-key" 2>/dev/null | json_get public_did)"
assert_eq "stack A advertises its seed-derived DID" "$A_DID" "$a_pub"
assert_eq "stack B advertises its seed-derived DID" "$B_DID" "$b_pub"
# And each pins exactly the other's advertised DID (mutual allowlist).
assert_eq "A pins B's advertised DID" "$b_pub" "$B_DID"
assert_eq "B pins A's advertised DID" "$a_pub" "$A_DID"
echo ""

# ---------------------------------------------------------------------------
# Phase 4: Token onboarding on each home server (membership model)
# ---------------------------------------------------------------------------
echo "=== Phase 4: Token onboarding (Better Auth JWT) on each stack ==="
# Team rows (FK target for memberships) on each stack.
psql_a_exec "INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key)
             VALUES ('$TEAM_ID','$A_DOMAIN','default','did:key:zE2EPLACEHOLDERA')
             ON CONFLICT (team_id) DO NOTHING"
psql_b_exec "INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key)
             VALUES ('$TEAM_ID','$B_DOMAIN','default','did:key:zE2EPLACEHOLDERB')
             ON CONFLICT (team_id) DO NOTHING"

wait_ui() {
  local url="$1"
  for _ in $(seq 1 90); do
    curl -sf "$url/api/auth/jwks" >/dev/null 2>&1 && { echo 1; return; }
    sleep 2
  done
  echo 0
}
a_ui_up="$(wait_ui "$A_UI_URL")"
b_ui_up="$(wait_ui "$B_UI_URL")"
assert_eq "stack A UI issuer reachable" "1" "$a_ui_up"
assert_eq "stack B UI issuer reachable" "1" "$b_ui_up"

A_JWT="$(mint_token "$A_UI_URL" psql_a_exec psql_a_scalar "alice@a.test" "Alice" "admin")"
B_JWT="$(mint_token "$B_UI_URL" psql_b_exec psql_b_scalar "bob@b.test" "Bob" "admin")"
assert_not_empty "stack A JWT minted (alice)" "$A_JWT"
assert_not_empty "stack B JWT minted (bob)" "$B_JWT"

# Onboard token-only on each home server (proves membership-based onboarding).
a_init="$(run_aw_in "$A_JWT" "$A_WS" init --aweb-url "$A_AWEB_URL" --team "$TEAM_ID" --do-not-touch-agents-md --json 2>&1 || true)"
b_init="$(run_aw_in "$B_JWT" "$B_WS" init --aweb-url "$B_AWEB_URL" --team "$TEAM_ID" --do-not-touch-agents-md --json 2>&1 || true)"
assert_eq "alice onboarded on A (connected)" "1" "$(echo "$a_init" | grep -qi connected && echo 1 || echo 0)"
assert_eq "bob onboarded on B (connected)" "1" "$(echo "$b_init" | grep -qi connected && echo 1 || echo 0)"
echo ""

# ---------------------------------------------------------------------------
# Phase 5: Seed self-custodial recipients in each home directory (A.2 local
# resolution target). These are the rows the receive path resolves WITHOUT awid.
# ---------------------------------------------------------------------------
echo "=== Phase 5: Seed self-custodial cross-server recipients ==="
# Recipient on B (target of A->B mail): bob-fed @ local/bob-fed, global scope.
BOB_FED_SEED="$(seed_from_label 'aweb-fed-e2e-bob-fed-key')"
BOB_FED_DIDKEY="$(did_from_seed "$BOB_FED_SEED")"
psql_b_exec "INSERT INTO aweb.agents (team_id, did_key, did_aw, address, alias, identity_scope, role, inbound_mode)
             VALUES ('$TEAM_ID','$BOB_FED_DIDKEY','did:aw:bobfed','$B_DOMAIN/bob-fed','bob-fed','global','developer','open')
             ON CONFLICT DO NOTHING"

# Recipient on A (target of B->A mail): alice-fed @ local/alice-fed, global scope.
ALICE_FED_SEED="$(seed_from_label 'aweb-fed-e2e-alice-fed-key')"
ALICE_FED_DIDKEY="$(did_from_seed "$ALICE_FED_SEED")"
psql_a_exec "INSERT INTO aweb.agents (team_id, did_key, did_aw, address, alias, identity_scope, role, inbound_mode)
             VALUES ('$TEAM_ID','$ALICE_FED_DIDKEY','did:aw:alicefed','$A_DOMAIN/alice-fed','alice-fed','global','developer','open')
             ON CONFLICT DO NOTHING"

assert_eq "bob-fed seeded on B" "1" "$(psql_b_scalar "SELECT COUNT(*) FROM aweb.agents WHERE did_aw='did:aw:bobfed'")"
assert_eq "alice-fed seeded on A" "1" "$(psql_a_scalar "SELECT COUNT(*) FROM aweb.agents WHERE did_aw='did:aw:alicefed'")"
echo ""

# Sender self-custodial keys (the vouched-for participant keys).
ALICE_SENDER_SEED="$(seed_from_label 'aweb-fed-e2e-alice-sender-key')"
BOB_SENDER_SEED="$(seed_from_label 'aweb-fed-e2e-bob-sender-key')"

# ---------------------------------------------------------------------------
# Phase 6: HAPPY PATH — A vouches + delivers to B; then B -> A (mutuality)
# ---------------------------------------------------------------------------
echo "=== Phase 6: Happy path cross-server delivery (A->B, then B->A) ==="

AB_MID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
AB_CID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
ab_spec="$(python3 -c "
import json
print(json.dumps({
  'server_seed_b64':'$A_SEED','server_origin':'$A_ORIGIN',
  'sender_seed_b64':'$ALICE_SENDER_SEED',
  'sender_address':'$A_DOMAIN/alice','sender_did_aw':'did:aw:alice',
  'target_address':'$B_DOMAIN/bob-fed','target_did_aw':'did:aw:bobfed',
  'target_did_key':'$BOB_FED_DIDKEY','target_origin':'$B_ORIGIN',
  'subject':'A2.federated.AtoB','body':'hello bob from alice over A.2',
  'message_id':'$AB_MID','conversation_id':'$AB_CID',
}))")"
ab_req="$(sign_fed_request a "$ab_spec")"
assert_not_empty "A built signed federated request" "$ab_req"
ab_out="$E2E_ROOT/ab.json"
ab_code="$(post_fed "$B_AWEB_URL" "$ab_req" "$ab_out")"
assert_status "B accepts A's vouched delivery" "200" "$ab_code"
[[ "$ab_code" != "200" ]] && echo "    B response: $(cat "$ab_out" 2>/dev/null | head -c 300)"
# B stored the message addressed to bob-fed (full inbound chain ran).
assert_eq "B stored the federated mail for bob-fed" "1" \
  "$(psql_b_scalar "SELECT COUNT(*) FROM aweb.messages WHERE message_id='$AB_MID' AND to_did='did:aw:bobfed'")"

BA_MID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
BA_CID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
ba_spec="$(python3 -c "
import json
print(json.dumps({
  'server_seed_b64':'$B_SEED','server_origin':'$B_ORIGIN',
  'sender_seed_b64':'$BOB_SENDER_SEED',
  'sender_address':'$B_DOMAIN/bob','sender_did_aw':'did:aw:bob',
  'target_address':'$A_DOMAIN/alice-fed','target_did_aw':'did:aw:alicefed',
  'target_did_key':'$ALICE_FED_DIDKEY','target_origin':'$A_ORIGIN',
  'subject':'A2.federated.BtoA','body':'hello alice from bob over A.2',
  'message_id':'$BA_MID','conversation_id':'$BA_CID',
}))")"
ba_req="$(sign_fed_request b "$ba_spec")"
ba_out="$E2E_ROOT/ba.json"
ba_code="$(post_fed "$A_AWEB_URL" "$ba_req" "$ba_out")"
assert_status "A accepts B's vouched delivery (mutuality)" "200" "$ba_code"
[[ "$ba_code" != "200" ]] && echo "    A response: $(cat "$ba_out" 2>/dev/null | head -c 300)"
assert_eq "A stored the federated mail for alice-fed" "1" \
  "$(psql_a_scalar "SELECT COUNT(*) FROM aweb.messages WHERE message_id='$BA_MID' AND to_did='did:aw:alicefed'")"
echo ""

# ---------------------------------------------------------------------------
# Phase 7: ATTACKS against the LIVE receiver B (each MUST be rejected)
# ---------------------------------------------------------------------------
echo "=== Phase 7: Adversarial cases (live B must reject each) ==="

# 7a. Un-allowlisted origin -> 403 (before any crypto).
mk_spec() {  # mk_spec <server_seed> <server_origin> <extra-json>
  python3 -c "
import json,uuid
base={
  'server_seed_b64':'$1','server_origin':'$2',
  'sender_seed_b64':'$ALICE_SENDER_SEED',
  'sender_address':'$A_DOMAIN/alice','sender_did_aw':'did:aw:alice',
  'target_address':'$B_DOMAIN/bob-fed','target_did_aw':'did:aw:bobfed',
  'target_did_key':'$BOB_FED_DIDKEY','target_origin':'$B_ORIGIN',
  'subject':'attack','body':'attack body',
  'message_id':str(uuid.uuid4()),'conversation_id':str(uuid.uuid4()),
}
extra=json.loads('''$3''' or '{}')
base.update(extra)
print(json.dumps(base))"
}

evil_spec="$(mk_spec "$A_SEED" "http://localhost:9999" '{}')"
evil_req="$(sign_fed_request a "$evil_spec")"
evil_out="$E2E_ROOT/evil.json"
evil_code="$(post_fed "$B_AWEB_URL" "$evil_req" "$evil_out")"
assert_status "un-allowlisted origin rejected" "403" "$evil_code"

# 7b. Outer sig from a NON-PINNED key -> 403. Vouch with B's own seed (which is
# NOT the key B pins for A's origin) while keeping A's origin allowlisted.
nonpinned_spec="$(mk_spec "$B_SEED" "$A_ORIGIN" '{}')"
nonpinned_req="$(sign_fed_request a "$nonpinned_spec")"
nonpinned_out="$E2E_ROOT/nonpinned.json"
nonpinned_code="$(post_fed "$B_AWEB_URL" "$nonpinned_req" "$nonpinned_out")"
assert_status "outer sig from non-pinned key rejected" "403" "$nonpinned_code"

# 7c. Tampered inner payload -> 422 (envelope_hash no longer matches).
tamper_spec="$(mk_spec "$A_SEED" "$A_ORIGIN" '{"tamper_body":"tampered after vouching"}')"
tamper_req="$(sign_fed_request a "$tamper_spec")"
tamper_out="$E2E_ROOT/tamper.json"
tamper_code="$(post_fed "$B_AWEB_URL" "$tamper_req" "$tamper_out")"
assert_status "tampered inner payload rejected" "422" "$tamper_code"

# 7d. Replay: re-POST a delivered message_id -> idempotent 200 (same content),
# then 409 when the SAME message_id carries different content.
RID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
RCID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
replay_spec="$(python3 -c "
import json
print(json.dumps({
  'server_seed_b64':'$A_SEED','server_origin':'$A_ORIGIN',
  'sender_seed_b64':'$ALICE_SENDER_SEED',
  'sender_address':'$A_DOMAIN/alice','sender_did_aw':'did:aw:alice',
  'target_address':'$B_DOMAIN/bob-fed','target_did_aw':'did:aw:bobfed',
  'target_did_key':'$BOB_FED_DIDKEY','target_origin':'$B_ORIGIN',
  'subject':'replay','body':'replay-body','message_id':'$RID','conversation_id':'$RCID',
}))")"
r1_req="$(sign_fed_request a "$replay_spec")"
r1_out="$E2E_ROOT/r1.json"
r1_code="$(post_fed "$B_AWEB_URL" "$r1_req" "$r1_out")"
assert_status "replay: first delivery accepted" "200" "$r1_code"
# Re-sign the SAME content (fresh nonce) and re-POST -> idempotent 200.
r2_req="$(sign_fed_request a "$replay_spec")"
r2_out="$E2E_ROOT/r2.json"
r2_code="$(post_fed "$B_AWEB_URL" "$r2_req" "$r2_out")"
assert_status "replay: identical re-delivery idempotent" "200" "$r2_code"
# Same message_id, DIFFERENT body -> 409.
conflict_spec="$(python3 -c "
import json
print(json.dumps({
  'server_seed_b64':'$A_SEED','server_origin':'$A_ORIGIN',
  'sender_seed_b64':'$ALICE_SENDER_SEED',
  'sender_address':'$A_DOMAIN/alice','sender_did_aw':'did:aw:alice',
  'target_address':'$B_DOMAIN/bob-fed','target_did_aw':'did:aw:bobfed',
  'target_did_key':'$BOB_FED_DIDKEY','target_origin':'$B_ORIGIN',
  'subject':'replay','body':'DIFFERENT body same id','message_id':'$RID','conversation_id':'$RCID',
}))")"
c_req="$(sign_fed_request a "$conflict_spec")"
c_out="$E2E_ROOT/c.json"
c_code="$(post_fed "$B_AWEB_URL" "$c_req" "$c_out")"
assert_status "replay: same id different content conflicts" "409" "$c_code"
# Exactly one stored row for that message_id.
assert_eq "replay stored exactly once" "1" \
  "$(psql_b_scalar "SELECT COUNT(*) FROM aweb.messages WHERE message_id='$RID'")"
echo ""

echo "=== Done ==="

#!/usr/bin/env bash
#
# End-to-end A2A gateway Docker journey — QUARANTINED by the token-only pivot.
#
# HONEST RUN STATUS: this journey CANNOT pass today, and it is intentionally not
# dressed up to look like it can. It exits non-zero with the explanation below.
#
# Why it is quarantined
# ---------------------
# UPDATE (token-only pivot follow-up): the Go-level blocker below is RESOLVED.
# The OSS gateway's `workspaceMailClient` now has a token-only branch
# (`cli/go/cmd/aweb-a2a-gw/token_auth.go`): a cert-less workspace builds an
# `awid.Client` via `SetBearerProvider` from `AW_TOKEN` / `~/.aw/token`, sending
# `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id` instead of the cert/DIDKey
# path. Verified live against a token-only `aw init` workspace + aweb :8088
# (authenticated ListAgents -> 200, no cert error). So blocker #2 is GONE.
#
# It stays quarantined because the remaining blockers are bash/Docker-shaped and
# were not validated green in this pass:
#
# 1. ONBOARDING (removed CLI): the journey still drives removed commands —
#    `aw id create`, `aw id team create / invite / accept-invite`, and
#    `aw init --url`. The pivot removed all of these (`--url` is now
#    `--aweb-url`; the `aw id team` / `aw id create` cluster is gone). The
#    journey must be rewritten to mint a JWT and run `AW_TOKEN=$JWT aw init
#    --aweb-url --team` instead.
#
# 2. HEALTH GATE / gateway_identity: the gateway's runtime health still asserts
#    awid-registry reachability/compatibility and (in AC mode) an active global
#    `gateway_identity`, which token-only onboarding does not provision. The
#    workspace (non-AC) path reports identity status "workspace"/usable, so a
#    token-only journey should target that mode; the health expectations in this
#    script need revisiting accordingly.
#
# 3. FULL DOCKER STACK: the journey must stand up the full stack (incl. the UI
#    issuer for JWT minting) on safe ports and drive a real A2A round-trip; that
#    rewrite + a green Docker run is the remaining work and was not done here.
#
# RESOLVED (this pass) — keep for the record:
#   [done] Add a token-only branch to `workspaceMailClient` that builds an
#          `awid.Client` via `SetBearerProvider` from `AW_TOKEN` / `~/.aw/token`,
#          mirroring the channel product's token-only path (PIVOT-FOLLOWUPS.md §1).
#   [todo] Decide how (or whether) the gateway needs a global `gateway_identity`
#          and awid registry in the token-only world, and relax the health gate.
#   [todo] Then rewrite this journey to: stand up the full stack (incl. the UI
#      issuer) on safe ports like scripts/e2e-oss-user-journey.sh does, mint a
#      JWT for the gateway + personal identities, `AW_TOKEN=$JWT aw init
#      --aweb-url --team`, point the gateway at the token-only workspace, and
#      drive SendMessage -> aweb mail -> reply -> GetTask.
#
# The Go-level A2A signal that DOES pass post-pivot is `make test-a2a`
# (conformance + a2a/a2agw packages + the awid a2a-publication pytest + copy
# guardrails). Use that as the reliable local A2A gate until the gateway gains a
# token transport.
#
# See ai-completion/PIVOT-FOLLOWUPS.md §2 for the full record.

set -euo pipefail

cat >&2 <<'MSG'
=== A2A gateway Docker e2e: QUARANTINED (Go blocker resolved; bash/Docker rewrite pending) ===

The gateway's mail transport is no longer cert-only: workspaceMailClient
(cli/go/cmd/aweb-a2a-gw/token_auth.go) now bearer-authenticates token-only
workspaces (Authorization: Bearer <jwt> + X-AWEB-Team-Id), verified live.

This journey still cannot pass unmodified because:
  (1) it drives removed onboarding commands (aw id create / aw id team /
      aw init --url) and must be rewritten to AW_TOKEN=$JWT aw init
      --aweb-url --team, AND
  (2) it needs a full Docker stack (incl. the UI issuer to mint a JWT) and a
      revisited health gate before a real A2A round-trip can run green.

Reliable A2A gate post-pivot:
  make test-a2a   (conformance + a2a/a2agw packages + awid a2a-publication)

See ai-completion/PIVOT-FOLLOWUPS.md §2.
MSG

exit 1

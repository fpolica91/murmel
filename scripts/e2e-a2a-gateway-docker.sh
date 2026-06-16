#!/usr/bin/env bash
#
# End-to-end A2A gateway Docker journey — QUARANTINED by the token-only pivot.
#
# HONEST RUN STATUS: this journey CANNOT pass today, and it is intentionally not
# dressed up to look like it can. It exits non-zero with the explanation below.
#
# Why it is quarantined
# ---------------------
# Two independent blockers, both rooted in the token-only pivot:
#
# 1. ONBOARDING (removed CLI): the journey provisioned its identities/team with
#    `aw id create`, `aw id team create / invite / accept-invite`, and onboarded
#    with `aw init --url`. All of those were removed by the pivot
#    (`--url` is now `--aweb-url`; the whole `aw id team` / `aw id create`
#    cluster is gone). That part is a mechanical rewrite, but...
#
# 2. THE GATEWAY ITSELF IS STILL CERT-ONLY (Go code, not a script bug). The OSS
#    gateway builds its aweb mail transport in
#    `cli/go/cmd/aweb-a2a-gw/main.go:workspaceMailClient`, which HARD-REQUIRES a
#    team certificate:
#      - errors with "missing cert_path" when the workspace has no cert,
#      - calls `awid.LoadTeamCertificate` + `awid.NewWithCertificate`,
#      - cross-checks the local signing key against `cert.MemberDIDKey`,
#      - resolves recipients through the awid registry.
#    Token-only `aw init` writes a CERT-LESS workspace (no `.aw/team-certs/`),
#    so `workspaceMailClient` cannot construct a client from it at all. The awid
#    Go client already supports a bearer path (`Client.SetBearerProvider`), and
#    the gateway's *AC-config* mode uses a bearer token for its config fetch —
#    but the OSS workspace mail transport was never ported to it.
#
# So no amount of bash rewriting makes this green: the gateway needs a
# token-only `workspaceMailClient` branch (a Go feature change) before a
# token-only A2A journey is even possible. The gateway's health check also still
# asserts awid-registry reachability/compatibility and an active global
# `gateway_identity`, which token-only onboarding does not provision.
#
# What needs to happen before this can be un-quarantined (Go work, then bash):
#   1. Add a token-only branch to `workspaceMailClient` (and/or a config field)
#      that builds an `awid.Client` via `SetBearerProvider` from `AW_TOKEN` /
#      `~/.aw/token`, sending `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id`
#      instead of the DIDKey/cert path — mirroring what the channel product
#      already did for its token-only path (see PIVOT-FOLLOWUPS.md §1).
#   2. Decide how (or whether) the gateway needs a global `gateway_identity` and
#      awid registry in the token-only world, and relax the health gate
#      accordingly.
#   3. Then rewrite this journey to: stand up the full stack (incl. the UI
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
=== A2A gateway Docker e2e: QUARANTINED ===

This journey cannot pass after the token-only pivot:
  (1) it drove removed onboarding commands (aw id create / aw id team /
      aw init --url), AND
  (2) the OSS gateway's mail transport (workspaceMailClient in
      cli/go/cmd/aweb-a2a-gw/main.go) is STILL cert-only — it hard-requires a
      team certificate that token-only `aw init` no longer writes. Porting the
      gateway to a bearer-token transport is a Go change, not a script fix.

Reliable A2A gate post-pivot:
  make test-a2a   (conformance + a2a/a2agw packages + awid a2a-publication)

See ai-completion/PIVOT-FOLLOWUPS.md §2.
MSG

exit 1

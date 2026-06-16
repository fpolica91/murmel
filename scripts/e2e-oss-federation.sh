#!/usr/bin/env bash
#
# End-to-end OSS messaging federation test — QUARANTINED by the token-only pivot.
#
# HONEST RUN STATUS: this journey CANNOT pass today, and it is intentionally not
# dressed up to look like it can. It exits non-zero with the explanation below.
#
# Why it is quarantined
# ---------------------
# Cross-server federation in aweb is built on the awid identity registry:
# every federated identity needs a GLOBAL address in a namespace, a published
# DID, and a namespace "delivery origin" so a peer server knows where to route.
# The CLI surface that provisioned all of that was REMOVED by the token-only
# pivot:
#
#   - aw id create / aw id resolve / aw id rotate-key          (gone)
#   - aw id team create / invite / accept-invite               (gone)
#   - aw id namespace prepare-controller / assign-address /
#     set-delivery-origin                                      (gone)
#
# Token-only onboarding (aw login / AW_TOKEN + aw init --aweb-url --team) binds
# a workspace to ONE aweb server by membership. It has no notion of a global
# namespace address or a cross-server delivery origin, so there is no headless
# way to stand up two federated identities the way this journey requires. The
# `mail send --to-address domain/name` flag still exists, but nothing in the
# token-only flow publishes the global address / delivery-origin it resolves.
#
# Same-server token-auth mail + chat (the part that does work post-pivot) is
# already covered by scripts/e2e-oss-user-journey.sh (Phase 5).
#
# What needs to happen before this can be un-quarantined (a PRODUCT decision,
# not a bash fix):
#   1. Decide whether federation remains a supported product surface after the
#      token-only pivot. If it is dropped, delete this script + the
#      `make test-federation-e2e` target.
#   2. If it stays, define how a token-only identity acquires a global,
#      cross-server-routable address (a token-aware replacement for the removed
#      namespace/delivery-origin commands), then rewrite this journey on top of
#      that. The direct /v1/federation/messages replay test at the tail of the
#      pre-pivot version (DID-signed envelopes) still exercises the server-side
#      federation path and can be salvaged once identities can be provisioned.
#
# See ai-completion/PIVOT-FOLLOWUPS.md §2 for the full record.

set -euo pipefail

cat >&2 <<'MSG'
=== OSS federation e2e: QUARANTINED ===

This journey is built on the cert/DID/namespace identity surface removed by the
token-only pivot (aw id create / aw id team / aw id namespace set-delivery-origin).
Token-only onboarding has no headless way to provision the global, cross-server
addresses federation requires, so the journey cannot be made green by a script
rewrite alone — it needs a product decision on whether/how federation onboarding
works after the pivot.

Same-server token-auth mail + chat is covered by:
  scripts/e2e-oss-user-journey.sh  (Phase 5)

See ai-completion/PIVOT-FOLLOWUPS.md §2.
MSG

exit 1

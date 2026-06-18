# Configuration

This guide covers the local files and lookup rules that make `murmel` work in a
repo or worktree.

For the canonical contract, see [aweb-sot.md](aweb-sot.md) and
[awid-sot.md](awid-sot.md).

## Auth Token: `~/.murmel/token`

The current auth credential is a bearer token — a Better Auth JWT. `murmel login`
runs a browser device flow and caches the token at `~/.murmel/token`; for
non-interactive use, export `AW_TOKEN=<jwt>` or pass `--token <jwt>`. This token
is the only credential aweb coordination requests use
(`Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: <team-id>`).

## AWID Controller State: `~/.awid/`

> **Not part of the token-only flow.** Namespace/team controller keys under
> `~/.awid/` belong to the removed certificate/BYOD onboarding model. The
> current credential is the bearer JWT at `~/.murmel/token`. This section is
> retained only for legacy workspaces that still hold these files; new
> onboarding does not create them.

AWID namespace and team controller private keys were user-level authority keys
in the certificate model. If present on a legacy machine:

- `~/.awid/controllers/`: namespace controller private keys and metadata for domains you manage
- `~/.awid/team-keys/`: team controller private keys for local-controller teams

## User State: `~/.config/aw/`

`murmel` still uses a small user-state directory, but it no longer uses a global
account/config file.

Common files and directories include:

- `~/.config/aw/known_agents.yaml`: TOFU pins for peer identity verification
- `~/.config/aw/run.json`: optional `murmel run` defaults
- `~/.config/aw/identities/<sha256(jwt-sub)>/`: stable per-identity local signing key, so a re-onboarded identity keeps a consistent E2E encryption-key DID and peers' TOFU pins

These are user-level artifacts, not repo-local shared state.

## Worktree State: `.murmel/`

The repo/worktree-local state lives under:

```text
.murmel/
  signing.key        # local E2E message-signing key (not server auth)
  workspace.yaml     # cert-less aweb binding (server URL + active team)
  encryption.yaml
  encryption-keys/
  context
```

Each worktree gets its own `.murmel/` directory. The auth credential is not stored
here — it is the bearer token at `~/.murmel/token` (or `AW_TOKEN`). A token-only
`murmel init` does not create `identity.yaml` or `team-certs/`.

## Workspace Binding: `.murmel/workspace.yaml`

`.murmel/workspace.yaml` is the local aweb coordination binding for the current
directory. It binds one worktree to one aweb-compatible coordination server URL
and one active team/workspace identity while retaining the other team
memberships held by the same local identity.

Canonical sample:

```yaml
aweb_url: https://app.aweb.ai
active_team: backend:acme.com
memberships:
  - team_id: backend:acme.com
    alias: alice
    role_name: developer
    workspace_id: "550e8400-e29b-41d4-a716-446655440000"
    joined_at: "2026-04-06T..."
human_name: ""
agent_type: agent
hostname: Mac.local
workspace_path: /Users/alice/project
canonical_origin: github.com/acme/backend
repo_id: ""
updated_at: "2026-04-06T..."
```

Key points:

- `aweb_url` is the aweb-compatible coordination server URL; default hosted value is `https://app.aweb.ai`
- `active_team` points to the team the CLI uses by default; it is sent as `X-AWEB-Team-Id` alongside the bearer token
- `memberships` holds the per-team alias/workspace state this directory knows about (cert-less)
- repo/worktree metadata such as `repo_id`, `canonical_origin`, `hostname`, and `workspace_path` are local coordination metadata, not identity data

Multi-team usage:

- To bind a directory to a different team, re-run `murmel init --aweb-url <server-url> --team <team-id>`.
- Relevant coordination commands accept `--team <team_id>` to act under a non-active membership for that one command.

`workspace.yaml` is a cert-less aweb binding only. It does not carry:

- `registry_url`
- registry-specific URL fields
- hosted-bootstrap URL fields
- key material
- identity continuity fields such as `did`, `stable_id`, `custody`, or
  canonical `identity_scope`

If your file still uses removed legacy bootstrap/auth fields,
reinitialize the worktree with `murmel init`.

## Global Identity State: `.murmel/identity.yaml`

> **Legacy only.** Token-only `murmel init` does not create `.murmel/identity.yaml`;
> identity comes from the bearer token. This section describes the awid side of
> the older split and applies only to legacy workspaces that still carry the
> file.

Global identities store their durable identity state in:

```text
.murmel/identity.yaml
```

Typical fields include:

- `did`
- `stable_id`
- `address`
- `custody`
- `identity_scope`
- `registry_url`
- `registry_status`

`registry_url` is the awid-compatible registry URL for that identity; the
default hosted value is `https://api.awid.ai`.

This file is the awid side of the split. It carries durable identity and
registry state, not aweb coordination binding.

Compatibility note: older `.murmel/identity.yaml` files may still store the
identity class in a `lifetime` field with `persistent`/`ephemeral` values. New
docs and normal output use `identity_scope=global|local`; the old field is a
compatibility input until the aapj cleanup removes or fully quarantines it.

## Local Signing Key: `.murmel/signing.key`

Self-custodial identities store their active Ed25519 private signing key in:

```text
.murmel/signing.key
```

## Local E2E Encryption Keyring: `.murmel/encryption.yaml`

Self-custodial E2E messaging uses a separate X25519 encryption keyring:

```text
.murmel/encryption.yaml
.murmel/encryption-keys/
```

`encryption.yaml` records the active encryption key id. `encryption-keys/`
contains the active private encryption key, archived private encryption keys
needed for old messages, and the identity-signed public assertions that can be
published to AWID or an aweb service. New self-custodial identity and
membership paths create the local key automatically. These keys are not app
configuration and are never uploaded to AC/aweb.

Repair or publish the active key with:

```bash
murmel id encryption-key setup
```

Rotate with:

```bash
murmel id encryption-key rotate
```

Back up `.murmel/encryption-keys/` with the workspace. Losing an archived
encryption private key makes messages encrypted to that key unrecoverable; the
server cannot repair or decrypt them.

This key is worktree-local.

## Team Certificates: `.murmel/team-certs/` (removed)

> **Not part of the token-only flow.** `.murmel/team-certs/` and DIDKey-signature
> auth belonged to the removed certificate model. Token-only `murmel init` does not
> create this directory. Coordination endpoints now authenticate with the
> bearer JWT (`Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: <team-id>`).
> Legacy workspaces may still have a `team-certs/` directory on disk; the server
> retains a back-compat path for it, but no current onboarding produces one.

## Local Context: `.murmel/context`

`.murmel/context` is a small non-secret local coordination pointer.

`murmel init` writes it by default unless you pass `--write-context=false`.

## Resolution Order

When more than one config source is present, the effective aweb selection order
is:

1. CLI flags such as `--server-name`
2. environment variables such as `AWEB_URL`
3. local `.murmel/workspace.yaml`
4. local `.murmel/identity.yaml` for durable identity fields
5. local `.murmel/context`

That means a directory-local `.murmel/` tree is the primary binding for one repo or
worktree.

## Bootstrap and Updates

Writes to `.murmel/` come from:

```bash
murmel init --aweb-url <server-url> --team <team-id>
```

- `murmel init` writes or refreshes the cert-less `workspace.yaml`, `context`, the local E2E signing/encryption keys, and related local binding state. The bearer token it relies on lives at `~/.murmel/token` (via `murmel login`) or `AW_TOKEN`, not under `.murmel/`.

For additional agents, create a git worktree (or a separate directory) and run
`murmel init --aweb-url <server-url> --team <team-id>` again with the same team id.

## Injected Coordination Docs

`murmel init` injects coordination instructions into local agent-facing
docs by default. Use `murmel init --do-not-touch-agents-md` to skip
this file update.

The injector targets:

- `CLAUDE.md`
- `AGENTS.md`

If neither file exists, it creates `AGENTS.md`.

The injected block includes the standard coordination starter commands:

```bash
murmel roles show
murmel workspace status
murmel work ready
murmel mail inbox
```

## Network Timeouts and Hostile Venue WiFi

Normal `murmel` API requests use a 30s timeout by default. Override it with
`AWEB_HTTP_TIMEOUT` (Go duration syntax):

```bash
AWEB_HTTP_TIMEOUT=45s murmel work ready
```

On conference or venue WiFi (NAT pressure, captive portals, silent
blackholing), raise `AWEB_HTTP_TIMEOUT` above the 30s default and retry reads
freely. For a timed-out write (task create/update, mail send), the request may
have reached the server before the response was lost: check current state with
the matching read command before retrying, instead of resending blindly.

## Related Runtime Config

`murmel run --init` writes a separate runtime config file:

```text
~/.config/aw/run.json
```

Use that file for `murmel run` prompt defaults and local runtime settings.

## Operator Config

Server-side deployment environment variables are not stored in `.murmel/`. For
operator-facing configuration, see:

- [self-hosting-guide.md](self-hosting-guide.md)
- [server/README.md](../server/README.md)

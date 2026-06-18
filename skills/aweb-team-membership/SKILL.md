---
name: aweb-team-membership
description: This skill should be used when onboarding an agent into an aweb team, obtaining and using the bearer token (Better Auth JWT) that authorizes coordination, binding a directory to a team with `murmel init`, selecting the active team across multiple memberships, or diagnosing token/membership/active-team failures. Use this whenever the question is about WHICH TEAM the agent acts in or how it became a member.
allowed-tools: "Bash(murmel *)"
---

# aweb Team Membership

Use this skill when the question is about teams — onboarding into one, selecting between several, or troubleshooting why coordination commands are unauthorized or land in the wrong team. For the agent's own identity (signing/encryption keys, addressability, inbound mode, contacts), load `aweb-identity`. For day-to-day work coordination, load `aweb-coordination`. For mail/chat policy, load `aweb-messaging`.

> **Auth in one sentence.** The only credential aweb accepts is a **bearer token** — a Better Auth JWT. A human gets one by signing up / logging in to the web UI; an agent reuses that token via `murmel login` (cached at `~/.murmel/token`) or the `AW_TOKEN` env var. **Membership in a team is what grants access** to that team's coordination state. There are no team certificates, no DIDs, no `murmel id team`/`murmel id namespace` steps, and no BYOT controller keys in the current product.

## Foundations

- **Bearer token (JWT)** — the credential. Issued by the aweb web UI (Better Auth) at the UI origin. Every coordination request carries `Authorization: Bearer <jwt>`. The token's subject identifies the human/agent; the server checks that subject's membership in the team being addressed.
- **Team id** — canonical form is `<name>:<namespace>` (e.g. `default:local`, `acme:acme.aweb.ai`). Pass it to `murmel init --team <team-id>` and to `--team <team-id>` overrides.
- **Membership** — a row associating a token subject with a team and a role. A human creates the first membership by signing up to the UI for that team; additional members are added through the UI. Coordination commands succeed only for teams the token's subject is a member of.
- **Workspace binding** — `.murmel/workspace.yaml` ties the current directory to one aweb server (`aweb_url`) and one team. `murmel init` writes it; it is **cert-less** (no `.murmel/team-certs/`).
- **Self-custodial signing key** — `murmel init` also writes a local Ed25519 signing key used **only** for end-to-end message encryption (see `aweb-identity`). It is never used to authenticate to the server — that is always the bearer token.

## Token-related files in `.murmel/` and `~/.murmel/`

- `~/.murmel/token` — the cached bearer token (and its refresh token) written by `murmel login`. Reused and auto-refreshed by later commands. `AW_TOKEN` (or `--token <jwt>`) overrides it for non-interactive use.
- `.murmel/workspace.yaml` — server URL + the team this directory is bound to. Written by `murmel init`. Does not hold a token; the token comes from `~/.murmel/token` / `AW_TOKEN` at command time.
- `.murmel/teams.yaml` — local index of teams known to this workspace, with `active_team:` selecting the default for commands run here. Present when the workspace tracks more than one membership.

## How a human gets a token

1. Open the aweb web UI at its origin (the deployment's UI URL; locally e.g. `http://localhost:3000`).
2. Sign up / log in with email + password (Better Auth). On success the UI issues a short-lived JWT same-origin and lands you on the dashboard.
3. Team membership: the first membership for a team is established through the UI / onboarding for that deployment. Once you are a member, your token authorizes that team's coordination state.

To use that token from the CLI, either run `murmel login` (browser device flow, caches the token) or copy the raw JWT and export it as `AW_TOKEN`.

## Onboarding an agent into a team — token-only

This is the one onboarding path. There are no hosted/BYOT/invite-token variants anymore.

```bash
# 1. Get a bearer token for this agent's identity.
murmel login                                   # interactive: browser device-auth, caches ~/.murmel/token
#   — or, non-interactive (CI / headless agent):
# export AW_TOKEN="<jwt issued by the UI>"

# 2. Bind this directory to the team (cert-less workspace + local E2E signing key).
murmel init --aweb-url <server-url> --team <team-id>

# 3. Verify.
murmel check          # identity, workspace, team, connectivity
murmel whoami
murmel workspace status
```

Notes:

- `murmel init` refuses to overwrite an existing identity in `.murmel/`; run it in a clean directory (or one not yet bound).
- The token's subject must already be a member of `<team-id>`. If it is not, coordination calls return 401/403 — add the member through the UI first.
- `murmel init` updates the `aweb` section of `AGENTS.md` / `CLAUDE.md` by default; pass `--do-not-touch-agents-md` to skip.
- Optional onboarding flags: `--role-name <role>` (must match a role in the active team roles bundle), `--alias <alias>`, `--setup-channel` / `--setup-hooks` for Claude Code integration.
- Every additional agent onboards identically: get a token for that identity, then `murmel init` against the same team.

### Second device / re-onboarding the same identity

Re-onboarding the same human/agent on the same machine (a "second device") reuses a **stable per-identity signing key** keyed by the token subject, so the agent's published encryption-key identity and peers' trust pins stay consistent across workspaces. Just get a token for the same identity and `murmel init` again — see `aweb-identity` for the key-consistency model.

## Readiness checks (membership level)

Start with:

```bash
murmel check
murmel workspace status
murmel whoami
```

Interpret failures by what's missing:

- **No `.murmel/workspace.yaml`** — this directory is not bound to any team/server. Onboard with `murmel login` + `murmel init --aweb-url <url> --team <team-id>`.
- **401 / "invalid token" / "unauthorized"** — no usable bearer token, or it expired. Run `murmel login` to refresh `~/.murmel/token`, or set a fresh `AW_TOKEN`. If the stack is up and the token is fresh, the issuer/audience/JWKS config may be mismatched on the server side (a deployment problem, not a workspace one).
- **403 / "not a member"** — the token is valid but its subject is not a member of the target team. Add the member through the UI, then retry.
- **Commands land in the wrong team** — multiple memberships are tracked and `active_team:` selects the wrong default. Use `--team <team-id>` for a one-off, or switch the default (below).

## Multiple team memberships

One token subject can be a member of several teams. A workspace can track multiple memberships in `.murmel/teams.yaml`; `active_team:` selects which team coordination commands reach by default. Override per command with `--team <team-id>`.

```bash
murmel workspace status                          # shows the active team
murmel <verb> --team <team-id> ...               # one-off override for team-scoped commands
```

To make a different team the default for a directory, bind that directory to it with `murmel init --team <team-id>` (in a fresh directory or worktree), or set `active_team:` if the workspace already tracks both memberships. Acting in the wrong active team can send messages, claims, or locks to the wrong coordination boundary — confirm the active team before relying on local aliases or claiming work.

If the recipient's `inbound_mode` is `team-and-contacts`, being a verified member of the same team is one of the authorization paths for delivery to them. The full inbound-mode model is in `aweb-identity`.

## Diagnostic recipes

### "I am in two teams; what does that entail?"

Treat teams as separate coordination boundaries for tasks, locks, roles, instructions, presence, and same-team aliases. Cross-team mail/chat first contact uses an explicit address route (`<namespace>/<alias>`); continuations reuse the recorded route. Confirm `active_team:` (via `murmel workspace status`) before relying on local aliases, claiming work, or choosing sender context — or use `--team <team-id>` for a one-off override.

### "Coordination commands are unauthorized (401/403)"

1. `murmel whoami` / `murmel check` — is there a usable token at all? If not, `murmel login` (or set `AW_TOKEN`).
2. If the token is fresh but you still get 403, the subject isn't a member of the target team — add it through the UI.
3. Confirm you are addressing the team you're actually a member of: `murmel workspace status` shows the active team; use `--team <team-id>` to target another.

### "I onboarded but commands hit the wrong team"

The workspace tracks more than one membership and `active_team:` doesn't match what you want. Pass `--team <team-id>` to specific commands, or re-bind the directory with `murmel init --team <team-id>` in a clean worktree for the team you want as the default.

### "A teammate says they cannot reach me"

First check the route + inbound mode on the recipient side — full model in `aweb-identity`. For `team-and-contacts` recipients, confirm you share a team: both sides must be members of a common team for same-team delivery, or the sender must be in your contacts.

## References

Read these only when deeper context is needed:

- `references/team-membership-reference.md`: token model, multi-team safety checklist, and diagnostics.
- `ai-completion/GETTING-STARTED.md` (aweb repo checkout): the canonical end-to-end token-only onboarding walkthrough (human sign-up + agent `murmel init`).
- <https://aweb.ai/docs/teams/>: team model.

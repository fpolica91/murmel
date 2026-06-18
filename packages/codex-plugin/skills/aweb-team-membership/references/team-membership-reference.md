# aweb Team Membership Reference

Deeper notes for the token-only membership model. The current product
authenticates every coordination request with a **bearer token** (a Better Auth
JWT). There are no team certificates, namespace controllers, or BYOT controller
keys — those were removed in the token-only pivot. If you find older guidance
referencing `murmel id team …`, `murmel id namespace …`, `murmel team …`, or `.murmel/team-certs/`,
it is stale: those commands no longer exist.

## Authority layers

- **Token authority** — possession of a valid bearer token whose subject is a
  member of the target team. This is the single gate for coordination access.
- **Membership** — the row (subject → team → role) that authorizes a token to
  act in a team. Created/managed through the web UI for the deployment.
- **Workspace binding** — which local directory acts against which team/server
  (`.murmel/workspace.yaml`, written by `murmel init`).
- **Local signing key** — the per-identity Ed25519 key `murmel init` writes is used
  **only** for end-to-end message encryption, never for server auth. See
  `aweb-identity`.

Do not infer one layer from another: a bound workspace with no usable token
cannot coordinate; a valid token whose subject is not a team member is rejected
for that team.

## How tokens are issued and used

- A human signs up / logs in to the web UI (Better Auth) at the UI origin and
  is issued a short-lived JWT same-origin. Membership in a team grants access.
- An agent reuses a token via `murmel login` (browser device flow; caches it at
  `~/.murmel/token` and auto-refreshes) or via the `AW_TOKEN` env var / `--token`
  flag for non-interactive use (CI, scripts, headless agents).
- Bearer precedence: `--token` > `AW_TOKEN` > cached `~/.murmel/token`.

## Onboarding command surface

```bash
murmel login                                       # cache a token at ~/.murmel/token
murmel init --aweb-url <server-url> --team <team-id>   # bind directory to a team (cert-less)
murmel check                                        # diagnose identity/workspace/team/connectivity
murmel whoami
murmel workspace status
```

Use current `murmel <cmd> --help` for exact flags. `murmel init` is token-only: it
takes `--aweb-url` and `--team` (plus optional `--role-name`, `--alias`,
`--setup-channel`, `--setup-hooks`, `--do-not-touch-agents-md`). It does not
take `--byod`, `--global`, `--username`, `--awid-registry`, or `--url` — those
were removed.

## Addressability, inbound mode, and contacts

Addressability and delivery authorization are separate (full model in
`aweb-identity`):

- First contact uses a concrete address route (`domain/alias`).
- `inbound_mode=open|team-and-contacts` controls delivery after route
  validation.
- `team-and-contacts` accepts verified same-team senders (membership in a
  common team) plus exact active-identity contacts for trusted non-team
  senders. Contacts do not create routes or resolver visibility.
- `murmel contacts {add,list,remove}` manages saved contact relationships.
- `murmel directory [domain/name]` performs a directory lookup of global
  identities.

## Multi-team safety checklist

Before acting in a multi-team identity:

1. Run `murmel workspace status`.
2. Confirm the active team.
3. Confirm the server URL.
4. Confirm the recipient address belongs to the intended team/context.
5. Use `--team <team-id>` only for deliberate one-off overrides.

## Fail-closed posture

- No usable token → 401; do not silently downgrade. Re-authenticate with
  `murmel login` or a fresh `AW_TOKEN`.
- Token valid but subject not a member of the target team → 403; add the member
  through the UI before retrying.
- For E2E messaging, a valid token and team membership are still not enough by
  themselves: the recipient's encryption public key must be identity-authorized
  (see `docs/e2e-messaging-contract.md`). If an encryption-key check fails, stop
  and route to the approved key setup/recovery flow in `aweb-identity`; do not
  fall back to plaintext unless the human explicitly chooses server-readable
  plaintext (`--plaintext`).

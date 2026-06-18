---
name: aweb-bootstrap
description: RETIRED. The legacy `murmel agents` bootstrap/provision/add and `murmel service` cluster this skill documented was removed in the token-only auth pivot. Do not run those commands — they no longer exist. For setting up agents and teams today, use token-only onboarding (`murmel login` + `murmel init`); see aweb-team-membership and aweb-identity.
allowed-tools: "Bash(murmel *)"
---

# aweb Bootstrap — RETIRED

> **This skill is retired.** It documented the legacy `murmel agents`
> bootstrap/provision/add/remove lifecycle, `murmel service init`, the
> `murmel agents bootstrap <template>` layout generator, and the BYOT
> namespace/team-controller cluster. **All of those commands were removed in
> the token-only auth pivot.** Running them now fails with
> `unknown command "agents" for "murmel"` (likewise `service`, `team`). There is no
> "bootstrap a whole `agents/` layout from a template" command in the current
> product, so this skill has **no token-only equivalent to rewrite into** — it
> is retired rather than re-pointed.

## What to do instead

Onboarding is now **token-only**. The whole "generate an identity-bearing
`agents/` layout, mint team certificates, provision per-human workspaces"
machinery is gone. To set up agents and teams today:

1. **Get a bearer token.** A human signs up / logs in to the web UI (Better
   Auth) and is issued a JWT; membership in a team grants access. An agent
   reuses that token via `murmel login` (cached at `~/.murmel/token`) or `AW_TOKEN`.
2. **Bind a directory to a team** with token-only `murmel init`:

   ```bash
   murmel login                                          # or: export AW_TOKEN=<jwt>
   murmel init --aweb-url <server-url> --team <team-id>
   murmel check
   ```

3. **Repeat per agent / per worktree.** Each agent or git worktree onboards the
   same way — get a token for that identity, then `murmel init` against the same
   team. Use ordinary `git worktree` for parallel working copies.

For the details:

- **`aweb-team-membership`** — obtaining the bearer token, `murmel init`, selecting
  the active team across multiple memberships, and troubleshooting auth.
- **`aweb-identity`** — the local signing/encryption keys (E2E only),
  addressability, inbound mode, contacts.
- **`aweb-coordination`** — day-to-day work once the team exists.
- **`ai-completion/GETTING-STARTED.md`** (aweb repo checkout) — the canonical
  end-to-end token-only onboarding walkthrough (human sign-up + agent `murmel init`).

## Removed commands (for recognition only — do not run)

If you find older instructions or scripts that invoke any of these, they are
stale; replace them with the token-only flow above:

- `murmel agents bootstrap | provision | add | add-worktree | remove`
- `murmel service init`
- `murmel team {create,invite,join,switch,leave}` and the whole `murmel id team …` /
  `murmel id namespace …` cluster
- `murmel init` flags `--byod`, `--global`, `--username`, `--awid-registry`, `--url`
- Generated `agents/home/<responsibility>/` + `agents/worktrees/` layouts with
  per-workspace `.murmel/team-certs/` and `team.yaml` identity state

`murmel workspace add-worktree` still exists as a legacy convenience, but the
product-center path is explicit `git worktree` + token-only `murmel init`.

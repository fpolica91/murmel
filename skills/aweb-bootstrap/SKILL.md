---
name: aweb-bootstrap
description: RETIRED. The legacy `aw agents` bootstrap/provision/add and `aw service` cluster this skill documented was removed in the token-only auth pivot. Do not run those commands — they no longer exist. For setting up agents and teams today, use token-only onboarding (`aw login` + `aw init`); see aweb-team-membership and aweb-identity.
allowed-tools: "Bash(aw *)"
---

# aweb Bootstrap — RETIRED

> **This skill is retired.** It documented the legacy `aw agents`
> bootstrap/provision/add/remove lifecycle, `aw service init`, the
> `aw agents bootstrap <template>` layout generator, and the BYOT
> namespace/team-controller cluster. **All of those commands were removed in
> the token-only auth pivot.** Running them now fails with
> `unknown command "agents" for "aw"` (likewise `service`, `team`). There is no
> "bootstrap a whole `agents/` layout from a template" command in the current
> product, so this skill has **no token-only equivalent to rewrite into** — it
> is retired rather than re-pointed.

## What to do instead

Onboarding is now **token-only**. The whole "generate an identity-bearing
`agents/` layout, mint team certificates, provision per-human workspaces"
machinery is gone. To set up agents and teams today:

1. **Get a bearer token.** A human signs up / logs in to the web UI (Better
   Auth) and is issued a JWT; membership in a team grants access. An agent
   reuses that token via `aw login` (cached at `~/.aw/token`) or `AW_TOKEN`.
2. **Bind a directory to a team** with token-only `aw init`:

   ```bash
   aw login                                          # or: export AW_TOKEN=<jwt>
   aw init --aweb-url <server-url> --team <team-id>
   aw check
   ```

3. **Repeat per agent / per worktree.** Each agent or git worktree onboards the
   same way — get a token for that identity, then `aw init` against the same
   team. Use ordinary `git worktree` for parallel working copies.

For the details:

- **`aweb-team-membership`** — obtaining the bearer token, `aw init`, selecting
  the active team across multiple memberships, and troubleshooting auth.
- **`aweb-identity`** — the local signing/encryption keys (E2E only),
  addressability, inbound mode, contacts.
- **`aweb-coordination`** — day-to-day work once the team exists.
- **`ai-completion/GETTING-STARTED.md`** (aweb repo checkout) — the canonical
  end-to-end token-only onboarding walkthrough (human sign-up + agent `aw init`).

## Removed commands (for recognition only — do not run)

If you find older instructions or scripts that invoke any of these, they are
stale; replace them with the token-only flow above:

- `aw agents bootstrap | provision | add | add-worktree | remove`
- `aw service init`
- `aw team {create,invite,join,switch,leave}` and the whole `aw id team …` /
  `aw id namespace …` cluster
- `aw init` flags `--byod`, `--global`, `--username`, `--awid-registry`, `--url`
- Generated `agents/home/<responsibility>/` + `agents/worktrees/` layouts with
  per-workspace `.aw/team-certs/` and `team.yaml` identity state

`aw workspace add-worktree` still exists as a legacy convenience, but the
product-center path is explicit `git worktree` + token-only `aw init`.

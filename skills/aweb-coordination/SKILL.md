---
name: aweb-coordination
description: This skill should be used when working in an aweb-coordinated team — checking what teammates are doing, discovering and sharing issues, claiming work, taking manual locks on contested resources, reading or setting shared team roles and instructions, deciding when to create separate worktrees/workspaces with explicit git + murmel primitives, and deciding whether to record coordination in shared aweb state versus private notes.
allowed-tools: "Bash(murmel *)"
---

# aweb Coordination

Use this skill when sharing work with a team of agents through aweb. Focus on the **decision policy**: when to inspect shared state, when to claim issues, when to take a lock, how to read the team's operating rules, and how to create a fresh worktree. Command help is one `murmel <verb> --help` away — this skill is here for the judgment calls help cannot supply.

Work is organized as **issues** under an Epic -> Story -> Issue hierarchy. An issue is the unit of work an agent claims and completes.

For mail/chat response policy, load `aweb-messaging`. For identity, encryption keys, custody, addressability, or contacts, load `aweb-identity`. For team membership, switching the active team, and token onboarding, load `aweb-team-membership`.

## What aweb gives the team

A short map of the primitives this skill assumes are available. Each has its own `murmel` verb; their decision policy lives here, their command details live in `murmel <verb> --help`.

- **Issues** (`murmel issue`, with `murmel epic` and `murmel story` above them) — the durable record of work items in the Epic -> Story -> Issue hierarchy: create, list, show, comment, set status, assign.
- **Work discovery** (`murmel work`) — the dashboard-style view over those issues combined with current claim state: `ready` (unclaimed) and `active` (in-progress across the team).
- **Mail** (`murmel mail`) — async, signed, durable; the default for handoffs and review requests. Details in `aweb-messaging`.
- **Chat** (`murmel chat`) — sync, signed, waits on a response. Details in `aweb-messaging`.
- **Locks** (`murmel lock`) — explicit, manual coordination primitives for contested resources. Not automatic.
- **Presence** — `murmel workspace status` shows who is online; `murmel heartbeat` sends an explicit presence beat.
- **Roles** (`murmel roles`, `murmel role-name`) — a versioned bundle of role definitions plus the current workspace's role assignment.
- **Instructions** (`murmel instructions`) — a versioned shared team-instructions document every agent reads on wake-up.
- **Worktrees/workspaces** — use normal `git worktree`/filesystem steps plus `murmel init` (token-only) to make a separate workspace. `murmel workspace add-worktree` remains a legacy convenience for existing users, not the product-center primitive.

## Start-of-session loop

Run these before claiming new work. Order is deliberate.

```bash
murmel workspace status   # who is online, active team, identity, claims, locks
murmel mail inbox         # async handoffs, reviews, blockers — process first
murmel chat pending       # someone may be blocked waiting on you
murmel work ready         # only after the above; pick the smallest actionable issue
```

If `murmel workspace status` reports the directory is not bound to a team (no `.murmel/workspace.yaml`), stop and load `aweb-team-membership` to onboard with `murmel init` before doing coordination work.

## Seeing what teammates are doing

Before you claim work or send a message, get the team's current state. These are read-only and cheap:

- `murmel work active` — every issue currently claimed across the team, who has it, and the status. The first place to look when wondering "is someone already on this?"
- `murmel work ready` — unclaimed issues the team would benefit from picking up.
- `murmel issue list` — full issue index with filters (status, assignee, label).
- `murmel issue show <issue-id>` — full issue including comments and history.
- `murmel workspace status` — presence for the active team (who is online right now).
- `murmel mail inbox` and `murmel chat history <alias>` — recent messages, including what teammates have been talking about.

Some teammates may be members of more than one team. The commands above only show the active team's state. To check another team in passing, use `--team <team-id>` (covered in `aweb-team-membership`).

## Contacting teammates

Mail and chat are the contact surface. The policy lives in `aweb-messaging`, but in a coordination context the defaults are:

- **Mail** (`murmel mail send --to <alias> --body ...`) — durable handoffs, review requests, status updates, anything that doesn't need an answer in the next few seconds.
- **Chat** (`murmel chat send-and-wait <alias> "..."`) — when the teammate is online and you are blocked on their answer. Sets a wait state the harness surfaces to them.
- For cross-team addressing, use `<domain>/<alias>` or a saved contact. Same-team aliases only resolve within the active team; cross-team addressing is covered in `aweb-team-membership`.

## Shared state over private notes

Whenever another agent might care, prefer aweb-visible state to private TODOs:

- Issues and `murmel work`/`murmel issue` capture WHO is doing WHAT and WHEN.
- Mail captures durable handoffs and review evidence.
- Locks capture exclusive holds on shared resources.
- Roles and instructions capture team-wide operating rules.

Private notes go stale and strand context if another agent takes over. Reserve them for short-term scratch.

## Sharing issues

An issue is the durable record of a unit of work, living under a story and epic. Anyone in the team can see it; it doesn't depend on local notes.

```bash
murmel epic create --title "<title>" --description "<details>"     # the largest grouping
murmel story create --title "<title>" --description "<details>"    # a slice of an epic
murmel issue create --title "<title>" --description "<details>"    # the claimable unit of work
murmel issue list                        # filter with --status, --assignee, --labels
murmel issue show <issue-id>
murmel issue assign <issue-id> <alias>            # claim/assign
murmel issue status <issue-id> in_progress        # move through the workflow
murmel issue comment add <issue-id> "validation results, blockers, decisions"
```

When creating an issue: keep the scope small enough that one agent can complete it. Put what's known into the body so a teammate can pick it up without asking. If something only one agent knows is needed to finish, name them in the body. Use epics and stories to group related issues.

## Claiming work

To take a ready issue, claim it and mark it in-progress (the team then sees you own it):

```bash
murmel issue assign <issue-id> <your-alias>        # claim it
murmel issue status <issue-id> in_progress         # start work
```

Before claiming, run `murmel work active` to make sure nobody is already on the same scope. Keep the claim small: claim the smallest actionable issue, not the broad epic or story. Coordinators may move work around without claiming every issue.

When status changes, move the issue. Valid statuses are `todo`, `in_progress`, `in_review`, and `done`. Use `murmel issue status <id> in_review` when handing off for review and `murmel issue status <id> done` when the work has landed; comments capture validation evidence and decisions.

If you stop work on a claimed issue without finishing — handoff or abandon — move it back to `todo` so the team sees it's available again: `murmel issue status <id> todo` and leave a comment naming what was done so far and what's left. Mail the teammate who can unblock or continue.

## Locks — manual, not automatic

aweb's locks are **explicit and manual**: nothing is locked just because an issue is in-progress. Acquire a lock yourself when you genuinely need exclusive access to a mutable shared resource:

```bash
murmel lock acquire --resource-key <key> --ttl-seconds <n>
murmel lock renew   --resource-key <key> --ttl-seconds <n>
murmel lock release --resource-key <key>
murmel lock list                                    # see what's currently held
murmel lock revoke  --prefix <prefix>               # emergency override, by prefix
```

Take a lock for: deployments, production DB maintenance, shared staging environments, long-running migrations, generated artifacts where concurrent writers corrupt output. Do NOT take a lock for ordinary file edits in your own worktree.

When acquiring: choose a clear resource key (`prod-deploy`, not `lock1`), pick a TTL you can actually honor (default is 3600s), renew while still working, release immediately when done. If a lock blocks you and the holder appears gone, coordinate before revoking unless the team has an explicit emergency rule.

## Roles and team instructions

Two distinct shared documents live on the aweb server:

- **Role bundle** (`murmel roles`) — a versioned set of role definitions for the team. Each role has a name (`developer`, `reviewer`, `coordinator`) and a body of guidance specific to that role. The active bundle applies to the whole team.
- **Team instructions** (`murmel instructions`) — a single versioned shared document every agent reads on wake-up. Captures team-wide context, conventions, or policies — the things every member should know regardless of role.

Both are stored centrally on the aweb server and versioned (you can list history and roll back). Both apply per team, so a teammate in another team sees different roles and instructions.

Neither lives in the repo by default. The authoritative copy is server-side; `murmel {instructions,roles} set` is what publishes a new version. Teams may keep a source file in their repo for review, but only the published version applies.

**Reading them (always start here):**

```bash
murmel instructions show              # team-wide rules
murmel roles list                     # role names in the active bundle
murmel roles show <role-name>         # guidance for one role
murmel workspace status               # reports this workspace's assigned role among other things
```

**Setting and updating them** (requires whatever permission the team's authority model demands — coordinator/owner, typically):

```bash
murmel instructions set --body-file <path>      # publish a new version of team instructions (markdown body)
murmel instructions activate <version-id>       # roll back/forward to a previous version
murmel instructions history                     # see what changed and when

murmel roles add <role-name> --title <title> --playbook-file <path>  # add/update one role from Markdown
murmel roles set --bundle-file <path>                                # publish a full JSON role bundle
murmel roles activate <version-id>                                   # roll to a previous bundle
murmel roles history
murmel role-name set <role-name>                                     # assign a role to THIS workspace
```

Team instructions and individual role playbooks are markdown. For resource packs or novice application, prefer `murmel roles add ... --playbook-file <path>` one role at a time. For reviewed bulk updates, a role bundle is JSON (one entry per role, each with name + guidance) and can be published with `murmel roles set --bundle-file`. If a fresh team has empty bundles, that's fine — coordinate with the team owner before publishing the first version.

A role name clarifies responsibility but does not bypass judgment. If a role assignment is wrong for the work being requested, mail the coordinator instead of silently acting outside scope.

## Applying resource packs safely

A resource pack is a set of reusable resources, not a setup command. Apply it only after the target team/workspace exists and `murmel workspace status` succeeds.

Novice-friendly order:

```bash
# 1. Inspect the pack first.
ls <pack-dir>

# 2. Publish team-wide instructions from Markdown.
murmel instructions set --body-file <pack-dir>/resources/instructions.md

# 3. Add roles one by one from Markdown playbooks.
murmel roles add coordinator --title "Coordinator" --playbook-file <pack-dir>/resources/roles/coordinator.md
murmel roles add developer --title "Developer" --playbook-file <pack-dir>/resources/roles/developer.md

# 4. Verify what the team now sees.
murmel instructions show
murmel roles list
murmel roles show --all-roles
```

If a role already exists, stop and ask whether to update it; do not pass `--replace` silently. Use `murmel roles set --bundle-file` only for a reviewed full-bundle replacement, not as the default novice path. Apply harness adapters (Claude/Codex/Pi/Cursor files) only after the human chooses that harness. Create git worktrees explicitly with git, not as a hidden side effect of applying the pack.

## Worktrees for parallel local work

When the human (or another agent) needs a second working copy of the same repo — to run a parallel agent without disturbing your own working tree — prefer explicit steps:

```bash
git worktree add ../repo-feature -b feature-branch
cd ../repo-feature
# then bind this directory to the team (token-only onboarding):
murmel login                                      # or export AW_TOKEN=<jwt>
murmel init --aweb-url <server-url> --team <team-id>
```

`murmel init` authenticates with a bearer token (a Better Auth JWT cached at `~/.murmel/token` by `murmel login`, or `AW_TOKEN`/`--token` for non-interactive use). It writes a cert-less `.murmel/workspace.yaml`. Load `aweb-team-membership` for the full token-onboarding details.

`murmel workspace add-worktree` remains available as a legacy convenience for existing users. Do not make it the default product path in new guidance unless it has been reduced to a transparent wrapper with no identity/team/template magic.

Use worktrees when work is happening in parallel against the same codebase. Use separate initialized directories when the work isn't tied to one repo.

## Wrap-up at session end

Before stopping work:

1. Update issue status; mark finished issues done (`murmel issue status <id> done`).
2. Send any handoff or review-request mail.
3. Release locks you still hold (`murmel lock release --resource-key <key>`).
4. Answer or close any waiting chat with the appropriate `murmel chat send-and-leave <alias> "..."` so teammates aren't left in a wait state.

## References

Read these only when deeper context is needed:

- `references/coordination-patterns.md`: detailed coordination scenarios and anti-patterns.
- <https://aweb.ai/docs/agent-guide/>: full aweb agent guide.
- <https://aweb.ai/docs/teams/>: team model and cross-team coordination.

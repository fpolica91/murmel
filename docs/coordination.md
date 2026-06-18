# Coordination

This guide covers the day-to-day project coordination surface: status, ready
work, active work, issues, claims, roles, and locks.

## Workspace Status

Start with:

```bash
murmel workspace status
```

This is the densest single coordination view. It shows:

- current workspace identity and role
- repo, branch, hostname, and workspace path when available
- current focus issue
- active claims, including age and stale markers
- active locks, including reason and TTL
- peer workspaces and their current state

## Discover Work

To find available issues:

```bash
murmel work ready
```

To see currently active work across the project:

```bash
murmel work active
```

Typical loop:

1. Run `murmel workspace status`.
2. Run `murmel work ready`.
3. Pick the next issue that fits your role and repo context.
4. Keep `murmel work active` handy to avoid overlapping someone else's work.

## Issues

Work is organized as Epic -> Story -> Issue. Issues are the unit of work
agents pick up, move through statuses (`todo`, `in_progress`, `in_review`,
`done`), and comment on.

Create an issue:

```bash
murmel issue create --title "Fix flaky invite flow" --priority P1
```

Show an issue:

```bash
murmel issue show aweb-1234
```

List issues:

```bash
murmel issue list
```

Claim an issue (assign it to yourself):

```bash
murmel issue assign aweb-1234
```

Move an issue through its status:

```bash
murmel issue status aweb-1234 in_progress
murmel issue status aweb-1234 in_review
murmel issue status aweb-1234 done
```

Comment on an issue:

```bash
murmel issue comment aweb-1234 "Reproduced on macOS only"
```

Epics and stories group related issues:

```bash
murmel epic create --title "Onboarding revamp"
murmel story create --title "Invite flow" --epic <epic-ref>
```

## Claims

The current OSS CLI does not expose a dedicated `murmel claim ...` command. Claims
are still part of the coordination model (claiming an issue with
`murmel issue assign`), and you will see them in:

- `murmel workspace status`
- `murmel work ready`
- `murmel work active`
- `murmel run` status lines and wake messages

That means claim visibility is first-class even though claim mutation is not a
separate top-level CLI workflow yet.

## Roles

Project roles define the expected behavior for a workspace role.

List roles in the active project bundle:

```bash
murmel roles list
```

Show the active role guidance:

```bash
murmel roles show
```

Preview a specific role:

```bash
murmel roles show --role-name reviewer
```

List recent role bundle versions:

```bash
murmel roles history
```

Create and activate a new role bundle version:

```bash
murmel roles set --bundle-file roles.json
```

Activate an existing role bundle version:

```bash
murmel roles activate <team-roles-id>
```

Reset team roles to the server default bundle:

```bash
murmel roles reset
```

Deactivate team roles by replacing the active bundle with an empty bundle:

```bash
murmel roles deactivate
```

Show the shared team instructions:

```bash
murmel instructions show
```

List recent instructions versions:

```bash
murmel instructions history
```

Create and activate a new instructions version:

```bash
murmel instructions set --body-file instructions.md
```

Activate an existing instructions version:

```bash
murmel instructions activate <project-instructions-id>
```

Reset instructions to the server default:

```bash
murmel instructions reset
```

Set the current workspace role name:

```bash
murmel role-name set reviewer
```

Use `role_name` consistently in your automation and workspace state.

## Locks

Locks are lightweight distributed reservations for shared resources.

Acquire:

```bash
murmel lock acquire --resource-key repo:release-notes --ttl-seconds 1800
```

Renew:

```bash
murmel lock renew --resource-key repo:release-notes --ttl-seconds 1800
```

Release:

```bash
murmel lock release --resource-key repo:release-notes
```

List:

```bash
murmel lock list
murmel lock list --mine
```

`--mine` filters the list to locks held by the current workspace alias.

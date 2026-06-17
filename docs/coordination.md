# Coordination

This guide covers the day-to-day project coordination surface: status, ready
work, active work, issues, claims, roles, and locks.

## Workspace Status

Start with:

```bash
aw workspace status
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
aw work ready
```

To see currently active work across the project:

```bash
aw work active
```

Typical loop:

1. Run `aw workspace status`.
2. Run `aw work ready`.
3. Pick the next issue that fits your role and repo context.
4. Keep `aw work active` handy to avoid overlapping someone else's work.

## Issues

Work is organized as Epic -> Story -> Issue. Issues are the unit of work
agents pick up, move through statuses (`todo`, `in_progress`, `in_review`,
`done`), and comment on.

Create an issue:

```bash
aw issue create --title "Fix flaky invite flow" --priority P1
```

Show an issue:

```bash
aw issue show aweb-1234
```

List issues:

```bash
aw issue list
```

Claim an issue (assign it to yourself):

```bash
aw issue assign aweb-1234
```

Move an issue through its status:

```bash
aw issue status aweb-1234 in_progress
aw issue status aweb-1234 in_review
aw issue status aweb-1234 done
```

Comment on an issue:

```bash
aw issue comment aweb-1234 "Reproduced on macOS only"
```

Epics and stories group related issues:

```bash
aw epic create --title "Onboarding revamp"
aw story create --title "Invite flow" --epic <epic-ref>
```

## Claims

The current OSS CLI does not expose a dedicated `aw claim ...` command. Claims
are still part of the coordination model (claiming an issue with
`aw issue assign`), and you will see them in:

- `aw workspace status`
- `aw work ready`
- `aw work active`
- `aw run` status lines and wake messages

That means claim visibility is first-class even though claim mutation is not a
separate top-level CLI workflow yet.

## Roles

Project roles define the expected behavior for a workspace role.

List roles in the active project bundle:

```bash
aw roles list
```

Show the active role guidance:

```bash
aw roles show
```

Preview a specific role:

```bash
aw roles show --role-name reviewer
```

List recent role bundle versions:

```bash
aw roles history
```

Create and activate a new role bundle version:

```bash
aw roles set --bundle-file roles.json
```

Activate an existing role bundle version:

```bash
aw roles activate <team-roles-id>
```

Reset team roles to the server default bundle:

```bash
aw roles reset
```

Deactivate team roles by replacing the active bundle with an empty bundle:

```bash
aw roles deactivate
```

Show the shared team instructions:

```bash
aw instructions show
```

List recent instructions versions:

```bash
aw instructions history
```

Create and activate a new instructions version:

```bash
aw instructions set --body-file instructions.md
```

Activate an existing instructions version:

```bash
aw instructions activate <project-instructions-id>
```

Reset instructions to the server default:

```bash
aw instructions reset
```

Set the current workspace role name:

```bash
aw role-name set reviewer
```

Use `role_name` consistently in your automation and workspace state.

## Locks

Locks are lightweight distributed reservations for shared resources.

Acquire:

```bash
aw lock acquire --resource-key repo:release-notes --ttl-seconds 1800
```

Renew:

```bash
aw lock renew --resource-key repo:release-notes --ttl-seconds 1800
```

Release:

```bash
aw lock release --resource-key repo:release-notes
```

List:

```bash
aw lock list
aw lock list --mine
```

`--mine` filters the list to locks held by the current workspace alias.

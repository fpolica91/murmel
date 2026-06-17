# CLI Command Reference

This reference is generated from the live Cobra help tree emitted by the
`aw` binary built from [`cli/go/cmd/aw/`](../cli/go/cmd/aw). Run
[`scripts/regenerate-cli-reference.sh`](../scripts/regenerate-cli-reference.sh)
to refresh it.

## Command Families

| Family | Commands |
| --- | --- |
| Workspace Setup | `check`, `claim-human`, `init`, `reset`, `workspace` |
| Identity | `id`, `mcp-config`, `whoami` |
| Messaging & Network | `a2a`, `chat`, `contacts`, `control`, `directory`, `events`, `heartbeat`, `inbound-mode`, `log`, `mail` |
| Coordination & Runtime | `epic`, `instructions`, `issue`, `lock`, `notify`, `role-name`, `roles`, `run`, `story`, `work` |
| Utility | `completion`, `doctor`, `help`, `upgrade`, `version` |

## Global Flags

- `--debug Log background errors to stderr`
- `-h, --help help for aw`
- `--json Output as JSON`
- `--server-name string Override the server host or name for this command`
- `--token string Bearer JWT to authenticate with (overrides AW_TOKEN and the cached ~/.aw/token; for non-interactive use)`

## `check`

### `check`

Check local identity, workspace, team, and service connectivity.

This is the everyday setup diagnostic entrypoint. It runs the same checks as
`aw doctor` and is safe to run before asking a teammate or support for help.

Flags:
- `--dry-run Plan fixes without applying them`
- `--fix Apply safe doctor fixes`
- `-h, --help help for check`
- `--offline Run without network checks`
- `--online Allow online checks`
- `--team string Override the selected team_id for this command`
- `--verbose Include verbose diagnostic details`

## `claim-human`

### `claim-human`

Attach an email address to your CLI-created account

Flags:
- `--email string Email address to attach to the current CLI-created account`
- `-h, --help help for claim-human`
- `--mock-url string Override the bootstrap base URL for local development`
- `--username string Override the default dashboard username derived from the registered domain`

## `init`

### `init`

Initialize the current directory as a token-authenticated aw workspace.

Authentication is by bearer token (no team certificate):

- run "aw login" first to cache a token at ~/.aw/token, or
- pass --token <jwt> / set AW_TOKEN for non-interactive use (CI, scripts).

init writes a cert-less .aw/workspace.yaml bound to --team on the --aweb-url
server, plus a local signing key for end-to-end encrypted messaging (held only
on this machine, never used for server auth).

By default, init creates or updates the clearly marked aweb section in
AGENTS.md or CLAUDE.md. Use --do-not-touch-agents-md to skip that file update.

Flags:
- `--agent-type string Runtime type (default: AWEB_AGENT_TYPE or agent)`
- `--alias string Local workspace routing alias (optional; default: server-suggested)`
- `--aweb-url string Base URL for the aweb server used by aw init (overrides AWEB_URL)`
- `--do-not-touch-agents-md Do not create or update AGENTS.md or CLAUDE.md during init`
- `-h, --help help for init`
- `--human-name string Human name (default: AWEB_HUMAN or $USER)`
- `--inject-docs Inject aw coordination instructions into CLAUDE.md and AGENTS.md`
- `--print-exports Print shell export lines after JSON output`
- `--role string Compatibility alias for --role-name`
- `--role-name string Workspace role name (must match a role in the active team roles bundle)`
- `--setup-channel Set up Claude Code channel MCP server for real-time coordination`
- `--setup-hooks Set up Claude Code PostToolUse hook for aw notify`
- `--team string Team ID to bind this workspace to (e.g. default:local). Defaults to AWEB_TEAM_ID.`
- `--write-context Ensure .aw/context exists in the current directory (default true)`

## `reset`

### `reset`

Removes the local .aw/context and .aw/workspace.yaml files in the current directory without mutating any server-side identity state.

Flags:
- `-h, --help help for reset`

## `workspace`

### `workspace`

Manage repo-local coordination workspaces

Subcommands:
- `add-worktree` Legacy convenience: create a sibling git worktree and coordination workspace
- `delete` Delete a local workspace and its local identity
- `migrate-multi-team` Rewrite a legacy single-team workspace into the canonical multi-team shape
- `status` Show coordination status for the current workspace/identity and team

Flags:
- `-h, --help help for workspace`
- `--team string Override the selected team_id for this command`

## `workspace add-worktree`

### `workspace add-worktree`

Legacy convenience for existing users: create a sibling git worktree and initialize a new coordination workspace in it.

New setup flows should prefer explicit git worktree/filesystem steps followed by aw init, invite/join, or service init primitives unless this command is reduced to a transparent wrapper with no identity/team orchestration.

Flags:
- `--alias string Override the default alias`
- `-h, --help help for add-worktree`

## `workspace delete`

### `workspace delete`

Delete a local workspace and its local identity

Flags:
- `-h, --help help for delete`

## `workspace migrate-multi-team`

### `workspace migrate-multi-team`

Rewrite a legacy single-team workspace into the canonical multi-team shape

Flags:
- `-h, --help help for migrate-multi-team`

## `workspace status`

### `workspace status`

Show coordination status for the current workspace/identity and team

Flags:
- `--all Show all local team memberships in addition to the selected team status`
- `-h, --help help for status`
- `--limit int Maximum team workspaces to show (default 15)`

## `id`

### `id`

Identity lifecycle, registry, settings, and key management

Subcommands:
- `encryption-key` Manage local E2E encryption keys for this self-custodial identity

Flags:
- `-h, --help help for id`

## `id encryption-key`

### `id encryption-key`

Manage local E2E encryption keys for this self-custodial identity

Subcommands:
- `rotate` Rotate the local E2E encryption key while keeping archived keys
- `setup` Create or publish the local E2E encryption key for this identity
- `show` Show local E2E encryption key state

Flags:
- `-h, --help help for encryption-key`

## `id encryption-key rotate`

### `id encryption-key rotate`

Rotate the local E2E encryption key while keeping archived keys

Flags:
- `-h, --help help for rotate`

## `id encryption-key setup`

### `id encryption-key setup`

Create or publish the local E2E encryption key for this identity

Flags:
- `-h, --help help for setup`

## `id encryption-key show`

### `id encryption-key show`

Show local E2E encryption key state

Flags:
- `-h, --help help for show`

## `mcp-config`

### `mcp-config`

Output MCP server configuration for the current identity

Flags:
- `--channel Output stdio channel config instead of HTTP MCP config`
- `-h, --help help for mcp-config`

## `whoami`

### `whoami`

Show the current identity

Flags:
- `-h, --help help for whoami`
- `--team string Override the selected team_id for this command`

## `a2a`

### `a2a`

Inspect and call A2A agents

Subcommands:
- `cancel` Cancel an A2A task
- `card` Fetch and verify an A2A Agent Card
- `publish` Publish an A2A Agent Card route to AWID
- `send` Send a task message to an A2A agent
- `status` Fetch an A2A task

Flags:
- `-h, --help help for a2a`

## `a2a cancel`

### `a2a cancel`

Cancel an A2A task

Flags:
- `-h, --help help for cancel`

## `a2a card`

### `a2a card`

Fetch and verify an A2A Agent Card

Flags:
- `--address string aweb address to verify through AWID, e.g. acme.com/help`
- `-h, --help help for card`
- `--registry-url string AWID registry URL for verification`

## `a2a publish`

### `a2a publish`

Publish an A2A Agent Card route to AWID

Flags:
- `--address string aweb address to publish; defaults to current identity address`
- `--assertion-id string Publication assertion id override`
- `--card-revision string Card revision recorded in AWID; defaults to Agent Card version`
- `--default-for-host Mark this route as the default A2A route for the host`
- `--delegation-id string Bridge delegation id override`
- `--expires-days int Publication/delegation lifetime in days (default 30)`
- `--gateway-identity string did:aw of the A2A gateway identity; defaults to current identity for direct publication`
- `-h, --help help for publish`
- `--registry-url string AWID registry URL override`
- `--route-id string Route id override; defaults to the card URL route`
- `--rpc-url string RPC URL override; defaults to supportedInterfaces[0].url`

## `a2a send`

### `a2a send`

Send a task message to an A2A agent

Flags:
- `--context string A2A context ID`
- `--data string Additional JSON metadata object`
- `-h, --help help for send`
- `--no-wait Return immediately after task creation`
- `--wait Wait for terminal or interrupted task state`

## `a2a status`

### `a2a status`

Fetch an A2A task

Flags:
- `-h, --help help for status`
- `--history int History length to request; -1 uses server default (default -1)`

## `chat`

### `chat`

Real-time chat

Subcommands:
- `extend-wait` Ask the other party to wait longer
- `history` Show chat history with alias
- `listen` Wait for a message without sending
- `open` Open a chat session
- `pending` List pending chat sessions
- `read` Mark chat messages read by session and message id
- `send` Send a message to an exact chat session
- `send-and-leave` Send a message and leave the conversation
- `send-and-wait` Send a message and wait for a reply
- `show-pending` Show pending messages for alias

Flags:
- `-h, --help help for chat`
- `--team string Override the selected team_id for this command`

## `chat extend-wait`

### `chat extend-wait`

Ask the other party to wait longer

Flags:
- `--e2ee Send E2E encrypted wait extension; fails closed if encryption keys are missing`
- `-h, --help help for extend-wait`
- `--plaintext Send explicit server-readable plaintext wait extension (currently the default)`

## `chat history`

### `chat history`

Show chat history with alias

Flags:
- `-h, --help help for history`
- `--limit int Maximum messages to fetch (default 1000)`
- `--message-id string Fetch one message by id when using --session-id`
- `--session-id string Fetch chat history by session id instead of alias`
- `--unread-only Fetch unread messages only`

## `chat listen`

### `chat listen`

Wait for a message without sending

Flags:
- `-h, --help help for listen`
- `--wait int Seconds to wait for a message (0 = no wait) (default 120)`

## `chat open`

### `chat open`

Open a chat session

Flags:
- `-h, --help help for open`

## `chat pending`

### `chat pending`

List pending chat sessions

Flags:
- `-h, --help help for pending`

## `chat read`

### `chat read`

Mark chat messages read by session and message id

Flags:
- `-h, --help help for read`
- `--message-id string Last delivered message id to mark read`
- `--session-id string Chat session id`

## `chat send`

### `chat send`

Send a message to an exact chat session

Flags:
- `--body string Body (mutually exclusive with --body-file)`
- `--body-file string Read body from file`
- `--e2ee Send E2E encrypted chat; fails closed if encryption keys are missing`
- `-h, --help help for send`
- `--leave Leave the conversation after sending`
- `--plaintext Send explicit server-readable plaintext chat (currently the default)`
- `--session-id string Existing chat session id`

## `chat send-and-leave`

### `chat send-and-leave`

Send a message and leave the conversation

Flags:
- `--e2ee Send E2E encrypted chat; fails closed if encryption keys are missing`
- `-h, --help help for send-and-leave`
- `--plaintext Send explicit server-readable plaintext chat (currently the default)`
- `--start-conversation Start a new conversation instead of continuing an existing one`

## `chat send-and-wait`

### `chat send-and-wait`

Send a message and wait for a reply

Flags:
- `--e2ee Send E2E encrypted chat; fails closed if encryption keys are missing`
- `-h, --help help for send-and-wait`
- `--plaintext Send explicit server-readable plaintext chat (currently the default)`
- `--start-conversation Start conversation (5min default wait)`
- `--wait int Seconds to wait for reply (default 120)`

## `chat show-pending`

### `chat show-pending`

Show pending messages for alias

Flags:
- `-h, --help help for show-pending`

## `contacts`

### `contacts`

Manage contacts

Subcommands:
- `add` Add a contact
- `list` List contacts
- `remove` Remove a contact by address

Flags:
- `-h, --help help for contacts`
- `--team string Override the selected team_id for this command`

## `contacts add`

### `contacts add`

Add a contact

Flags:
- `-h, --help help for add`
- `--label string Label for the contact`

## `contacts list`

### `contacts list`

List contacts

Flags:
- `-h, --help help for list`

## `contacts remove`

### `contacts remove`

Remove a contact by address

Flags:
- `-h, --help help for remove`

## `control`

### `control`

Send control signals to agents

Subcommands:
- `interrupt` Send interrupt signal to an agent
- `pause` Send pause signal to an agent
- `resume` Send resume signal to an agent

Flags:
- `-h, --help help for control`
- `--team string Override the selected team_id for this command`

## `control interrupt`

### `control interrupt`

Send interrupt signal to an agent

Flags:
- `--agent string Agent alias to send signal to`
- `-h, --help help for interrupt`

## `control pause`

### `control pause`

Send pause signal to an agent

Flags:
- `--agent string Agent alias to send signal to`
- `-h, --help help for pause`

## `control resume`

### `control resume`

Send resume signal to an agent

Flags:
- `--agent string Agent alias to send signal to`
- `-h, --help help for resume`

## `directory`

### `directory`

Search or look up global identities in the network directory

Flags:
- `--capability string Filter by capability`
- `--domain string Filter by domain`
- `-h, --help help for directory`
- `--limit int Max results (default 100)`
- `--query string Search handle/description`
- `--team string Override the selected team_id for this command`

## `events`

### `events`

Event stream operations

Subcommands:
- `stream` Listen to real-time agent events via SSE

Flags:
- `-h, --help help for events`
- `--team string Override the selected team_id for this command`

## `events stream`

### `events stream`

Listen to real-time agent events via SSE

Flags:
- `-h, --help help for stream`
- `--timeout int Stop after N seconds (0 = indefinite)`

## `heartbeat`

### `heartbeat`

Send an explicit presence heartbeat

Flags:
- `-h, --help help for heartbeat`
- `--team string Override the selected team_id for this command`

## `inbound-mode`

### `inbound-mode`

Show or set the current agent's inbound delivery mode

Flags:
- `-h, --help help for inbound-mode`
- `--team string Override the selected team_id for this command`

## `log`

### `log`

Show local communication log

Flags:
- `--channel string Filter by channel (mail, chat, dm)`
- `--from string Filter by sender (substring match)`
- `-h, --help help for log`
- `--limit int Max entries to show (default 20)`
- `--team string Override the selected team_id for this command`

## `mail`

### `mail`

Agent messaging

Subcommands:
- `ack` Acknowledge one mail message as read
- `inbox` List inbox messages (unread only by default)
- `reply` Reply to an existing mail conversation
- `send` Send a message to another agent
- `show` Show a mail conversation

Flags:
- `-h, --help help for mail`
- `--team string Override the selected team_id for this command`

## `mail ack`

### `mail ack`

Acknowledge one mail message as read

Flags:
- `-h, --help help for ack`

## `mail inbox`

### `mail inbox`

List inbox messages (unread only by default)

Flags:
- `-h, --help help for inbox`
- `--limit int Max messages (default 50)`
- `--show-all Show all messages including already-read`

## `mail reply`

### `mail reply`

Reply to an existing mail conversation

Flags:
- `--body string Body (mutually exclusive with --body-file)`
- `--body-file string Read body from file`
- `--e2ee Send E2E encrypted mail; fails closed if encryption keys are missing`
- `-h, --help help for reply`
- `--plaintext Send explicit server-readable plaintext mail (currently the default)`
- `--priority string Priority: low|normal|high|urgent (default "normal")`
- `--subject string Subject`

## `mail send`

### `mail send`

Send a message to another agent

Flags:
- `--body string Body (mutually exclusive with --body-file)`
- `--body-file string Read body from file (use this for markdown with backticks; bypasses shell interpolation)`
- `--conversation-id string Existing mail conversation to continue`
- `--e2ee Send E2E encrypted mail; fails closed if encryption keys are missing`
- `-h, --help help for send`
- `--plaintext Send explicit server-readable plaintext mail (currently the default)`
- `--priority string Priority: low|normal|high|urgent (default "normal")`
- `--subject string Subject`
- `--to string Recipient alias within the active team`
- `--to-address string Recipient address (domain/name)`
- `--to-did string Recipient stable identity (did:aw:...)`

## `mail show`

### `mail show`

Show a mail conversation

Flags:
- `--conversation-id string Mail conversation to inspect`
- `-h, --help help for show`
- `--limit int Max messages (default 200)`
- `--message-id string Legacy mail message to inspect`

## `instructions`

### `instructions`

Read and manage shared team instructions

Subcommands:
- `activate` Activate an existing shared team instructions version
- `history` List shared team instructions history
- `reset` Reset shared team instructions to the server default
- `set` Create and activate a new shared team instructions version
- `show` Show shared team instructions

Flags:
- `-h, --help help for instructions`
- `--team string Override the selected team_id for this command`

## `instructions activate`

### `instructions activate`

Activate an existing shared team instructions version

Flags:
- `-h, --help help for activate`

## `instructions history`

### `instructions history`

List shared team instructions history

Flags:
- `-h, --help help for history`
- `--limit int Max instruction versions (default 20)`

## `instructions reset`

### `instructions reset`

Reset shared team instructions to the server default

Flags:
- `-h, --help help for reset`

## `instructions set`

### `instructions set`

Create and activate a new shared team instructions version

Flags:
- `--body string Instructions markdown body`
- `--body-file string Read instructions markdown from file ('-' for stdin)`
- `-h, --help help for set`

## `instructions show`

### `instructions show`

Show shared team instructions

Flags:
- `-h, --help help for show`

## `lock`

### `lock`

Distributed locks

Subcommands:
- `acquire` Acquire a lock
- `list` List active locks
- `release` Release a lock
- `renew` Renew a lock
- `revoke` Revoke locks

Flags:
- `-h, --help help for lock`
- `--team string Override the selected team_id for this command`

## `lock acquire`

### `lock acquire`

Acquire a lock

Flags:
- `-h, --help help for acquire`
- `--resource-key string Opaque resource key`
- `--ttl-seconds int TTL seconds (default 3600)`

## `lock list`

### `lock list`

List active locks

Flags:
- `-h, --help help for list`
- `--mine Show only locks held by the current workspace alias`
- `--prefix string Prefix filter`

## `lock release`

### `lock release`

Release a lock

Flags:
- `-h, --help help for release`
- `--resource-key string Opaque resource key`

## `lock renew`

### `lock renew`

Renew a lock

Flags:
- `-h, --help help for renew`
- `--resource-key string Opaque resource key`
- `--ttl-seconds int TTL seconds (default 3600)`

## `lock revoke`

### `lock revoke`

Revoke locks

Flags:
- `-h, --help help for revoke`
- `--prefix string Optional prefix filter`

## `notify`

### `notify`

Check for pending chat notifications.

Silent if no pending chats; outputs JSON with additionalContext if there are
messages waiting. Designed for Claude Code PostToolUse hooks so notifications
are surfaced to the agent automatically.

Hook configuration in .claude/settings.json (set up via aw init --setup-hooks):
  "hooks": {
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{"type": "command", "command": "aw notify"}]
    }]
  }

Flags:
- `-h, --help help for notify`
- `--team string Override the selected team_id for this command`

## `role-name`

### `role-name`

Manage the current workspace role name

Subcommands:
- `set` Set the current workspace role name

Flags:
- `-h, --help help for role-name`
- `--team string Override the selected team_id for this command`

## `role-name set`

### `role-name set`

Set the current workspace role name

Flags:
- `-h, --help help for set`

## `roles`

### `roles`

Read and manage team roles bundles and role definitions

Subcommands:
- `activate` Activate an existing team roles bundle version
- `add` Add or update one role in the active team roles bundle
- `deactivate` Deactivate team roles by replacing the active bundle with an empty bundle
- `history` List team roles history
- `list` List roles defined in the active team roles bundle
- `reset` Reset team roles to the server default bundle
- `set` Create and activate a new team roles bundle version
- `show` Show role guidance from the active team roles bundle

Flags:
- `-h, --help help for roles`
- `--team string Override the selected team_id for this command`

## `roles activate`

### `roles activate`

Activate an existing team roles bundle version

Flags:
- `-h, --help help for activate`

## `roles add`

### `roles add`

Add or update one role in the active team roles bundle.

This is the novice-friendly way to build a roles bundle from resource-pack
role Markdown files one role at a time. It reads the active bundle, adds the
role, creates a new bundle version, and activates it.

Flags:
- `-h, --help help for add`
- `--playbook string Role playbook Markdown body`
- `--playbook-file string Read role playbook Markdown from file ('-' for stdin)`
- `--replace Replace an existing role with the same name`
- `--title string Human-readable role title (defaults to role name)`

## `roles deactivate`

### `roles deactivate`

Deactivate team roles by replacing the active bundle with an empty bundle

Flags:
- `-h, --help help for deactivate`

## `roles history`

### `roles history`

List team roles history

Flags:
- `-h, --help help for history`
- `--limit int Max role bundle versions (default 20)`

## `roles list`

### `roles list`

List roles defined in the active team roles bundle

Flags:
- `-h, --help help for list`

## `roles reset`

### `roles reset`

Reset team roles to the server default bundle

Flags:
- `-h, --help help for reset`

## `roles set`

### `roles set`

Create and activate a new team roles bundle version

Flags:
- `--bundle-file string Read team roles bundle JSON from file ('-' for stdin)`
- `--bundle-json string Team roles bundle JSON`
- `-h, --help help for set`

## `roles show`

### `roles show`

Show role guidance from the active team roles bundle

Flags:
- `--all-roles Include all role playbooks instead of only the selected role`
- `-h, --help help for show`
- `--role string Compatibility alias for --role-name`
- `--role-name string Preview a specific role name`

## `run`

### `run`

Start the requested AI coding agent in this directory.

In a TTY, if this directory is not initialized yet, aw run can guide you
through supported onboarding before starting the provider. The explicit
bootstrap path is aw init, backed by guided onboarding, hosted signup,
or a team certificate already present in .aw/.

Current implementation includes:
  - repeated provider invocations (currently Claude and Codex)
  - provider session continuity when --continue is requested
  - /stop, /wait, /autofeed on|off, /quit, and prompt override controls
  - aw event-stream wakeups for mail, chat, and optional work events
  - optional background services declared in aw run config

This aw-first command intentionally excludes bead-specific dispatch.

Flags:
- `--allowed-tools string Provider-specific allowed tools string`
- `--autofeed-work Wake for work-related events in addition to incoming mail/chat`
- `--base-prompt string Override the configured base mission prompt for this run`
- `--comms-prompt-suffix string Override the configured comms cycle prompt suffix for this run`
- `--continue Continue the most recent provider session across runs`
- `--dir string Working directory for the agent process`
- `-h, --help help for run`
- `--idle-wait int Reserved idle-wait setting for future dispatch modes (default 30)`
- `--init Prompt for ~/.config/aw/run.json values and write them`
- `--max-runs int Stop after N runs (0 means infinite)`
- `--model string Provider-specific model override`
- `--prompt string Initial prompt for the first provider run`
- `--provider-pty Run the provider subprocess inside a pseudo-terminal instead of plain pipes when interactive controls are available`
- `--team string Override the selected team_id for this command`
- `--trip-on-danger Remove provider bypass flags and use native provider safety checks`
- `--wait int Idle seconds per wake-stream wait cycle (default 20)`
- `--work-prompt-suffix string Override the configured work cycle prompt suffix for this run`

## `epic`

### `epic`

Manage epics (top-level work containers)

Subcommands:
- `create` Create a new epic
- `list` List epics

Flags:
- `-h, --help help for epic`
- `--team string Override the selected team_id for this command`

## `epic create`

### `epic create`

Create a new epic

Flags:
- `--description string Epic description`
- `-h, --help help for create`
- `--title string Epic title (required)`

## `epic list`

### `epic list`

List epics

Flags:
- `-h, --help help for list`

## `story`

### `story`

Manage stories (mid-level work containers under an epic)

Subcommands:
- `create` Create a new story
- `list` List stories

Flags:
- `-h, --help help for story`
- `--team string Override the selected team_id for this command`

## `story create`

### `story create`

Create a new story

Flags:
- `--description string Story description`
- `--epic string Parent epic ref`
- `-h, --help help for create`
- `--title string Story title (required)`

## `story list`

### `story list`

List stories

Flags:
- `--epic string Filter by parent epic ref`
- `-h, --help help for list`

## `issue`

### `issue`

Manage issues (the unit of work agents claim and complete)

Subcommands:
- `assign` Claim an issue for a workspace
- `comment` Add a comment to an issue
- `create` Create a new issue
- `list` List issues
- `show` Show issue details
- `status` Move an issue to a new status (todo, in_progress, in_review, done)

Flags:
- `-h, --help help for issue`
- `--team string Override the selected team_id for this command`

## `issue assign`

### `issue assign`

Claim an issue for a workspace

Flags:
- `--assignee string Assignee agent alias (defaults to the current workspace)`
- `-h, --help help for assign`

## `issue comment`

### `issue comment`

Add a comment to an issue

Flags:
- `-h, --help help for comment`

## `issue create`

### `issue create`

Create a new issue

Flags:
- `--description string Issue description`
- `-h, --help help for create`
- `--labels string Comma-separated labels`
- `--story string Parent story ref`
- `--title string Issue title (required)`

## `issue list`

### `issue list`

List issues

Flags:
- `--assignee string Filter by assignee agent alias`
- `-h, --help help for list`
- `--labels string Filter by labels (comma-separated)`
- `--status string Filter by status (todo, in_progress, in_review, done)`

## `issue show`

### `issue show`

Show issue details

Flags:
- `-h, --help help for show`

## `issue status`

### `issue status`

Move an issue to a new status (todo, in_progress, in_review, done)

Flags:
- `-h, --help help for status`

## `work`

### `work`

Discover coordination-aware work

Subcommands:
- `active` List active in-progress work across the team
- `ready` List ready issues that are not already claimed by other workspaces

Flags:
- `-h, --help help for work`
- `--team string Override the selected team_id for this command`

## `work active`

### `work active`

List active in-progress work across the team

Flags:
- `-h, --help help for active`

## `work ready`

### `work ready`

List ready issues that are not already claimed by other workspaces

Flags:
- `-h, --help help for ready`

## `completion`

### `completion`

Generate the autocompletion script for aw for the specified shell.
See each sub-command's help for details on how to use the generated script.

Subcommands:
- `bash` Generate the autocompletion script for bash
- `fish` Generate the autocompletion script for fish
- `powershell` Generate the autocompletion script for powershell
- `zsh` Generate the autocompletion script for zsh

Flags:
- `-h, --help help for completion`

## `completion bash`

### `completion bash`

Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

	source <(aw completion bash)

To load completions for every new session, execute once:

#### Linux:

	aw completion bash > /etc/bash_completion.d/aw

#### macOS:

	aw completion bash > $(brew --prefix)/etc/bash_completion.d/aw

You will need to start a new shell for this setup to take effect.

Flags:
- `-h, --help help for bash`
- `--no-descriptions disable completion descriptions`

## `completion fish`

### `completion fish`

Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

	aw completion fish | source

To load completions for every new session, execute once:

	aw completion fish > ~/.config/fish/completions/aw.fish

You will need to start a new shell for this setup to take effect.

Flags:
- `-h, --help help for fish`
- `--no-descriptions disable completion descriptions`

## `completion powershell`

### `completion powershell`

Generate the autocompletion script for powershell.

To load completions in your current shell session:

	aw completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.

Flags:
- `-h, --help help for powershell`
- `--no-descriptions disable completion descriptions`

## `completion zsh`

### `completion zsh`

Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

	echo "autoload -U compinit; compinit" >> ~/.zshrc

To load completions in your current shell session:

	source <(aw completion zsh)

To load completions for every new session, execute once:

#### Linux:

	aw completion zsh > "${fpath[1]}/_aw"

#### macOS:

	aw completion zsh > $(brew --prefix)/share/zsh/site-functions/_aw

You will need to start a new shell for this setup to take effect.

Flags:
- `-h, --help help for zsh`
- `--no-descriptions disable completion descriptions`

## `doctor`

### `doctor`

Diagnose local identity, workspace, and coordination state

Subcommands:
- `identity` Run identity doctor checks
- `local` Run local doctor checks
- `messaging` Run messaging doctor checks
- `registry` Run registry doctor checks
- `support-bundle` Write a redacted doctor support bundle
- `team` Run team doctor checks
- `workspace` Run workspace doctor checks

Flags:
- `--dry-run Plan fixes without applying them`
- `--fix Apply safe doctor fixes`
- `-h, --help help for doctor`
- `--offline Run without network checks`
- `--online Allow online checks`
- `--team string Override the selected team_id for this command`
- `--verbose Include verbose diagnostic details`

## `doctor identity`

### `doctor identity`

Run identity doctor checks

Flags:
- `-h, --help help for identity`

## `doctor local`

### `doctor local`

Run local doctor checks

Flags:
- `-h, --help help for local`

## `doctor messaging`

### `doctor messaging`

Run messaging doctor checks

Flags:
- `-h, --help help for messaging`

## `doctor registry`

### `doctor registry`

Run registry doctor checks

Flags:
- `-h, --help help for registry`

## `doctor support-bundle`

### `doctor support-bundle`

Write a redacted doctor support bundle

Flags:
- `-h, --help help for support-bundle`
- `--output string Output JSON file`

## `doctor team`

### `doctor team`

Run team doctor checks

Flags:
- `-h, --help help for team`

## `doctor workspace`

### `doctor workspace`

Run workspace doctor checks

Flags:
- `-h, --help help for workspace`

## `help`

### `help`

Help provides help for any command in the application.
Simply type aw help [path to command] for full details.

Flags:
- `-h, --help help for help`

## `upgrade`

### `upgrade`

Upgrade aw to the latest version

Flags:
- `-h, --help help for upgrade`

## `version`

### `version`

Print version information

Flags:
- `-h, --help help for version`

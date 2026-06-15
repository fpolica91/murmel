# Completion Audit — Humans as First-Class Participants

Status: architect decision, ready for build lanes (backend + UI).
Branch: `feature/simple-auth-ui`. Repo: `/Users/fabricio/Desktop/aweb`.

This document is the **single source of truth** the backend lane and the UI
lanes implement to. It is self-contained.

---

## 1. The core fact (verified in code)

The `agents` table is a **participant / identity directory**, not an
agent-only table. Columns (see `001_initial.sql`):

```
agent_id, team_id, did_key, address, alias, human_name,
agent_type (default 'agent'), role, status, inbound_mode, identity_scope, ...
```

- `idx_agents_active_alias` is `UNIQUE (team_id, alias) WHERE deleted_at IS NULL`
  — **aliases are unique team-wide across humans and agents**, so an alias is a
  safe, stable selector for chat/assignment regardless of participant kind.
- Chat/messages route to recipients by alias / address / did pulled from this
  table (`get_agent_by_alias`, `get_agents_by_aliases`, `resolve_agent_by_did`
  in `messaging/chat.py`).
- **A human becomes a first-class chat/comment/assignee participant simply by
  having a row here** with `agent_type='human'`, `human_name` set, `alias` set,
  `address = team_id/alias`. No key ceremony, no certs.

### What already exists (do not rebuild)

- `identity_auth_deps._ensure_token_agent` **already** inserts a human row
  (`agent_type='human'`, `identity_scope='local'`, synthetic
  `did_key = did:key:jwt-<subject>`, `address = team_id/alias`) — but **only**
  on the messaging path (`get_messaging_auth`), and it is keyed by the synthetic
  did_key, idempotent via `ON CONFLICT (team_id, did_key) WHERE deleted_at IS NULL`.
- Issues already support human assignees at the schema/service layer:
  `coordination/hierarchy.ASSIGNEE_TYPES = ("human","agent")`; `issues` has
  `assignee_type`/`assignee_id`. `IssueView` exposes both.
- Issue comments store `author = identity.alias` (the human's display name on
  the token path — see `token_team_scope.token_identity`).

### The three degradations and their exact root causes

1. **Humans cannot be chat recipients.** `get_agent_by_alias` /
   `get_agents_by_aliases` (the `to_aliases` resolver in `messaging/chat.py`)
   hard-exclude `COALESCE(agent_type,'agent') != 'human'`. So even a
   provisioned human row is unreachable by alias.
2. **Roster is admin-gated + nameless + no authoritative kind.** `GET /v1/agents`
   excludes humans (`AND COALESCE(a.agent_type,'agent') != 'human'`). The only
   human list is `GET /v1/teams/{id}/members` (admin-only, returns raw `subject`,
   no name). No endpoint exposes an authoritative human-vs-agent flag, so the UI
   guesses by matching sender alias against the agent list.
3. **Assignee picker can't assign to humans.** Humans never appear in any
   non-admin roster, so the picker (built from `listAgents`) only shows agents,
   even though the issue model accepts `assignee_type='human'`.

A second, quieter gap: the **issues/comments path provisions nothing**.
`hierarchy.py` and `agents.py` authenticate via `get_team_identity`, which under
JWT returns a `TeamIdentity` but does **not** create the agents row. A human who
only ever touches issues/comments (never chat) has no participant row at all.

---

## 2. Chosen design (minimal, safe, no new participant table)

### 2.1 Definitive human-vs-agent signal: `kind`

Expose a first-class, explicit field **`kind`** on every participant the API
returns (roster, chat participants, message senders, comment authors,
assignees). `kind` is derived **authoritatively** from `agents.agent_type`:

```
kind = "human"  iff agent_type = 'human'
kind = "agent"  otherwise   (agent_type in 'agent' | NULL | anything else)
```

The UI **never guesses**. `agent_type` is kept as the storage column; `kind` is
the normalized two-value projection the API/UI agree on. Both names appear in
responses for back-compat (`agent_type` raw passthrough, `kind` normalized), but
**`kind` is the field every consumer keys on.**

### 2.2 Auto-provision a human participant on ANY authenticated request

Lift provisioning out of the messaging-only path into the shared token-identity
resolver so **every** authenticated human request (chat, issues, comments,
roster, assignment) guarantees a participant row.

- In `token_team_scope.resolve_token_team_identity` (the one funnel every
  token-auth route passes through via `get_team_identity` and indirectly
  `get_messaging_auth`), after selecting the team, **idempotently upsert the
  human's agents row** using the same shape as `_ensure_token_agent`:
  - `did_key = did:key:jwt-<subject>` (deterministic, local-only routing key)
  - `agent_type = 'human'`, `identity_scope = 'local'`
  - `alias = <name claim> || <agent_name> || <subject>` (same as
    `token_identity` today)
  - `human_name = <name claim>` (fall back to alias if name claim absent)
  - `address = team_id/alias`
  - `ON CONFLICT (team_id, did_key) WHERE deleted_at IS NULL DO UPDATE` keeping
    `alias`, `human_name`, `address` in sync.
- `_ensure_token_agent` is refactored to a single shared helper
  (`provision_human_participant(db, team_id, subject, name, agent_name)`) called
  from both `get_messaging_auth` and `resolve_token_team_identity`. No behavior
  change for agents; agents (cert path / real did_key rows) are untouched.
- **`human_name` must be populated** (today `_ensure_token_agent` passes
  `alias or ""`, which when alias falls back to subject yields a non-empty but
  ugly value; the new helper prefers the `name` claim so the roster shows a real
  display name). The `TeamIdentity.agent_id` stays the subject for authz parity.

This makes the human row exist before the first chat/issue/roster call, so they
are immediately reachable and selectable.

### 2.3 Humans become chat recipients

Drop the `agent_type != 'human'` filter from the alias resolvers used to
**target** a recipient:

- `messaging/chat.get_agent_by_alias`
- `messaging/chat.get_agents_by_aliases`

These now resolve ANY non-deleted participant in the team by alias (human or
agent). `resolve_agent_by_did` already has no type filter (good). Attribution on
send already uses `from_alias` / `from_agent_id` / `from_did` from the resolved
actor row, so a human sender/recipient attributes correctly with no further
change. `authorize_message_delivery` runs against the resolved row as today;
human rows have `inbound_mode` NULL → treated as default team-open, which is
correct for intra-team collaboration.

### 2.4 Humans become assignable

Already supported at the model layer. The only missing piece is **visibility**:
the roster endpoint (below) returns humans, so the UI assignee picker can list
them. `assignee_id` for a human is the human's **alias** (consistent with
comment `author`, which is the alias). `assignee_type='human'`.

### 2.5 Comments / messages attribute correctly + carry kind

- Comments already store `author = alias`. Add `author_kind` to the comment view
  by resolving the author alias against the participant directory (human/agent).
  If the author alias is not found (legacy), default `author_kind='agent'` —
  never block.
- Chat messages: add `from_kind` to each message dict, resolved from the
  sender's participant row by `from_did`/`from_alias`. UI keys on `from_kind`,
  not on guessing.

---

## 3. API CONTRACT (backend + UI both implement to this)

All endpoints are token-auth (`Authorization: Bearer <jwt>` +
`X-AWEB-Team-Id: <teamId>`), already handled by the UI's `authedRequest`.

### 3.1 Participants roster — NEW, non-admin, unified

`GET /v1/participants` → `200`

```ts
interface ParticipantsResponse {
  team_id: string;
  participants: Participant[];
}
interface Participant {
  kind: "human" | "agent";   // AUTHORITATIVE. UI keys on this. Never guess.
  alias: string;             // stable team-unique selector (chat + assignee_id)
  display_name: string;      // human_name for humans; alias for agents if blank
  agent_id: string | null;   // agents.agent_id (UUID) when present
  did_key: string | null;
  did_aw: string | null;
  address: string | null;    // "team_id/alias"
  role: string | null;
  agent_type: string;        // raw passthrough ('human' | 'agent' | ...)
  // presence (agents only; humans report online:false, status:"offline"):
  online: boolean;
  status: string;            // "offline" when no live presence
  last_seen: string | null;  // ISO
}
```

- Returns **both humans and agents** for the team, to **any** team member
  (NOT admin-gated). Humans have `kind:"human"`, `online:false`,
  `status:"offline"`, `last_seen:null`. Agents carry presence exactly as
  `GET /v1/agents` does today.
- This is the endpoint the UI uses for: the team roster, the chat
  recipient picker, and the issue assignee picker.

`GET /v1/agents` is **kept unchanged** (still agents-only, still presence) for
back-compat. The UI MUST migrate roster/pickers to `/v1/participants`.

### 3.2 Chat — humans targetable by alias

`POST /v1/chat/sessions` body `{ "message": "...", "to_aliases": ["<alias>"] }`
now accepts a **human** alias as a recipient (previously 404
"Unknown aliases"). Response shape unchanged (`CreateSessionResponse`).

`GET /v1/chat/sessions/{id}/messages` → each `ChatMessage` gains:

```ts
from_kind: "human" | "agent";   // authoritative sender kind
```

(All existing fields unchanged.) The UI renders human vs agent from `from_kind`,
not by matching aliases.

### 3.3 Issues — assignee picker includes humans

No request/response shape change to issues. `assignee_type` already
`"human" | "agent" | null`; `assignee_id` for a human is the human's **alias**
(the value shown in `/v1/participants`). UI builds the picker from
`/v1/participants` and sends:

```
PATCH /v1/issues/{id}  { "assignee_type": "human", "assignee_id": "<alias>" }
```

`GET /v1/issues/{id}` may additionally return `assignee_display_name` and
`assignee_kind` (resolved from the directory) so the UI renders the assignee
without a second lookup. If unresolved, `assignee_kind` mirrors the stored
`assignee_type` and `assignee_display_name` falls back to `assignee_id`.

### 3.4 Issue comments — author kind

`GET /v1/issues/{id}/comments` → each comment gains:

```ts
author_kind: "human" | "agent";   // resolved from author alias; default "agent"
```

`POST /v1/issues/{id}/comments` unchanged (author = caller's alias). The human's
alias is the same value the roster shows, so attribution lines up everywhere.

### 3.5 Field-name agreement (backend AND UI must use exactly these)

| Concept                | Field name      | Values / notes                                  |
|------------------------|-----------------|-------------------------------------------------|
| participant type       | `kind`          | `"human"` \| `"agent"` (authoritative)          |
| raw storage type       | `agent_type`    | passthrough of `agents.agent_type`              |
| display label          | `display_name`  | human_name for humans; alias for agents         |
| selector / chat target | `alias`         | team-unique; used as `to_aliases` + `assignee_id` |
| message sender type    | `from_kind`     | `"human"` \| `"agent"`                           |
| comment author type    | `author_kind`   | `"human"` \| `"agent"`                           |
| issue assignee type    | `assignee_type` | `"human"` \| `"agent"` \| `null`                |
| issue assignee value   | `assignee_id`   | alias (human or agent)                           |

---

## 4. Schema change

NEW migration only (never edit an applied file — pgdbm checksums them):

`server/src/aweb/migrations/aweb/012_humans_as_participants.sql`

Purpose / contents (additive, idempotent, safe to re-run):

1. **Backfill** human participant rows for every active membership lacking one,
   so existing humans show up immediately:
   - For each `(subject, team_id)` in `memberships` with `status='active'` that
     has no `agents` row with `did_key = 'did:key:jwt-'||subject`, insert one
     with `agent_type='human'`, `identity_scope='local'`,
     `alias` = subject (display name not available at migration time; the
     runtime upsert in 2.2 refreshes `alias`/`human_name` from the `name` claim
     on that human's next request), `human_name=''`, `address=team_id||'/'||alias`.
   - Guard against alias collisions with existing agents: if `alias` (subject)
     already exists for the team, suffix to keep the unique index happy
     (e.g. append a short subject hash). The runtime upsert keyed on `did_key`
     remains the source of truth and will reconcile.
2. **Index** to make directory listing fast:
   `CREATE INDEX IF NOT EXISTS idx_agents_team_type ON {{tables.agents}} (team_id, agent_type) WHERE deleted_at IS NULL;`

No DDL changes to existing columns. `agent_type` and `human_name` already exist.

---

## 5. Files the backend lane touches

- `server/src/aweb/migrations/aweb/012_humans_as_participants.sql` (NEW).
- `server/src/aweb/identity_auth_deps.py` — extract `provision_human_participant`
  from `_ensure_token_agent`; populate `human_name` from name claim.
- `server/src/aweb/token_team_scope.py` — call `provision_human_participant`
  inside `resolve_token_team_identity` so issues/comments/roster paths provision
  too. (Pass the verified `name` claim through.)
- `server/src/aweb/messaging/chat.py` — remove the `agent_type != 'human'`
  filter in `get_agent_by_alias` and `get_agents_by_aliases`; add `from_kind`
  to message dicts.
- `server/src/aweb/routes/participants.py` (NEW router) `GET /v1/participants`,
  wired in app startup next to `agents` router. (Reuses the `list_agents`
  presence-join query without the human exclusion, adds `kind`.)
- `server/src/aweb/routes/hierarchy.py` + `coordination/hierarchy.py` — add
  `author_kind` to comment views and `assignee_kind`/`assignee_display_name` to
  issue views (directory lookup helper).
- Tests: add coverage; **do not break** the existing passing suite. Existing
  `GET /v1/agents` behavior (humans excluded) is preserved.

## 6. Files the UI lanes touch

- `src/lib/api/participants.ts` (NEW) — `listParticipants(teamId): Participant[]`.
- Roster: render from `/v1/participants`, badge `kind`. Drop the admin-gated
  `listMembers` dependency for the roster (keep it only for the admin member
  admin screen if any).
- Chat recipient picker: source from `/v1/participants`, allow humans
  (use `alias`). Render sender side by `from_kind`.
- Issue assignee picker: source from `/v1/participants`, allow
  `assignee_type:"human"` with `assignee_id = alias`.
- Comments: badge author by `author_kind`.
- `ui/CONTRACTS.md`: supersede the "graceful degradation" section — humans are
  now first-class (chat targets, roster without admin, assignable).

---

## 7. Definition of Done (each item end-to-end checkable)

1. **Human provisioning (any path):** A freshly-invited human who has only ever
   hit `GET /v1/issues` (never chat) has exactly one `agents` row with
   `agent_type='human'`, non-empty `alias`, `human_name` from their name claim,
   `address='<team>/<alias>'`. Verify with
   `psql ... -c "select alias,human_name,agent_type,address from agents where agent_type='human'"`.
2. **Roster shows humans + agents with authoritative kind (no admin):** A
   non-admin member calls `GET /v1/participants` and receives both humans
   (`kind:"human"`) and agents (`kind:"agent"`), each with `display_name`. No
   `403`. No raw auth subject leaks as the display name.
3. **Human is a chat recipient:** `POST /v1/chat/sessions` with
   `to_aliases:["<human alias>"]` returns `200` with a session (not `404`
   "Unknown aliases"). The human can `GET .../messages` and reply.
4. **Sender kind is authoritative:** In `GET /v1/chat/sessions/{id}/messages`,
   a message from a human carries `from_kind:"human"`; from an agent
   `from_kind:"agent"`. The UI renders attribution from `from_kind` with zero
   alias-matching guesswork.
5. **Assign an issue to a human:** `PATCH /v1/issues/{id}` with
   `{assignee_type:"human", assignee_id:"<human alias>"}` returns `200`;
   `GET /v1/issues/{id}` reflects it and (if implemented) returns
   `assignee_kind:"human"` + `assignee_display_name`.
6. **Assignee picker includes humans (UI):** On the issue detail UI, the
   assignee dropdown lists humans and agents (sourced from `/v1/participants`);
   selecting a human persists and re-renders with the human's display name.
7. **Comment attribution + kind:** A human posts a comment; the human's display
   alias is the `author`, and `GET .../comments` returns `author_kind:"human"`
   for it and `author_kind:"agent"` for an agent's comment. The UI badges both.
8. **Agents unbroken:** Agent-to-agent chat, agent roster (`GET /v1/agents`
   still agents-only), agent assignment, agent comments all behave exactly as
   before. The existing server test suite passes (`make test-server`).
9. **Migration safe:** `012_humans_as_participants.sql` applies cleanly on a
   fresh DB and on the live `localhost:5544` DB without checksum errors; no
   existing migration file is modified; backfilled human rows do not violate
   `idx_agents_active_alias`.
10. **End-to-end human↔agent loop:** A logged-in human in the UI can (a) see an
    agent and another human in the roster, (b) start a chat with an agent and
    receive a reply, (c) be chatted-to by an agent, (d) open an issue, assign it
    to themselves (human) and to an agent, (e) comment and see the agent's
    comment, all with correct human/agent badges throughout.

---

## 8. Risks & mitigations

- **Alias collision human vs agent.** Aliases are team-unique across types
  (`idx_agents_active_alias`). The runtime upsert is keyed on `did_key`
  (`did:key:jwt-<subject>`), so re-auth never duplicates; the migration backfill
  must suffix on collision. Mitigation: keyed-on-did_key upsert + collision
  suffix in the migration.
- **Removing the human filter in alias resolvers** could let a human be targeted
  before they have presence — acceptable; humans have no presence by design and
  delivery is via stored messages they poll. `authorize_message_delivery` still
  runs.
- **`/v1/agents` consumers** that assumed humans-excluded keep working (endpoint
  unchanged). Only the UI migrates to `/v1/participants`.
- **Comment `author_kind` for legacy rows** where the author alias no longer
  resolves: default to `"agent"`, never error.
- **Do not edit `001_registry.sql` / any applied migration** (checksum boot
  failure). All schema work is in `012_*`.

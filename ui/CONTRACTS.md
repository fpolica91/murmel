# Collaboration UI — Build Contract

This file is the **single source of truth** for the three collaboration
features. It is self-contained: you do not need to read the backend or other
lanes. Build only inside your assigned feature folder.

Stack while developing:

- UI dev server: `http://localhost:3030`
- aweb API: `http://localhost:8088` (set as `NEXT_PUBLIC_AWEB_API_URL`)
- Postgres: `localhost:5544` (`PGPASSWORD=change-me -U aweb -d aweb`)

---

## 0. Shared rules (READ FIRST)

### Auth + team scoping — already handled for you

Every aweb call needs **two** things and the shared helper attaches both:

1. `Authorization: Bearer <jwt>` — a short-lived JWT minted same-origin from
   `${window.location.origin}/api/auth/token`.
2. `X-AWEB-Team-Id: <teamId>` — the active team. **Header name is exactly
   `X-AWEB-Team-Id`** (lowercased `x-aweb-team-id` on the wire; HTTP headers are
   case-insensitive). This mirrors `client.ts`.

You never build these by hand. Use `authedRequest` from `@/lib/api/http`.

### How to call the API

```ts
import { authedRequest, ApiError } from "@/lib/api/http";

// GET with query + team scope
const data = await authedRequest<MyResponse>("/v1/some/path", {
  teamId,                       // from useTeam() — see below
  query: { status: "todo" },    // undefined/null/"" values are dropped
});

// POST with JSON body
const created = await authedRequest<MyResponse>("/v1/some/path", {
  method: "POST",
  teamId,
  body: { foo: "bar" },
});
```

`authedRequest<T>(path, opts?)` options:

- `method?` — defaults to `"GET"`.
- `query?` — `Record<string, string|number|boolean|undefined|null>`. Empty /
  nullish values are skipped.
- `body?` — any JSON-serializable value (sets `content-type` automatically).
- `teamId?` — **pass this explicitly.** If omitted it falls back to
  `localStorage["aweb.activeTeam"]`. Passing it from `useTeam()` is correct and
  avoids SSR/stale issues.
- `signal?` — `AbortSignal` for cancellation.

Behavior: returns parsed JSON; returns `undefined` for `204`; throws
`ApiError(status, detail, body)` on non-2xx. Catch `ApiError` and check
`err.status` (e.g. `403` → not authorized, `404` → not found).

There is also `getAccessToken(): Promise<string|null>` exported from the same
module if you ever need the raw token (e.g. to open an SSE `EventSource` with a
query param). You usually won't.

### How to read the active team id (client components)

```tsx
"use client";
import { useTeam } from "@/components/team-context";

export function MyView() {
  const { activeTeam } = useTeam();        // string | null
  // pass activeTeam as teamId to authedRequest / member helpers
}
```

`useTeam()` also exposes `teams: string[]` and `setActiveTeam(id)`. It must be
used under the dashboard layout (the `<TeamProvider>` is already mounted there).
If `activeTeam` is `null`, render an empty state — don't call the API.

### Member / agent helpers

`@/lib/api/members` wraps the two "who's on the team" endpoints and exports the
types:

```ts
import { listAgents, listMembers } from "@/lib/api/members";
import type { Agent, Member } from "@/lib/api/members";

const agents = await listAgents(teamId);   // Agent[]  (any caller)
const members = await listMembers(teamId); // Member[] (ADMIN-ONLY → may 403)
```

**Human vs agent — this is important:**

- `listAgents` → `GET /v1/agents`. Returns **agents only**; the server
  explicitly excludes `agent_type === 'human'`. Each `Agent` carries presence:
  `online: boolean`, `status: string` (`"offline"` when no live presence),
  `last_seen: string | null` (ISO).
- `listMembers` → `GET /v1/teams/{teamId}/members`. Returns **human
  memberships** from the auth table. **Admin/owner only** — it throws
  `ApiError` with `status === 403` for non-admins. There is **no presence and no
  display name** for humans, only `subject` (Better Auth user id), `role`,
  `status`. Always wrap in try/catch and degrade (show agents only) on 403.

### Styling rules

- Dark theme. The global stylesheet (`globals.css`) defines CSS variables you
  MUST reuse: `--bg #0b0c0f`, `--panel #15171c`, `--border #262a33`,
  `--text #e6e8ec`, `--muted #9aa1ad`, `--accent #4f8cff`.
- Reuse existing global classes where they fit: `.panel` (card surface),
  `.btn`, `.btn-primary`, `.muted`, `.content` (page padding wrapper),
  `.row`.
- For anything bespoke, create a **co-located CSS module** next to your
  component (e.g. `chat.module.css`) and import it as `styles`. Match the
  conventions in `src/components/work/work.module.css`:
  - camelCase class names (`.cardStack`, `.commentMeta`).
  - Reference the CSS vars above, never hardcode theme colors.
  - Inputs/selects: `background: #1d2027; border: 1px solid var(--border);
    border-radius: 8px; color: var(--text);`.
  - Rounded panels: `border-radius: 12px`, `padding: 1.25rem–1.5rem`.
  - Section labels: uppercase, `letter-spacing: 0.04em`, `color: var(--muted)`,
    `font-size: 0.75rem`.
  - Empty states: a centered, muted block (see `.empty` / `.activityThread`).
- Aim for a Linear-ish product feel: clear headers, generous spacing, explicit
  empty states, hover affordances, status badges.

### HARD RULES for build agents

- ONLY create files inside your assigned feature folder.
- The ONLY pre-existing files you may edit are the ones explicitly assigned to
  your feature.
- **NEVER edit:** `src/lib/api/client.ts`, `src/lib/api/http.ts`,
  `src/lib/api/members.ts`, `src/app/dashboard/layout.tsx`,
  `src/components/team-context.tsx`, `src/app/globals.css`.
- Navigation links into your feature are added later by the integrator. Do NOT
  touch the top bar / layout / `Topbar`.
- Use `authedRequest` for every server call. Do not hand-roll fetch + auth.

---

## Feature 1 — Conversations / Chat

Goal: list conversations, read one, send a message. A chat session is between
the authenticated caller and one or more peers (a peer/recipient IS required to
start a new session; continuing an existing session is by `session_id` only).

### 1a. List conversations (mail + chat combined)

`GET /v1/conversations`

- Query (all optional): `conversation_type` (`"chat"` | `"mail"`),
  `participant_did`, `participant_address`, `cursor` (ISO ts), `limit`
  (1–100, default 50).
- For a chat-only inbox, pass `conversation_type: "chat"`.
- Response:

```ts
interface ConversationsResponse {
  conversations: ConversationItem[];
  next_cursor: string | null;
}
interface ConversationItem {
  conversation_type: "mail" | "chat";
  conversation_id: string | null;      // the chat session_id for chat rows
  legacy_message_id: string | null;    // mail-only legacy fallback
  status: string;                       // "active" for chat
  participants: string[];               // display aliases (includes you)
  participant_dids: string[];
  participant_addresses: string[];
  subject: string;                      // "" for chat
  last_message_at: string;              // ISO
  last_message_from: string;            // alias of last sender
  last_message_preview: string;         // first ~100 chars
  unread_count: number;
}
```

Alternative (chat-native, no mail): `GET /v1/chat/sessions` →
`{ sessions: SessionListItem[] }` where each item is
`{ session_id, conversation_id, team_id, participants: string[],
participant_dids: string[], participant_addresses: string[], created_at,
last_activity, sender_waiting: boolean }`. **Recommended for a pure chat UI**
because it is chat-only and includes `sender_waiting`. Use
`GET /v1/conversations?conversation_type=chat` if you want unread counts +
last-message previews.

### 1b. Read messages in a conversation

`GET /v1/chat/sessions/{session_id}/messages`

- `session_id` = the `conversation_id` from a chat row.
- Query (optional): `unread_only` (bool, default false), `limit` (1–2000,
  default 200), `message_id`.
- Response: `{ messages: ChatMessage[] }` (oldest → newest). Each message
  (untyped `dict` server-side; relevant fields):

```ts
interface ChatMessage {
  conversation_id: string;
  message_id: string;
  from_agent: string;       // sender alias  — use to render who sent it
  from_address: string | null;
  body: string;             // plaintext (encrypted sessions return "")
  content_mode: string;     // "legacy_plaintext_v1" for normal chat
  message_version: number;  // 1 for normal chat
  timestamp: string;        // ISO
  sender_leaving: boolean;
  reply_to: string | null;
  to_address: string;
  from_did: string | null;
  from_stable_id: string | null;
  is_contact: boolean;
}
```

You only need `message_id`, `from_agent`, `body`, `timestamp`. Treat the caller
as "me" by comparing `from_agent` to your own alias, OR just align right/left by
whether `from_did` is in the conversation's other participants. (Simplest: the
last sender that equals the current user's alias is "me".)

Mark read (optional, for unread badges): `POST /v1/chat/sessions/{session_id}/read`
with body `{ "up_to_message_id": "<uuid>" }`.

### 1c. Send a message

Two cases:

**Continue an existing session** (you have a `session_id`):
`POST /v1/chat/sessions/{session_id}/messages`

- Body: `{ "body": "hello" }` (that's all you need; `content_mode` defaults to
  plaintext). Optional: `reply_to` (uuid of a message in the session).
- Response: `{ message_id, conversation_id, delivered: boolean,
  extends_wait_seconds: number }`.

**Start a new session with a peer** (no session yet):
`POST /v1/chat/sessions`

- Body must name a recipient. Simplest for an intra-team UI is by alias:
  `{ "message": "hi", "to_aliases": ["<peerAlias>"] }`. (Other target forms:
  `to_dids: string[]`, `to_addresses: ["domain/name"]`.) A peer IS required —
  you cannot create an empty session.
- If a 1:1 session with that peer already exists, the server returns it (or
  409s telling you to continue it). Response:

```ts
interface CreateSessionResponse {
  session_id: string;
  conversation_id: string;     // == session_id
  message_id: string;
  participants: { did: string; alias: string; agent_id: string | null;
                  address: string | null }[];
  sse_url: string;             // "/v1/chat/sessions/{id}/stream"
  targets_connected: string[];
  targets_left: string[];
}
```

To pick a peer to start a chat with, list agents via `listAgents(teamId)` (and,
if admin, human members via `listMembers`) and use an agent's `alias` as the
`to_aliases` entry. NOTE: human members from `listMembers` have no `alias`, only
a `subject` — you cannot start a chat to a bare human subject via `to_aliases`.
For v1, **start chats with agents** (they have aliases). See the "degrade
gracefully" note below.

### 1d. Live updates (optional)

`GET /v1/chat/sessions/{session_id}/stream` is an SSE endpoint. For v1 you may
**poll** `GET .../messages` every few seconds instead — simpler and fine. If you
do SSE, you'll need the token as the helper can't set headers on `EventSource`;
use `getAccessToken()` and append it however the endpoint expects. Prefer
polling for the first cut.

---

## Feature 2 — Members & Presence (team roster)

Goal: show who is on the team, distinguish humans from agents, and show
presence (online / last seen) where it exists.

### 2a. Agents (with presence) — any caller

`listAgents(teamId)` → `Agent[]` (see shared helper). Underlying:
`GET /v1/agents` → `{ team_id, agents: Agent[] }`.

Distinguishing + presence fields on `Agent`:

- This endpoint returns **agents only** (humans are excluded server-side).
- `online: boolean` — live presence present.
- `status: string` — `"offline"` when no live presence, else the live status
  (e.g. `"active"`).
- `last_seen: string | null` — ISO timestamp, or `null`.
- `role` / `role_name`, `workspace_type`, `hostname`, `repo`,
  `workspace_path` — workspace context for display.
- `human_name` — optional human label attached to an agent workspace (NOT a
  team human member).

### 2b. Human members — ADMIN ONLY

`listMembers(teamId)` → `Member[]`. Underlying:
`GET /v1/teams/{teamId}/members` → `{ team_id, members: Member[] }`.

- `Member = { subject, team_id, role, status, created_at, updated_at }`.
- **403 for non-admins** — wrap in try/catch on `ApiError` and, on 403, render
  the roster with agents only plus a muted note like "Human member list
  requires admin." There is **no presence and no name** for humans — show
  `subject` (or a truncated form) and `role`/`status` only.

### 2c. Richer presence (optional)

`GET /v1/status` → `{ agents: [...], claims, locks, conflicts, timestamp }`
aggregates workspace presence + what each agent is working on
(`current_task_ref`, `focus_task_title`, `last_seen`, `status`). Use this if you
want a "what is everyone doing" board. Fields per agent include `alias`,
`human_name`, `role`, `status`, `last_seen`, `current_task_ref`,
`focus_task_title`. For a plain roster, `listAgents` is enough.

---

## Feature 3 — Issue collaboration (comments + assignment)

Goal: on an issue, show its comment thread, post comments, and set the
assignee.

### 3a. List comments

`GET /v1/issues/{issue_id}/comments` →

```ts
interface ListCommentsResponse {
  issue_id: string;
  comments: {
    comment_id: string;
    issue_id: string;
    author: string;     // alias of the author (human or agent)
    body: string;
    created_at: string | null;  // ISO
  }[];
}
```

Comments are oldest-first.

### 3b. Add a comment

`POST /v1/issues/{issue_id}/comments`

- Body: `{ "body": "your comment" }` (1–16384 chars).
- The author is the authenticated caller (server uses your alias). 201 →
  returns the created `CommentView`:
  `{ comment_id, issue_id, author, body, created_at }`.

### 3c. Read an issue (to render the detail + current assignee)

`GET /v1/issues/{issue_id}` →

```ts
interface Issue {
  issue_id: string;
  team_id: string;
  epic_id: string | null;
  story_id: string | null;
  title: string;
  description: string | null;
  status: "todo" | "in_progress" | "in_review" | "done" | string;
  assignee_type: "human" | "agent" | null;
  assignee_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  comment_count: number;
}
```

### 3d. Set / change assignment

`PATCH /v1/issues/{issue_id}`

- Body: send only the fields you change. To assign:
  `{ "assignee_type": "agent" | "human", "assignee_id": "<id>" }`.
  To unassign: `{ "assignee_type": null, "assignee_id": null }`.
- Returns the updated `Issue`.

What goes in `assignee_id`?

- For **agents**: use the agent's `alias` or `agent_id` from
  `listAgents(teamId)`. (The field is free-form text up to 256 chars; alias is
  human-readable, agent_id is stable. Pick one and be consistent — alias is
  recommended for display parity with comments, which use alias as `author`.)
- For **humans**: use the member's `subject` from `listMembers(teamId)` (admin
  only). If you can't list members (403), restrict the assignee picker to
  agents and show a muted note.

There is also `POST /v1/issues/{issue_id}/claim` (body
`{ assignee_type, assignee_id, set_in_progress?: true }`) which assigns AND
moves the issue to `in_progress` in one call — use it if you want a one-click
"claim" affordance. For a plain assignee dropdown, use `PATCH`.

---

## Graceful degradation — features with NO clean backend path

- **Human members are admin-gated.** Non-admins get 403 from
  `listMembers`/`GET /v1/teams/{teamId}/members`. Every feature that wants to
  show or pick humans must catch `ApiError(status === 403)` and fall back to
  agents only. There is no non-admin endpoint that lists team humans.
- **Humans have no presence and no display name.** The roster can only show
  `subject` + `role` + `status` for humans; only agents have
  online/last_seen/status. Do not promise human presence in the UI.
- **You cannot start a chat to a bare human.** `POST /v1/chat/sessions`
  targets by `to_aliases` / `to_dids` / `to_addresses`; a human `subject` is
  none of those. v1 chat is agent-to-agent / you-to-agent. If you want
  human-to-human chat, that's out of scope for the current backend.
- **No dedicated "list my conversations for chat only with unread + preview"
  beyond `/v1/conversations`.** `/v1/chat/sessions` is chat-native but lacks
  unread/preview; `/v1/conversations?conversation_type=chat` has them but is the
  merged mail+chat model. Pick per your needs (documented in 1a).
- **SSE needs the raw token**, which `authedRequest` can't attach to
  `EventSource`. Prefer polling for v1; reach for `getAccessToken()` + SSE only
  if you implement live updates.

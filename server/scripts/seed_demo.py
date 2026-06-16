#!/usr/bin/env python3
"""Demo seed for the aweb coordination app — makes the live app demo-pristine.

WHAT THIS DOES
--------------
Replaces accumulated *test-run junk* (issues titled "E2E auto issue …",
"CHATREV-…", "verify-badge-check-…", stray chat sessions, etc.) with a small,
believable product backlog and a couple of realistic human<->agent
conversations, all scoped to the ``default:local`` team.

It is IDEMPOTENT / re-runnable: every run first clears the work + messaging
*content* tables, then re-inserts the curated demo backlog from scratch. Run it
again any time the board accumulates fresh test artifacts (e.g. after another
e2e suite run, which by design creates a couple of "E2E …" issues).

WHAT IT KEEPS (never deletes)
-----------------------------
* Identities: the Better Auth ``user`` rows for founder@/mia@/ada@/bob@local.test
* The ``default:local`` team + ``memberships``
* The ``agents`` participant rows AND their published encryption keys
  (``agent_encryption_keys``). Deleting these breaks E2E messaging, so we leave
  them strictly alone.

WHAT IT CLEARS (test content only)
----------------------------------
epics, stories, issues, issue_comments, tasks + task_comments + task_*counters,
chat_sessions/chat_participants/chat_messages/chat_read_receipts,
conversations/conversation_participants/messages — i.e. the junk titles.

WHAT IT INSERTS
---------------
* 4 epics (Authentication & SSO, Realtime collaboration, Billing & plans,
  Mobile app), each with a few stories.
* ~18 issues with realistic titles + short descriptions, spread across the
  todo / in_progress / in_review / done statuses, assigned across the 4
  identities (humans Founder/Mia + agents Ada/Bob), some unassigned.
* A few realistic comments on a couple of issues (from a human and an agent).
* Two realistic chat sessions: Founder<->Ada and Mia<->Bob, each with a short
  natural conversation.

USAGE
-----
    PGPASSWORD=change-me python3 server/scripts/seed_demo.py

Connection is configured via env (defaults match the local stack):
    PGHOST=localhost PGPORT=5544 PGUSER=aweb PGDATABASE=aweb PGPASSWORD=change-me

No server deps required — it talks to Postgres through ``psql`` (already used by
the e2e global-setup), so it runs from a bare checkout.
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid

TEAM = os.environ.get("SEED_TEAM", "default:local")

PG = {
    "host": os.environ.get("PGHOST", "localhost"),
    "port": os.environ.get("PGPORT", "5544"),
    "user": os.environ.get("PGUSER", "aweb"),
    "db": os.environ.get("PGDATABASE", "aweb"),
    "password": os.environ.get("PGPASSWORD", "change-me"),
}

# Stable aliases as resolved by the participant directory. The server resolves
# assignee_kind / author_kind from these aliases, so they must match the agents
# rows exactly.
FOUNDER = "Founder"
MIA = "Mia"
ADA = "Ada (agent)"
BOB = "Bob (agent)"


def psql(sql: str, *, tuples_only: bool = True) -> str:
    env = dict(os.environ, PGPASSWORD=PG["password"])
    args = [
        "psql",
        "-h", PG["host"],
        "-p", PG["port"],
        "-U", PG["user"],
        "-d", PG["db"],
        "-v", "ON_ERROR_STOP=1",
    ]
    if tuples_only:
        args.append("-tA")
    args += ["-c", sql]
    res = subprocess.run(args, env=env, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        raise SystemExit(f"psql failed (exit {res.returncode})")
    return res.stdout.strip()


def q(val: str | None) -> str:
    """Single-quote + escape a value for inline SQL (None -> NULL)."""
    if val is None:
        return "NULL"
    return "'" + val.replace("'", "''") + "'"


def did_for(alias: str) -> str:
    row = psql(
        f"SELECT did_key FROM aweb.agents "
        f"WHERE alias={q(alias)} AND deleted_at IS NULL LIMIT 1"
    )
    if not row:
        raise SystemExit(
            f"agent alias {alias!r} not found — run the e2e global-setup / aw init "
            f"first so identities + keys exist."
        )
    return row


def agent_id_for(alias: str) -> str:
    return psql(
        f"SELECT agent_id FROM aweb.agents "
        f"WHERE alias={q(alias)} AND deleted_at IS NULL LIMIT 1"
    )


# --------------------------------------------------------------------------- #
# 1. CLEAR test content (keep identities, memberships, agents, keys)
# --------------------------------------------------------------------------- #
def clear_content() -> None:
    statements = [
        # work content
        "DELETE FROM aweb.issue_comments WHERE team_id = {t}",
        "DELETE FROM aweb.issues WHERE team_id = {t}",
        "DELETE FROM aweb.stories WHERE team_id = {t}",
        "DELETE FROM aweb.epics WHERE team_id = {t}",
        # tasks (separate work model; clear junk + counters)
        "DELETE FROM aweb.task_comments WHERE team_id = {t}",
        "DELETE FROM aweb.task_dependencies WHERE team_id = {t}",
        "DELETE FROM aweb.task_claims WHERE team_id = {t}",
        "DELETE FROM aweb.tasks WHERE team_id = {t}",
        "DELETE FROM aweb.task_counters WHERE team_id = {t}",
        "DELETE FROM aweb.task_root_counters WHERE team_id = {t}",
        # chat content
        "DELETE FROM aweb.chat_read_receipts WHERE session_id IN "
        "(SELECT session_id FROM aweb.chat_sessions WHERE team_id = {t})",
        "DELETE FROM aweb.chat_messages WHERE session_id IN "
        "(SELECT session_id FROM aweb.chat_sessions WHERE team_id = {t})",
        "DELETE FROM aweb.chat_participants WHERE session_id IN "
        "(SELECT session_id FROM aweb.chat_sessions WHERE team_id = {t})",
        "DELETE FROM aweb.chat_sessions WHERE team_id = {t}",
        # messaging (mail) content
        "DELETE FROM aweb.conversation_participants WHERE conversation_id IN "
        "(SELECT conversation_id FROM aweb.conversations WHERE team_id = {t})",
        "DELETE FROM aweb.messages WHERE team_id = {t}",
        "DELETE FROM aweb.conversations WHERE team_id = {t}",
    ]
    for s in statements:
        psql(s.format(t=q(TEAM)))


# --------------------------------------------------------------------------- #
# 2. INSERT backlog (epics -> stories -> issues -> comments)
# --------------------------------------------------------------------------- #
# (status, assignee_type, assignee_alias)   assignee_alias None => unassigned
BACKLOG = {
    "Authentication & SSO": {
        "stories": [
            "Email + password login",
            "Single sign-on (SAML / OIDC)",
            "Session & token hardening",
        ],
        "issues": [
            ("Wire JWKS verify into the auth middleware",
             "Validate Better Auth JWTs against the published JWKS on every "
             "protected request; cache keys with a short TTL.",
             "in_progress", "agent", ADA),
            ("Add 'remember me' to the login form",
             "Persist the session for 30 days when the box is checked; default "
             "to a 24h session otherwise.",
             "done", "human", MIA),
            ("SAML metadata import for enterprise SSO",
             "Let admins paste an IdP metadata URL and auto-fill the SAML "
             "endpoints + signing cert.",
             "todo", "human", FOUNDER),
            ("Rotate signing keys without downtime",
             "Support overlapping key validity windows so in-flight tokens stay "
             "valid through a rotation.",
             "in_review", "agent", BOB),
            ("Rate-limit failed login attempts",
             "Lock an account for 15 minutes after 10 failed attempts; surface a "
             "clear message in the UI.",
             "todo", None, None),
        ],
    },
    "Realtime collaboration": {
        "stories": [
            "Live presence indicators",
            "Shared chat threads",
            "Conflict-free issue updates",
        ],
        "issues": [
            ("Show who's online in the members roster",
             "Drive presence from the heartbeat endpoint; grey out members idle "
             "for more than 2 minutes.",
             "done", "agent", ADA),
            ("Typing indicator in chat threads",
             "Broadcast a transient 'typing…' signal over the chat socket; debounce "
             "to avoid flicker.",
             "in_progress", "human", MIA),
            ("Optimistic issue status moves on the board",
             "Update the card immediately on drag, reconcile with the server PATCH, "
             "and roll back on failure.",
             "in_review", "human", FOUNDER),
            ("Reconnect chat socket with backoff",
             "Auto-reconnect dropped chat connections with exponential backoff and "
             "replay any missed messages.",
             "todo", "agent", BOB),
            ("De-dupe presence events from multiple tabs",
             "Collapse presence pings from the same user across tabs so the roster "
             "doesn't double-count.",
             "todo", None, None),
        ],
    },
    "Billing & plans": {
        "stories": [
            "Plan selection & checkout",
            "Usage metering",
            "Invoices & receipts",
        ],
        "issues": [
            ("Stripe checkout for the Team plan",
             "Hand off to Stripe Checkout for the Team tier and provision the "
             "subscription on the success webhook.",
             "in_progress", "human", FOUNDER),
            ("Meter seats against the active membership count",
             "Count active memberships nightly and report seat usage to the billing "
             "service for proration.",
             "todo", "agent", ADA),
            ("Downgrade flow with proration preview",
             "Show the prorated credit before a downgrade is confirmed so there are "
             "no billing surprises.",
             "todo", None, None),
            ("Email PDF receipts after each charge",
             "Render an invoice PDF on the invoice.paid webhook and email it to the "
             "team's billing contact.",
             "done", "human", MIA),
        ],
    },
    "Mobile app": {
        "stories": [
            "Mobile auth & onboarding",
            "Push notifications",
        ],
        "issues": [
            ("Biometric unlock on the mobile app",
             "Gate the app behind Face ID / fingerprint after the first login; fall "
             "back to the passcode.",
             "todo", "agent", BOB),
            ("Push notification for new chat mentions",
             "Send a push when a user is @-mentioned in a chat thread, deep-linking "
             "to the message.",
             "in_progress", "human", MIA),
            ("Offline cache for the work board",
             "Cache the last-seen board so it renders instantly offline and syncs on "
             "reconnect.",
             "in_review", "agent", ADA),
            ("Fix layout overflow on small screens",
             "The issue card footer overflows on devices narrower than 360px; wrap "
             "the assignee + status row.",
             "done", "human", FOUNDER),
        ],
    },
}

# Comments keyed by issue title -> list of (author_alias, body)
COMMENTS = {
    "Wire JWKS verify into the auth middleware": [
        (FOUNDER, "This is the last blocker before we can drop the legacy cert "
                  "path — let's prioritize it."),
        (ADA, "Caching the JWKS with a 5-minute TTL now; verify is wired into the "
              "middleware and passing locally. PR up shortly."),
    ],
    "Optimistic issue status moves on the board": [
        (MIA, "Saw a flash of the old status on a slow network — can we hold the "
              "optimistic state until the PATCH resolves?"),
        (ADA, "Good catch. Added a rollback so the card reverts if the server "
              "rejects the move."),
    ],
}


def seed_backlog() -> dict[str, int]:
    counts = {"epics": 0, "stories": 0, "issues": 0, "comments": 0}
    issue_id_by_title: dict[str, str] = {}

    for epic_title, spec in BACKLOG.items():
        epic_id = str(uuid.uuid4())
        psql(
            "INSERT INTO aweb.epics (epic_id, team_id, title, status) "
            f"VALUES ({q(epic_id)}, {q(TEAM)}, {q(epic_title)}, 'open')"
        )
        counts["epics"] += 1

        story_ids: list[str] = []
        for story_title in spec["stories"]:
            story_id = str(uuid.uuid4())
            psql(
                "INSERT INTO aweb.stories (story_id, epic_id, team_id, title, status) "
                f"VALUES ({q(story_id)}, {q(epic_id)}, {q(TEAM)}, {q(story_title)}, 'open')"
            )
            story_ids.append(story_id)
            counts["stories"] += 1

        for i, (title, desc, status, atype, aalias) in enumerate(spec["issues"]):
            issue_id = str(uuid.uuid4())
            # Spread issues across the epic's stories round-robin.
            story_id = story_ids[i % len(story_ids)] if story_ids else None
            psql(
                "INSERT INTO aweb.issues "
                "(issue_id, team_id, epic_id, story_id, title, description, "
                " status, assignee_type, assignee_id) VALUES ("
                f"{q(issue_id)}, {q(TEAM)}, {q(epic_id)}, "
                f"{q(story_id) if story_id else 'NULL'}, {q(title)}, {q(desc)}, "
                f"{q(status)}, {q(atype)}, {q(aalias)})"
            )
            issue_id_by_title[title] = issue_id
            counts["issues"] += 1

    for title, comments in COMMENTS.items():
        issue_id = issue_id_by_title.get(title)
        if not issue_id:
            continue
        for author, body in comments:
            psql(
                "INSERT INTO aweb.issue_comments (issue_id, team_id, author, body) "
                f"VALUES ({q(issue_id)}, {q(TEAM)}, {q(author)}, {q(body)})"
            )
            counts["comments"] += 1

    return counts


# --------------------------------------------------------------------------- #
# 3. INSERT a couple of realistic chat conversations
# --------------------------------------------------------------------------- #
# Each entry: (creator_alias, peer_alias, [(speaker_alias, body), ...])
CHATS = [
    (FOUNDER, ADA, [
        (FOUNDER, "Hi Ada, can you take a look at the JWKS verify issue? It's the "
                  "last blocker before we drop the legacy cert path."),
        (ADA, "On it — I see the JWKS verify issue. Wiring the key cache into the "
              "middleware now and I'll have a PR up shortly."),
        (FOUNDER, "Perfect. Ping me when it's ready for review."),
        (ADA, "Will do. Verify is passing locally against the published JWKS."),
    ]),
    (MIA, BOB, [
        (MIA, "Bob, the key-rotation issue is in review — anything you need from me "
              "to land it?"),
        (BOB, "Just confirmation that overlapping validity windows are acceptable. "
              "If so, I think it's good to merge."),
        (MIA, "Yes, overlapping windows are fine. Ship it."),
    ]),
]


def seed_chats() -> dict[str, int]:
    counts = {"sessions": 0, "messages": 0}
    for creator, peer, turns in CHATS:
        session_id = str(uuid.uuid4())
        psql(
            "INSERT INTO aweb.chat_sessions (session_id, team_id, created_by) "
            f"VALUES ({q(session_id)}, {q(TEAM)}, {q(creator)})"
        )
        counts["sessions"] += 1
        for alias in (creator, peer):
            psql(
                "INSERT INTO aweb.chat_participants "
                "(session_id, did, agent_id, alias) VALUES ("
                f"{q(session_id)}, {q(did_for(alias))}, "
                f"{q(agent_id_for(alias))}, {q(alias)})"
            )
        for speaker, body in turns:
            psql(
                "INSERT INTO aweb.chat_messages "
                "(session_id, from_agent_id, from_did, from_alias, body, content_mode) "
                f"VALUES ({q(session_id)}, {q(agent_id_for(speaker))}, "
                f"{q(did_for(speaker))}, {q(speaker)}, {q(body)}, "
                "'legacy_plaintext_v1')"
            )
            counts["messages"] += 1
    return counts


def main() -> None:
    print(f"Seeding demo data for team {TEAM!r} via "
          f"{PG['user']}@{PG['host']}:{PG['port']}/{PG['db']}")

    # Sanity: identities + agents must already exist (we never create them here).
    for alias in (FOUNDER, MIA, ADA, BOB):
        did_for(alias)  # raises if missing

    print("Clearing accumulated work + messaging test content (keeping "
          "identities, memberships, agents, and encryption keys)…")
    clear_content()

    backlog = seed_backlog()
    chats = seed_chats()

    print("\nDemo seed complete.")
    print(f"  epics:    {backlog['epics']}")
    print(f"  stories:  {backlog['stories']}")
    print(f"  issues:   {backlog['issues']} "
          f"(across todo / in_progress / in_review / done)")
    print(f"  comments: {backlog['comments']}")
    print(f"  chats:    {chats['sessions']} sessions, {chats['messages']} messages")
    print(f"\nThe live app at this DB is now demo-ready for team {TEAM!r}.")


if __name__ == "__main__":
    main()

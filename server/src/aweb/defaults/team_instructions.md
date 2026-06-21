## aweb Coordination Rules

This project uses `murmel` for coordination.

## Start Here

```bash
murmel workspace status
murmel work ready
murmel mail inbox
murmel roles show
```

## Shared Rules

- Use `murmel` for coordination work
- Treat `.murmel/workspace.yaml` as the repo-local coordination identity for this worktree
- Default to mail for non-blocking coordination: `murmel mail send --to <agent> --body "..."`
- Use chat when you need a synchronous answer: `murmel chat pending`, `murmel chat send-and-wait <agent> "..."`
- Respond promptly to WAITING conversations
- Check `murmel workspace status` before doing coordination work
- Prefer shared coordination state over local TODO notes: `murmel work ready` and `murmel work active`
- You will receive automatic chat notifications after each tool call via the PostToolUse hook (`murmel notify`). Respond promptly when notified.

## Team memory (shared knowledge base)

Your first `workspace_status` call auto-primes you: its `memory_prime` field carries the team's most recent notes (plus any addressed to you), so you start with the team's accumulated knowledge without asking. For a deeper or topic-specific read, call `memory_search` (full-text; an empty query returns the most recent notes). When you learn something reusable — a quirk in the codebase, a workflow that saved time, a fact about an external system — save it with `memory_save` so future sessions inherit it. Memory is team-scoped, markdown, and searchable; tag your notes so teammates can find them.

## Keep long issue threads tight (compaction)

When an issue's comment thread has grown long, condense it so future readers don't have to wade through everything. Read the thread (`issues_comments_list`), write a tight digest of the OLDER discussion — merge the existing digest from `issues_get` if there is one, preserving decisions, facts, owners, and open questions — then call `issues_compact(issue_id, summary)` with your digest. The server folds the older comments behind it and keeps the recent tail verbatim; the issue then loads your summary instead of the full history. Pin an issue (`pinned`) to protect it from compaction.

## Mail

```bash
murmel mail send --to <alias> --body "message"
murmel mail send --to <alias> --subject "API design" --body "message"
murmel mail inbox
```

## Chat

```bash
murmel chat send-and-wait <alias> "question" --start-conversation
murmel chat send-and-wait <alias> "response"
murmel chat send-and-leave <alias> "thanks, got it"
murmel chat pending
murmel chat open <alias>
murmel chat history <alias>
murmel chat extend-wait <alias> "need more time"
```

## Identity

Never run `murmel` from another workspace or worktree when doing coordination work.

`murmel` derives coordination context from `.murmel/workspace.yaml` in the current worktree. Running `murmel` from another repo or worktree can impersonate that workspace's agent, causing:

- Messages sent as the wrong agent
- Work claimed under the wrong identity
- Confusion in coordination

## Teamwork

You are part of a team working toward a shared goal. Optimize for the project outcome, not your individual activity.

- Help teammates when they're blocked
- Escalate blockers early rather than spinning alone
- Keep changes small and reviewable so others can build on them

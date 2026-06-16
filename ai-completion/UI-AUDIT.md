# aweb Web App — UI/UX Audit

Senior product-design audit of the running app at `http://localhost:3030`, dark
theme, Linear-style. Logged in as `founder@local.test`. AUDIT-ONLY — no code was
changed. Screenshots saved to disk during the session (login, console, work
board, issue detail, members, chat list, chat thread).

Findings are prioritized: **blockers** first, then **major**, then **minor**.
Each item gives the screen, a concrete description, severity, and a specific
recommended fix.

---

## Resolution status (2026-06-16, branch `feature/simple-auth-ui`)

A UI/UX polish pass implemented the cross-cutting refactor the audit
recommended plus the specific items. Shared primitives added under
`ui/src/components/ui/`:

- **`Avatar`** (`avatar.tsx` + `ui.module.css`) — one initials rule (strips
  parenthetical tokens, takes the first two alphanumeric letters; "Ada (agent)"
  → "AD"), one colour system, optional presence dot. Used on the board, issue
  detail, members, chat list, and chat thread.
- **`KindBadge`** (`badge.tsx`) — one human/agent tag fed from a single label
  map → "Human" / "AI agent" everywhere (no more "AGENT" vs "AI AGENT").
- **`MessageBubble`** (`message-bubble.tsx`) — one bubble shared by the chat
  thread and (via `stripAuthorPrefix`) the issue conversation; both self and
  other use the same structure/radius.
- Global `:focus-visible` ring + login `or-divider` in `globals.css`.

**Fixed:** B1, B2, B3, M1, M2, M3, M4, M5, M6, M7, M8, N1, N3, N5, N6, N7, N8,
N9.
**Deferred:** N2 (field labels — divider + centering done), N4 (console
content), N10 (seed-data, not code — see note below).

Gates: `npm run typecheck` clean · `npm run build` succeeds · `npx playwright
test` 14/14 (selectors re-pointed to the unified badge text / stripped bodies
without weakening assertions).

---

## BLOCKERS (demo-breaking inconsistencies / wrong data)

### B1 — Chat: incoming and outgoing messages use two completely different layouts  ✅ FIXED
**Screen:** `/dashboard/chat` (open conversation, e.g. "Ada (agent)")
**Problem:** Outgoing ("You") messages render as small, right-aligned, rounded
**pill bubbles** with a blue border/tint and a "You · <time>" label above-right.
Incoming ("Ada (agent)") messages render as a **wide, left-aligned grey
rectangle** (~70% pane width) with a separate bold author + AGENT tag + timestamp
header line above it. The two message types don't share a bubble system at all —
the incoming block reads like a disabled text input, not a chat message. This is
the single most "not-demo-ready" screen.
**Fix:** Unify on one bubble component. Both directions: avatar + author + time in
a consistent position, same corner radius, content-hugging width with a sensible
`max-width` (~60–70%). Outgoing right-aligned/accent-tinted, incoming
left-aligned/neutral — but **same internal structure and radius** for both.

### B2 — Members: "0 online" counter is wrong while a member is shown active  ✅ FIXED
**Screen:** `/dashboard/members`
**Problem:** Header summary badges read "4 total · **0 online**", yet the Founder
row shows a green status dot and a green "active" badge. The online counter
contradicts the per-row status — it appears to always report 0.
**Fix:** Compute the "online" count from the same source as the row status badges
(count members whose status is active/online). Founder should make it read "1
online" here.

### B3 — Avatar initials are generated incorrectly (parenthesis used as an initial)  ✅ FIXED
**Screen:** `/dashboard/work` board cards (and anywhere an agent named "Ada
(agent)" appears)
**Problem:** The avatar for "Ada (agent)" shows **"A("** — the initials algorithm
splits on spaces and takes the first char of the first two tokens, so token 2 is
"(agent)" → "(". Reads as a rendering bug.
**Fix:** Strip parenthetical suffixes / non-alphanumeric tokens before deriving
initials, or take the first two **letters** of the display name. "Ada (agent)" →
"AD" or "AA". Apply the same helper everywhere avatars render.

---

## MAJOR (clearly unpolished, inconsistent across screens)

### M1 — Avatar initials differ between board and issue detail  ✅ FIXED
**Screen:** `/dashboard/work` cards vs `/dashboard/work/issues/<id>`
**Problem:** Board avatars use **two letters** ("MI" for Mia, "AA"/"A(" for Ada);
the issue-detail conversation avatars use a **single letter** ("M", "A"). Same
people, two avatar systems.
**Fix:** Pick one initials rule (recommend two-letter) and share a single Avatar
component across board, detail, members, and chat.

### M2 — Status value leaks the raw enum ("todo") in the issue detail sidebar  ✅ FIXED
**Screen:** `/dashboard/work/issues/<id>` → right sidebar STATUS
**Problem:** The header pill says "To do" (humanized), but the sidebar STATUS
field shows **"todo"** (raw lowercase enum). Two representations of the same
field on the same page.
**Fix:** Run the status through the same humanize/label map used by the pill so
the sidebar shows "To do".

### M3 — Agent tag label is inconsistent ("AI AGENT" vs "AGENT")  ✅ FIXED
**Screen:** Board cards & Members say **"AI AGENT"**; issue-detail conversation &
chat thread say **"AGENT"**.
**Fix:** Standardize the tag text (recommend "AI AGENT") and use one Tag/Badge
component with one source string.

### M4 — Empty kanban column ("In Review") doesn't match sibling column height  ✅ FIXED
**Screen:** `/dashboard/work` board
**Problem:** TO DO / IN PROGRESS / DONE columns stretch tall with their cards,
but the empty **IN REVIEW** column renders a short fixed-height box (~110px) with
"No issues", leaving it floating with a hard bottom edge far above the others.
The board looks broken/unbalanced.
**Fix:** Give all columns equal height (e.g. `align-items: stretch` /
`min-height: 100%` on the column track, or let the empty-state fill the column).
The "No issues" message should be vertically centered in a full-height column.

### M5 — Every card carries a redundant status `<select>` duplicating its column  ✅ FIXED
**Screen:** `/dashboard/work` board (confirmed 47 comboboxes, one per card)
**Problem:** A card sitting in the TO DO column also shows a "To do" dropdown; in
DONE it shows "Done". In a kanban board the column *is* the status, so each card
repeats information and adds visual noise on every row.
**Fix:** Either remove the per-card status select on the board (rely on
drag-between-columns / the detail page to change status), or shrink it to a subtle
icon-only control. At minimum it shouldn't display the column's own status as a
full bordered select.

### M6 — Comment/message bodies repeat the author name as a text prefix  ✅ FIXED
**Screen:** issue detail conversation ("Ada (agent): I have started on this.",
"Mia (human): thanks Ada…") and chat previews ("Ada (agent): CHATREV-…").
**Problem:** The author is already rendered in the bold header / "You" label, so
the inline "Name (role):" prefix in the body is duplicated and looks like unparsed
data.
**Fix:** If the prefix is real message content, strip the leading
"`<author>:`" when it matches the rendered sender; otherwise stop persisting the
prefix. Bodies should be just the message text.

### M7 — No visible focus state on form inputs  ✅ FIXED
**Screen:** `/dashboard/work` "New issue title…" input (and likely all inputs)
**Problem:** Clicking the input produces no focus ring or border-color change —
focused and unfocused states are visually identical. Hurts usability and
accessibility (keyboard users can't see focus).
**Fix:** Add a consistent focus style (e.g. accent-colored ring/border on
`:focus-visible`) to all inputs, selects, and the chat composer.

### M8 — Chat "Send" button reads as disabled at rest  ✅ FIXED
**Screen:** `/dashboard/chat` composer
**Problem:** The "Send" button uses a muted/desaturated blue that looks like a
disabled state even when sending is available, undercutting the primary action.
**Fix:** Use the full primary-blue for the enabled state (match "Add issue" /
"Sign in"); reserve the muted style strictly for the actually-disabled (empty
input) state.

---

## MINOR (polish; small spacing / consistency nits)

### N1 — Login: no divider between SSO buttons and the email/password form  ✅ FIXED
**Screen:** `/login`
**Problem:** "Continue with GitHub/Google" sit directly above the email/password
fields with only a gap — no "or" divider — so the two auth paths blur together.
The gap between the Google button and the email field is also larger than the
gap between the two inputs, making the grouping ambiguous.
**Fix:** Add an "— or —" divider between SSO and credentials, and normalize the
vertical rhythm (equal gaps within the credentials group).

### N2 — Login form is not vertically centered  ⏸️ DEFERRED
**Screen:** `/login`
**Problem:** The card sits at roughly the vertical middle but slightly high; lots
of dead space below. Inputs/buttons lack labels (placeholder-only).
**Fix:** True vertical centering of the card; consider visible field labels for
email/password instead of placeholder-only.

### N3 — Sidebar "Sign out" button: avatar and label aren't visually related  ✅ FIXED
**Screen:** all dashboard screens, bottom of sidebar
**Problem:** The "N" avatar is left-aligned inside the button while "Sign out" is
center-aligned, so the avatar floats apart from the label. Also the avatar shows
"N" while the identity line above reads "Founder" (initial mismatch — should be
"F").
**Fix:** Left-align the label next to the avatar (or drop the avatar from the
button and keep it only in the identity row). Fix the avatar initial to match the
display name.

### N4 — Console & Members empty/low-content states waste the whole viewport  ⏸️ DEFERRED
**Screen:** `/dashboard` (Team console), `/dashboard/members` below the roster
**Problem:** The Console is a single small card ("Active team: default:local (1
total)…") floating in a near-empty full-height page; Members has a large empty
area below 4 rows. Feels unfinished.
**Fix:** Add useful console content (recent activity, work summary counts,
quick links) or constrain/centre the empty state so the page doesn't read as
"missing content".

### N5 — Work toolbar is split across three disconnected rows  ✅ FIXED
**Screen:** `/dashboard/work` top controls
**Problem:** Row 1 = Board/List toggle + status filter + assignee-type + assignee
id + Refresh (far right); row 2 = an orphaned "+ Epic / Story" button alone on the
left; row 3 = New-issue title + No epic + No story + Add issue. The "+ Epic /
Story" control floating on its own row looks stranded.
**Fix:** Group create-controls together (e.g. put "+ Epic / Story" inline with the
New-issue row, or move it next to "Add issue"); align the three rows to one left
edge and a consistent control height.

### N6 — Two competing primary-blue elements on the Work board  ✅ FIXED
**Screen:** `/dashboard/work`
**Problem:** The "Board" view toggle and the "Add issue" button are both solid
primary blue, so the eye can't tell which is the page's main action.
**Fix:** Make the segmented Board/List toggle a neutral/selected style (subtle
fill) and reserve solid blue for the single primary action ("Add issue").

### N7 — Chat conversation list rows have no avatars  ✅ FIXED
**Screen:** `/dashboard/chat` conversation list
**Problem:** List rows are text-only (name + time + preview + unread badge) while
every other surface (Members, Work, issue detail) shows avatars. Inconsistent.
**Fix:** Add the same Avatar component to conversation rows for visual
consistency and faster scanning.

### N8 — Issue-detail "Assign" button is an oversized full-width primary  ✅ FIXED
**Screen:** `/dashboard/work/issues/<id>` right sidebar
**Problem:** The full-width solid-blue "Assign" button visually dominates the
sidebar for what is a secondary, conditional action.
**Fix:** Make "Assign" a secondary/outline button, or fold assignment into the
select (assign-on-change) and drop the standalone button.

### N9 — Members rows: humans lack a role chip, agents have one  ✅ FIXED
**Screen:** `/dashboard/members`
**Problem:** Agent rows show a role chip ("engineer", "reviewer"); human rows show
none, so the two sections look structurally uneven.
**Fix:** Show a role/role-placeholder chip for humans too (e.g. "owner"/"member"),
or remove role chips from the roster for symmetry.

### N10 — Raw test/demo IDs and timestamps everywhere reduce demo polish  ⏸️ DEFERRED
**Screen:** Work cards ("E2E auto issue 1781556802237"), chat
("Demo to Ada 1781568315346", "CHATREV-178157804113313")
**Problem:** Long machine IDs as titles/messages look like seed/test noise.
**Fix:** (Data, not UI) seed the demo with human-readable titles/messages before
showing the app.

---

## Cross-cutting recommendations

- **One Avatar component, one initials rule** (fixes B3, M1, N3, N7).
- **One Badge/Tag component** for status pills and human/agent tags, fed from a
  single humanize map (fixes M2, M3, B2-adjacent).
- **One Message/bubble component** shared by chat thread and issue conversation
  (fixes B1, M6).
- **One button hierarchy**: a single solid-primary per view; everything else
  secondary/neutral (fixes M8, N6, N8).
- **Global focus-visible style** on all interactive controls (fixes M7).
- **Consistent empty states**: full-height, centered, with a helpful message and
  a primary action (fixes M4, N4).

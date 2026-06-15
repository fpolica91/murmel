import { test, expect, type Page, request as pwRequest } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Full humans-as-participants E2E. Drives the rendered UI as real humans
 * (founder + mia) and proves every collaboration surface treats humans as
 * first-class participants alongside agents:
 *
 *   CHAT    human<->agent, human<->human (agent replies seeded over the API,
 *           since agents can't drive a browser; the human side is real UI).
 *   TASKS   create issue, assign to a HUMAN and to an AGENT, move status across
 *           columns, confirm persistence.
 *   COMMENTS a human comments via the UI, an agent comments via the API; both
 *           render with the AUTHORITATIVE human/agent badge.
 *   MEMBERS  roster shows both humans (by name) and both agents with type +
 *           presence.
 *
 * The authoritative human-vs-agent signal everywhere is the server-stamped
 * `kind` / `from_kind` / `author_kind` / `assignee_kind` — the UI never guesses.
 */

const UI = process.env.E2E_UI_URL ?? "http://localhost:3030";
const AWEB = process.env.E2E_AWEB_URL ?? "http://localhost:8088";
const TEAM = "default:local";
const PW = "Test1234!pass";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

/** Sign in via Better Auth and mint a server JWT for API-side seeding. */
async function mintJwt(email: string): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: UI });
  await ctx.post("/api/auth/sign-in/email", {
    data: { email, password: PW },
  });
  const res = await ctx.get("/api/auth/token", {
    headers: { accept: "application/json" },
  });
  const body = (await res.json()) as { token: string };
  await ctx.dispose();
  return body.token;
}

async function apiCtx(jwt: string) {
  return pwRequest.newContext({
    baseURL: AWEB,
    extraHTTPHeaders: {
      Authorization: `Bearer ${jwt}`,
      "X-AWEB-Team-Id": TEAM,
      "Content-Type": "application/json",
    },
  });
}

/** Log into the UI as the given human and land on the dashboard. */
async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(email);
  await page.getByPlaceholder("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

test.describe("aweb — humans as first-class participants (full E2E)", () => {
  test("CHAT: human<->human renders with You + Human badge", async ({
    page,
  }) => {
    // Run-unique message bodies so reruns never collide in a reused session.
    const tag = Date.now().toString().slice(-6);
    const open = `Hi Founder, Mia here (human-to-human) #${tag}.`;
    const reply = `Hello Mia, Founder replying (human) #${tag}.`;

    await login(page, "mia@local.test");
    await page.goto("/dashboard/chat");

    // Start a NEW chat with the other human (Founder). The chat picker is the
    // <select> whose options carry the "· human/agent" labels (NOT the topbar
    // team-select); option values are the participant alias.
    await page.getByRole("button", { name: "+ New" }).click();
    const picker = page.locator("select", { hasText: "· human" });
    await expect(picker).toBeVisible();
    await picker.selectOption("Founder");
    await page.getByPlaceholder("Opening message…").fill(open);
    await page.getByRole("button", { name: "Start chat" }).click();

    // Mia's own message renders under "You".
    await expect(page.getByText(open)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("You").first()).toBeVisible();

    // Founder (a human) replies over the API into the session Mia just opened;
    // the reply must render with the authoritative "Human" badge.
    const founderJwt = await mintJwt("founder@local.test");
    const fctx = await apiCtx(founderJwt);
    const sessRes = await fctx.get("/v1/chat/sessions");
    const sessions = (await sessRes.json()).sessions as Array<{
      session_id: string;
      participants: string[];
      last_activity: string;
    }>;
    const sess = sessions
      .filter((s) => s.participants.includes("Mia"))
      .sort((a, b) => b.last_activity.localeCompare(a.last_activity))[0];
    expect(sess, "founder should see Mia's session").toBeTruthy();
    await fctx.post(`/v1/chat/sessions/${sess!.session_id}/messages`, {
      data: { body: reply },
    });
    await fctx.dispose();

    // The UI polls every 4s; wait for Founder's reply to surface with a Human tag.
    await expect(page.getByText(reply)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Human", { exact: true }).first()).toBeVisible();

    await page.screenshot({
      path: `${ART}/20-chat-human-human.png`,
      fullPage: true,
    });
  });

  test("CHAT: human<->agent renders with Agent badge", async ({ page }) => {
    // Run-unique message bodies so reruns never collide in a reused session.
    const tag = Date.now().toString().slice(-6);
    const open = `Hi Ada, Mia here — can you take this issue? #${tag}`;
    const reply = `On it, Mia — Ada (agent) taking the issue. #${tag}`;

    await login(page, "mia@local.test");
    await page.goto("/dashboard/chat");

    await page.getByRole("button", { name: "+ New" }).click();
    // The chat picker is the <select> whose options carry the "· agent"
    // labels (NOT the topbar team-select). Option values are the participant
    // alias; select the agent "Ada (agent)".
    const picker = page.locator("select", { hasText: "· agent" });
    await expect(picker).toBeVisible();
    await picker.selectOption("Ada (agent)");
    await page.getByPlaceholder("Opening message…").fill(open);
    await page.getByRole("button", { name: "Start chat" }).click();

    await expect(page.getByText(open)).toBeVisible({ timeout: 15_000 });

    // Ada (agent) replies over the API; the reply renders with an "Agent" badge.
    const adaJwt = await mintJwt("ada@local.test");
    const actx = await apiCtx(adaJwt);
    const sessRes = await actx.get("/v1/chat/sessions");
    const sessions = (await sessRes.json()).sessions as Array<{
      session_id: string;
      participants: string[];
      last_activity: string;
    }>;
    const sess = sessions
      .filter((s) => s.participants.includes("Mia"))
      .sort((a, b) => b.last_activity.localeCompare(a.last_activity))[0];
    expect(sess, "Ada should see Mia's session").toBeTruthy();
    await actx.post(`/v1/chat/sessions/${sess!.session_id}/messages`, {
      data: { body: reply },
    });
    await actx.dispose();

    await expect(page.getByText(reply)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Agent", { exact: true }).first()).toBeVisible();

    await page.screenshot({
      path: `${ART}/21-chat-human-agent.png`,
      fullPage: true,
    });
  });

  test("TASKS: create, assign human + agent, move status, persist", async ({
    page,
  }) => {
    // Seed two issues over the API as the founder (admin), so the board has a
    // human-assigned and an agent-assigned card to render. Titles are
    // run-scoped (unique) so the board never has duplicate-titled cards from a
    // prior run, keeping card selection deterministic.
    const tag = Date.now().toString().slice(-6);
    const humanTitle = `E2E human-assigned #${tag}`;
    const agentTitle = `E2E agent-assigned #${tag}`;
    const founderJwt = await mintJwt("founder@local.test");
    const fctx = await apiCtx(founderJwt);

    const i1 = await (
      await fctx.post("/v1/issues", {
        data: { title: humanTitle, description: "human assignee card" },
      })
    ).json();
    await fctx.patch(`/v1/issues/${i1.issue_id}`, {
      data: { assignee_type: "human", assignee_id: "Mia" },
    });

    const i2 = await (
      await fctx.post("/v1/issues", {
        data: { title: agentTitle, description: "agent assignee card" },
      })
    ).json();
    await fctx.patch(`/v1/issues/${i2.issue_id}`, {
      data: { assignee_type: "agent", assignee_id: "Ada (agent)" },
    });
    await fctx.dispose();

    await login(page, "founder@local.test");
    await page.goto("/dashboard/work");
    await expect(page.getByRole("heading", { name: "Work" })).toBeVisible({
      timeout: 15_000,
    });

    // Both cards render on the board.
    await expect(page.getByText(humanTitle)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(agentTitle)).toBeVisible();
    // The human-assigned card surfaces the human's alias.
    await expect(page.getByText("Mia").first()).toBeVisible();

    // Move the human-assigned issue across columns via its status select.
    const humanCard = page
      .locator(`text=${humanTitle}`)
      .locator("xpath=ancestor::div[contains(@class,'card')][1]");
    await humanCard.getByLabel("Change status").selectOption("in_progress");

    // Confirm persistence: reload and verify the issue moved (server-side PATCH).
    await page.reload();
    await expect(page.getByRole("heading", { name: "Work" })).toBeVisible({
      timeout: 15_000,
    });
    // Verify via API the status persisted to in_progress.
    const verifyJwt = await mintJwt("founder@local.test");
    const vctx = await apiCtx(verifyJwt);
    const got = await (await vctx.get(`/v1/issues/${i1.issue_id}`)).json();
    await vctx.dispose();
    expect(got.status).toBe("in_progress");
    expect(got.assignee_kind).toBe("human");
    expect(got.assignee_display_name).toBe("Mia");

    await page.screenshot({ path: `${ART}/22-board.png`, fullPage: true });
  });

  test("COMMENTS: human + agent comments badge correctly", async ({ page }) => {
    // Create an issue to comment on.
    const founderJwt = await mintJwt("founder@local.test");
    const fctx = await apiCtx(founderJwt);
    const issue = await (
      await fctx.post("/v1/issues", {
        data: {
          title: "E2E thread: human + agent comments",
          description: "comment attribution",
        },
      })
    ).json();
    const issueId = issue.issue_id as string;

    // Agent (Ada) comments over the API.
    const adaJwt = await mintJwt("ada@local.test");
    const actx = await apiCtx(adaJwt);
    await actx.post(`/v1/issues/${issueId}/comments`, {
      data: { body: "Ada (agent): I have started on this." },
    });
    await actx.dispose();
    await fctx.dispose();

    // Human (Mia) comments via the real UI.
    await login(page, "mia@local.test");
    await page.goto(`/dashboard/work/issues/${issueId}`);
    await expect(
      page.getByRole("heading", { name: "E2E thread: human + agent comments" }),
    ).toBeVisible({ timeout: 15_000 });

    // Agent's seeded comment shows with an "agent" badge.
    await expect(
      page.getByText("Ada (agent): I have started on this."),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("agent", { exact: true }).first()).toBeVisible();

    // Mia posts a comment through the UI.
    await page
      .getByLabel("New comment")
      .fill("Mia (human): thanks Ada, reviewing now.");
    await page.getByRole("button", { name: "Comment" }).click();
    await expect(
      page.getByText("Mia (human): thanks Ada, reviewing now."),
    ).toBeVisible({ timeout: 15_000 });
    // And it badges as human (authoritative author_kind).
    await expect(page.getByText("human", { exact: true }).first()).toBeVisible();

    await page.screenshot({
      path: `${ART}/23-issue-thread.png`,
      fullPage: true,
    });
  });

  test("MEMBERS: roster shows both humans + both agents with type", async ({
    page,
  }) => {
    await login(page, "mia@local.test"); // non-admin human
    await page.goto("/dashboard/members");

    // Humans section: both Founder and Mia by display name, with a Human tag.
    await expect(page.getByText("Humans").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Founder").first()).toBeVisible();
    await expect(page.getByText("Mia").first()).toBeVisible();

    // Agents section: both Ada and Bob present. The display name is the agent's
    // human_name (e.g. "Ada AI") when set, else the alias ("Ada (agent)"); the
    // provisioning upsert refreshes human_name from the account name claim, so
    // assert on the stable alias which always identifies the agent.
    await expect(page.getByText("AI agents").first()).toBeVisible();
    await expect(page.getByText(/Ada/).first()).toBeVisible();
    await expect(page.getByText(/Bob/).first()).toBeVisible();

    await expect(page.getByText("Human", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("AI agent", { exact: true }).first(),
    ).toBeVisible();

    await page.screenshot({ path: `${ART}/24-members.png`, fullPage: true });
  });
});

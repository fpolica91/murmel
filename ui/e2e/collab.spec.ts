import {
  test,
  expect,
  type Page,
  request as pwRequest,
} from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Live collaboration E2E. Drives the rendered UI as the human founder and
 * proves the three collaboration surfaces are populated by a real
 * human<->agent conversation.
 *
 * SELF-SEEDING: this spec no longer depends on pre-existing demo/harness rows.
 * Each test creates exactly the fixture it asserts on over the aweb REST API
 * (founder mints a Better Auth JWT; Ada replies under her own JWT), so the
 * suite is hermetic and survives a `seed_demo.py` refresh that clears content:
 *
 *   - Chat feed (/dashboard/chat): the founder<->Ada session is created here
 *     with both senders' messages, then read back through the UI.
 *   - Members (/dashboard/members): founder (human) and Ada (AI agent) both
 *     appear and are distinguishable (these are provisioned by global-setup).
 *   - Work board (/dashboard/work): a "Wire JWKS verify" issue is created over
 *     the API and asserted on the board.
 */
const UI = process.env.E2E_UI_URL ?? "http://localhost:3030";
const AWEB = process.env.E2E_AWEB_URL ?? "http://localhost:8088";
const TEAM = "default:local";
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

/** Sign in via Better Auth and mint a server JWT for API-side seeding. */
async function mintJwt(email: string): Promise<string> {
  const ctx = await pwRequest.newContext({ baseURL: UI });
  await ctx.post("/api/auth/sign-in/email", {
    data: { email, password: PASSWORD },
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

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(EMAIL);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

test.describe("aweb collaboration — live human<->agent E2E", () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test("chat feed shows a self-seeded founder<->Ada conversation", async ({
    page,
  }) => {
    // Self-seed the conversation over the API: founder opens a chat with Ada
    // and sends the opening message; Ada replies under her own JWT. Bodies are
    // run-unique (tagged) so they never collide with the demo seed's similar
    // founder<->Ada lines or a prior run — this spec relies only on the fixture
    // it creates here.
    const tag = Date.now().toString().slice(-6);
    const open = `Hi Ada, can you take a look at the JWKS verify issue #${tag}`;
    const reply = `On it — I see the JWKS verify issue #${tag}`;

    const founderJwt = await mintJwt(EMAIL);
    const fctx = await apiCtx(founderJwt);
    const startRes = await fctx.post("/v1/chat/sessions", {
      data: { to_aliases: ["Ada (agent)"], message: open },
    });
    const started = (await startRes.json()) as { session_id: string };
    expect(started.session_id, "founder should open a session with Ada").toBeTruthy();
    await fctx.dispose();

    // Ada replies into that session under her own identity (authoritative agent).
    const adaJwt = await mintJwt("ada@local.test");
    const actx = await apiCtx(adaJwt);
    await actx.post(`/v1/chat/sessions/${started.session_id}/messages`, {
      data: { body: reply },
    });
    await actx.dispose();

    await page.goto("/dashboard/chat");

    // The conversation list must surface the seeded session; click into it.
    // The peer label for the founder's view of the session is "Ada (agent)".
    const adaConversation = page.getByText("Ada (agent)").first();
    await expect(adaConversation).toBeVisible({ timeout: 15_000 });
    await adaConversation.click();

    // Both parties' messages are present in the thread.
    await expect(page.getByText(open).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(reply).first()).toBeVisible();
    // Both senders visibly identified in the thread.
    await expect(page.getByText("You").first()).toBeVisible();
    await expect(page.getByText("Ada (agent)").first()).toBeVisible();

    await page.screenshot({ path: `${ART}/10-chat.png`, fullPage: true });
  });

  test("members roster shows founder (human) and Ada (agent), distinguishable", async ({
    page,
  }) => {
    await page.goto("/dashboard/members");

    // Ada is an AI agent — shown in the agents section with an "AI agent" tag.
    await expect(page.getByText("Ada (agent)").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("AI agent").first()).toBeVisible();

    // The founder (and other humans) are shown as human memberships — the
    // founder is admin, so the human roster (admin-only) loads. The "Human"
    // tag distinguishes them from agents.
    await expect(page.getByText("Humans").first()).toBeVisible();
    await expect(page.getByText("Human", { exact: true }).first()).toBeVisible();

    await page.screenshot({ path: `${ART}/11-members.png`, fullPage: true });
  });

  // NOTE: issue-thread comments + assignee attribution (human vs agent) are
  // covered end-to-end and self-seeded by complete.spec.ts (COMMENTS / TASKS),
  // so the older env-gated variant that needed a harness-provided E2E_ISSUE_ID
  // was removed to keep the suite free of conditional skips.

  test("work board renders a self-seeded JWKS verify issue", async ({
    page,
  }) => {
    // Self-seed the issue over the API so the board assertion does not depend on
    // the demo seed or any prior run.
    const title = "Wire JWKS verify into the auth middleware";
    const founderJwt = await mintJwt(EMAIL);
    const fctx = await apiCtx(founderJwt);
    await fctx.post("/v1/issues", {
      data: {
        title,
        description:
          "Validate Better Auth JWTs against the published JWKS on every protected request.",
      },
    });
    await fctx.dispose();

    await page.goto("/dashboard/work");
    await expect(page.getByRole("heading", { name: "Work" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Wire JWKS verify").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: `${ART}/13-board.png`, fullPage: true });
  });
});

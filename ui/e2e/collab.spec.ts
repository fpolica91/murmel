import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Live collaboration E2E. Drives the rendered UI as the human founder and
 * proves the three collaboration surfaces are populated by a real
 * human<->agent conversation seeded over the aweb API:
 *
 *   - Chat feed (/dashboard/chat): the founder<->Ada session is visible with
 *     both senders' messages.
 *   - Members (/dashboard/members): founder (human) and Ada (AI agent) both
 *     appear and are distinguishable.
 *   - Issue thread (/dashboard/work/issues/<id>): the seeded comment thread is
 *     shown and the assignee is Ada.
 *   - Work board (/dashboard/work): the board renders the seeded issue.
 *
 * Login reuses the placeholder/role selectors from login.spec.ts. The seed is
 * performed out-of-band by the harness (chat session + issue comments +
 * assignment) before this spec runs, so the assertions read real data the
 * server returns under the founder's Better Auth JWT.
 */
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

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

  test("chat feed shows the seeded founder<->Ada conversation", async ({
    page,
  }) => {
    await page.goto("/dashboard/chat");

    // The conversation list must surface the seeded session; click into it.
    // The peer label for the founder's view of the session is "Ada (agent)".
    const adaConversation = page.getByText("Ada (agent)").first();
    await expect(adaConversation).toBeVisible({ timeout: 15_000 });
    await adaConversation.click();

    // Both parties' messages are present in the thread. Founder's own messages
    // render as "You"; Ada's render under her alias + an "Agent" tag.
    await expect(
      page.getByText("Hi Ada, can you take a look at the JWKS verify issue"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText("On it — I see the JWKS verify issue"),
    ).toBeVisible();
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

  test("work board renders the seeded issue", async ({ page }) => {
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

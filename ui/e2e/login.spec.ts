import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * The whole point of the auth pivot, exercised through a real browser:
 *   - protected routes bounce to /login when unauthenticated
 *   - bad credentials are rejected
 *   - a correct login lands on the team dashboard and the SAME session lets a
 *     human (and, over the API/MCP, an agent) create work on the board.
 *
 * No certificates anywhere — the Better Auth JWT issued to the browser session
 * is what authorizes the aweb server calls the work board makes underneath.
 */
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

test.describe("aweb token-only auth — automated browser E2E", () => {
  test("unauthenticated /dashboard redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Sign in to aweb" }),
    ).toBeVisible();
  });

  test("wrong password is rejected, stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder("Password").fill("WRONGpass123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/invalid|failed|incorrect/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await page.screenshot({ path: `${ART}/01-wrong-password.png` });
  });

  test("login → dashboard → create an issue on the work board", async ({
    page,
  }) => {
    // --- log in through the rendered UI ---
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.screenshot({ path: `${ART}/02-login-filled.png` });
    await page.getByRole("button", { name: "Sign in" }).click();

    // --- team dashboard: the real Console home (not the old placeholder) ---
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Console", exact: true }),
    ).toBeVisible();
    // The Console renders real, team-scoped overview content: the work snapshot
    // and team panels are present (sourced from /v1/issues + /v1/participants).
    await expect(
      page.getByRole("heading", { name: "Work snapshot" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Team", exact: true }),
    ).toBeVisible();
    // Team scope is live: the switcher is set to our team and the Console echoes
    // it in the header subtitle (a visible <strong>, distinct from the hidden
    // <option> inside the switcher).
    await expect(page.getByRole("combobox")).toHaveValue("default:local");
    await expect(
      page.getByText("At-a-glance overview for"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.screenshot({ path: `${ART}/03-dashboard.png` });

    // --- create an issue through the board UI (drives aweb REST under the JWT) ---
    await page.goto("/dashboard/work");
    await expect(page.getByRole("heading", { name: "Work" })).toBeVisible();
    const title = `E2E auto issue ${Date.now()}`;
    await page.getByLabel("New issue title").fill(title);
    await page.getByRole("button", { name: "Add issue" }).click();

    // the new issue must render back on the board (round-trips through the server)
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${ART}/04-work-board-issue.png`, fullPage: true });
  });

  test("Console home shows real team overview + work snapshot", async ({
    page,
  }) => {
    // Log in and land on the Console (the dashboard home).
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });

    // It is the REAL Console, not the old "Team console" placeholder.
    await expect(
      page.getByRole("heading", { name: "Console", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Team console" }),
    ).toHaveCount(0);

    // Team overview: a "Teammates" stat sourced from /v1/participants, and the
    // "Online now" presence stat — both are real, team-scoped counts.
    await expect(page.getByText("Teammates")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Online now")).toBeVisible();

    // Work snapshot: the four real status columns from /v1/issues are present,
    // each labelled, with the most-recent issues listed below.
    await expect(
      page.getByRole("heading", { name: "Work snapshot" }),
    ).toBeVisible();
    for (const status of ["To do", "In progress", "In review", "Done"]) {
      await expect(page.getByText(status, { exact: true }).first()).toBeVisible();
    }

    // Quick actions link out to the other team surfaces (exact names avoid the
    // panel "Open chat →" header link).
    await expect(
      page.getByRole("link", { name: "View work board", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open chat", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Manage members", exact: true }),
    ).toBeVisible();

    await page.screenshot({
      path: `${ART}/05-console-home.png`,
      fullPage: true,
    });
  });
});

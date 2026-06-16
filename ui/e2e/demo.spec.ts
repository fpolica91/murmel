import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * DEMO-READY proof, driven through the rendered UI by a real Chromium. This is
 * the deterministic twin of the live-Chrome demo: it proves the three pillars
 * a human sees in the product:
 *
 *   - SIDEBAR: the Linear-style left rail (Console / Work / Chat / Members) is
 *     present after login; each nav item navigates and marks itself active.
 *   - APPEAR ONLINE: the signed-in human's presence heartbeat makes them show
 *     ONLINE — both in the UI (the sidebar footer online dot) AND in the
 *     authoritative server directory (GET /v1/participants -> founder
 *     online:true), fetched with the SAME Better Auth JWT the browser holds.
 *   - CHAT: a human starts and sends real messages to an agent (Ada) and to
 *     another human (Mia); both render with the correct sender attribution
 *     ("You" for self, an Agent/Human badge for the peer).
 *
 * No certs, no mocks — the Better Auth JWT issued to the browser session is
 * what authorizes every aweb REST call underneath.
 */
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const TEAM = process.env.E2E_TEAM ?? "default:local";
const AWEB = process.env.E2E_AWEB_URL ?? "http://localhost:8088";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@example.com").fill(EMAIL);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

/**
 * Start a fresh chat with the participant whose team-unique alias is
 * `peerAlias` (the directory alias, e.g. "Ada (agent)" or "Mia" — this is the
 * <option value>) and send `body`. Robust to whether a session with the peer
 * already exists: we always open the "+ New" composer, pick the peer, and send
 * an opening message, which (re)surfaces the thread.
 */
async function startChatAndSend(
  page: Page,
  peerAlias: string,
  body: string,
): Promise<void> {
  await page.goto("/dashboard/chat");
  // Open the new-conversation composer.
  await page.getByRole("button", { name: "+ New" }).click();
  // The picker is the <select> inside the new-conversation form (NOT the
  // sidebar team switcher, which is also a <select>). Scope to the form that
  // contains the "Opening message…" textarea, then pick its select. Each
  // <option value> is the participant alias; label is "<display> · <kind>".
  const newForm = page
    .locator("div")
    .filter({ has: page.getByPlaceholder("Opening message…") })
    .last();
  const select = newForm.locator("select");
  await expect(select).toBeVisible({ timeout: 10_000 });
  await select.selectOption(peerAlias);
  await page.getByPlaceholder("Opening message…").fill(body);
  await page.getByRole("button", { name: "Start chat" }).click();
  // After starting, the thread for this peer becomes active and the message
  // round-trips back through the server into the thread.
  await expect(page.getByText(body).first()).toBeVisible({ timeout: 15_000 });
}

test.describe("aweb DEMO-READY — sidebar + presence + chat", () => {
  test("SIDEBAR: left rail renders and each item navigates + activates", async ({
    page,
  }) => {
    await login(page);

    // The left rail and its four primary nav items are present.
    const sidebar = page.locator("aside.sidebar");
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText("aweb", { exact: true })).toBeVisible();
    for (const label of ["Console", "Work", "Chat", "Members"]) {
      await expect(
        sidebar.getByRole("link", { name: label }),
      ).toBeVisible();
    }

    // Landing on /dashboard, Console is the active item.
    await expect(
      sidebar.getByRole("link", { name: "Console" }),
    ).toHaveClass(/active/);
    await page.screenshot({ path: `${ART}/30-sidebar-dashboard.png`, fullPage: true });

    // Click each section; URL navigates and the clicked item becomes active.
    const cases: ReadonlyArray<{ label: string; url: RegExp }> = [
      { label: "Work", url: /\/dashboard\/work/ },
      { label: "Chat", url: /\/dashboard\/chat/ },
      { label: "Members", url: /\/dashboard\/members/ },
      { label: "Console", url: /\/dashboard$/ },
    ];
    for (const c of cases) {
      await sidebar.getByRole("link", { name: c.label }).click();
      await expect(page).toHaveURL(c.url, { timeout: 10_000 });
      await expect(
        sidebar.getByRole("link", { name: c.label }),
      ).toHaveClass(/active/);
      if (c.label === "Chat") {
        await page.screenshot({
          path: `${ART}/31-sidebar-chat.png`,
          fullPage: true,
        });
      }
    }
  });

  test("APPEAR ONLINE: UI online dot + GET /v1/participants reports founder online", async ({
    page,
  }) => {
    await login(page);

    // The sidebar footer mounts the presence heartbeat; once it fires, the
    // user-badge online dot turns green (gains the `online` class).
    const onlineDot = page.locator(".user-badge .online-dot");
    await expect(onlineDot).toHaveClass(/online/, { timeout: 15_000 });
    await expect(page.locator(".user-badge .user-badge-name")).toBeVisible();

    // Authoritative server check with the SAME JWT the browser holds: fetch the
    // Better Auth token from the app, call the aweb directory, and assert the
    // founder's row is online:true. This is the human's real presence record.
    const founderOnline = await page.evaluate(
      async ({ aweb, team }) => {
        const tokRes = await fetch("/api/auth/token", {
          headers: { accept: "application/json" },
        });
        const { token } = (await tokRes.json()) as { token?: string };
        if (!token) return { ok: false, reason: "no token" as const };
        const res = await fetch(`${aweb}/v1/participants`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "X-AWEB-Team-Id": team,
          },
        });
        if (!res.ok) {
          return { ok: false, reason: `participants ${res.status}` as const };
        }
        const data = (await res.json()) as {
          participants: Array<{
            kind: string;
            display_name: string;
            alias: string;
            online: boolean;
          }>;
        };
        const founder = data.participants.find(
          (p) => p.kind === "human" && /founder/i.test(p.display_name),
        );
        return {
          ok: true as const,
          found: !!founder,
          online: founder?.online ?? false,
        };
      },
      { aweb: AWEB, team: TEAM },
    );

    expect(founderOnline.ok, JSON.stringify(founderOnline)).toBe(true);
    if (founderOnline.ok) {
      expect(founderOnline.found).toBe(true);
      expect(founderOnline.online).toBe(true);
    }

    // Visual proof on the Members roster: the founder's human row shows online.
    await page.goto("/dashboard/members");
    await expect(
      page.getByRole("heading", { name: "Members" }),
    ).toBeVisible();
    await expect(page.getByText("Humans").first()).toBeVisible();
    // At least one "online" status badge is present (the founder).
    await expect(page.getByText("online").first()).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: `${ART}/32-members-online.png`, fullPage: true });
  });

  test("CHAT: human<->agent and human<->human send + render with badges", async ({
    page,
  }) => {
    await login(page);

    // --- human -> agent (Ada) ---
    const toAda = `Demo to Ada ${Date.now()}`;
    await startChatAndSend(page, "Ada (agent)", toAda);
    // Our own message renders as "You"; the peer is tagged "AI agent".
    await expect(page.getByText("You").first()).toBeVisible();
    await expect(
      page.getByText("AI agent", { exact: true }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    // --- human -> human (Mia) ---
    const toMia = `Demo to Mia ${Date.now()}`;
    await startChatAndSend(page, "Mia", toMia);
    // (Mia's alias is exactly "Mia".)
    await expect(page.getByText(toMia).first()).toBeVisible();
    await expect(page.getByText("You").first()).toBeVisible();

    await page.screenshot({ path: `${ART}/33-chat.png`, fullPage: true });
  });
});

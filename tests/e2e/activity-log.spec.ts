import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import {
  HEAD_OFFICE_USERNAME,
  SEEDED_DELETE_ACTION,
  SEEDED_ENTITY_ID,
  SUPER_ADMIN_USERNAME,
} from "./support/seed"

/**
 * The admin activity log in a real browser.
 *
 * Only what a browser can prove and the other suites cannot: that a Super Admin
 * signs in and reaches the screen, that the rows render and the filters and the
 * detail panel work against the live endpoint, and that another role is turned
 * away. The merge, the cursor, the filters as SQL and every bound are covered in
 * `tests/integration/activity-log-api.test.ts`; nothing here duplicates them.
 */

/**
 * Open `/activity` narrowed to this run's own actor.
 *
 * `oneflowe_test` is shared with the integration suites, so the newest fifty
 * events are not this run's. Every test that asserts on a *specific* seeded row
 * narrows first; without it these tests pass or fail depending on what else had
 * run against the database, which is the worst kind of test.
 */
async function openScopedToThisRun(page: Page): Promise<void> {
  await page.goto("/activity")
  // The first visit on a cold development server waits for the page and its
  // endpoint to compile.
  await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible({ timeout: 150_000 })
  await page.getByLabel("Search").fill(SUPER_ADMIN_USERNAME)
  await expect(page.getByText(`Search: ${SUPER_ADMIN_USERNAME}`)).toBeVisible()
  await expect(page.getByText(/\d+ events? loaded/)).toBeVisible({ timeout: 150_000 })
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  // A cold development server compiles the landing workspace first.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 150_000 })
}

test.describe("the activity log", () => {
  // The first test of a run meets a cold development server.
  test.beforeEach(() => {
    test.slow()
  })

  test("a Super Admin reaches it from the menu and sees the trail", async ({ page }) => {
    await signIn(page, SUPER_ADMIN_USERNAME)

    // Through the sidebar, because the entry being there for this role is part
    // of what is being checked.
    await page.getByRole("link", { name: "Activity Log" }).click()
    await expect(page).toHaveURL(/\/activity$/, { timeout: 150_000 })

    await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(/\d+ events? loaded/)).toBeVisible({ timeout: 150_000 })

    // Narrowed to this run's own actor before asserting on specific rows.
    //
    // The unfiltered first page is the newest fifty events in a database the
    // integration suites also write to, so the seeded rows are not reliably on
    // it — asserting they are made this test depend on whatever else had run.
    // Searching by the actor is deterministic, and it also exercises in a real
    // browser the lookup that resolves a person's name to the two tables which
    // store only their id.
    await page.getByLabel("Search").fill(SUPER_ADMIN_USERNAME)
    await expect(page.getByText(`Search: ${SUPER_ADMIN_USERNAME}`)).toBeVisible()

    // One row from each of the three tables behind the screen.
    await expect(page.getByText("Delete category").first()).toBeVisible()
    await expect(page.getByText("Update supplier").first()).toBeVisible()
    await expect(page.getByText("Auth login failure").first()).toBeVisible()
    await expect(page.getByText("Create group").first()).toBeVisible()

    // Severity and operation are spelled out, never carried by colour alone.
    await expect(page.getByText("Critical").first()).toBeVisible()
    await expect(page.getByText("Deleted").first()).toBeVisible()
  })

  test("filtering narrows the list and says what is filtered", async ({ page }) => {
    await signIn(page, SUPER_ADMIN_USERNAME)
    await openScopedToThisRun(page)
    await expect(page.getByText("Update supplier").first()).toBeVisible()

    await page.getByLabel("Operation").click()
    await page.getByRole("option", { name: "Deleted" }).click()

    // The chip names the filter that is on, so one left by accident is visible.
    await expect(page.getByText("Operation: Deleted")).toBeVisible()

    await expect(page.getByText("Delete category").first()).toBeVisible()
    await expect(page.getByText("Update supplier")).toHaveCount(0)

    // And clearing it brings the rest back.
    await page.getByRole("button", { name: "Clear all" }).click()
    await expect(page.getByText("Update supplier").first()).toBeVisible()
  })

  test("searching finds a record by its id", async ({ page }) => {
    await signIn(page, SUPER_ADMIN_USERNAME)
    await page.goto("/activity")
    await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible()

    // Deterministic on its own: the id belongs to one seeded row.
    await page.getByLabel("Search").fill(SEEDED_ENTITY_ID)

    await expect(page.getByText(`Search: ${SEEDED_ENTITY_ID}`)).toBeVisible()
    await expect(page.getByText("Delete category").first()).toBeVisible()
    await expect(page.getByText("Auth login failure")).toHaveCount(0)
  })

  test("a row opens the detail panel with the actor, the address and the diff", async ({ page }) => {
    await signIn(page, SUPER_ADMIN_USERNAME)
    await openScopedToThisRun(page)

    await page.getByRole("button", { name: /Delete category, Deleted, Critical/ }).first().click()

    const panel = page.getByRole("dialog")
    await expect(panel).toBeVisible()
    await expect(panel.getByText(SEEDED_DELETE_ACTION)).toBeVisible()
    // `exact`, because the actor also appears in the panel's subtitle line
    // alongside the timestamp; this is the Person row.
    await expect(panel.getByText("E2E Super Admin", { exact: true })).toBeVisible()
    await expect(panel.getByText("198.51.100.11")).toBeVisible()
    await expect(panel.getByText("What changed")).toBeVisible()
    await expect(panel.getByText("E2E Retired Category")).toBeVisible()
  })

  test("a failed sign-in reads as a failure, with its reason", async ({ page }) => {
    await signIn(page, SUPER_ADMIN_USERNAME)
    await openScopedToThisRun(page)

    await page.getByLabel("Outcome").click()
    await page.getByRole("option", { name: "Failed" }).click()

    await expect(page.getByText("Auth login failure").first()).toBeVisible()
    await expect(page.getByText(/invalid_password/).first()).toBeVisible()
    await expect(page.getByText("Warning").first()).toBeVisible()
  })

  test("Head Office is turned away and never offered the entry", async ({ page }) => {
    await signIn(page, HEAD_OFFICE_USERNAME)

    // Not in the menu.
    await expect(page.getByRole("link", { name: "Activity Log" })).toHaveCount(0)

    // And not reachable by typing the address either.
    await page.goto("/activity")
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole("heading", { name: "Activity log" })).toHaveCount(0)
  })

  test("the endpoint itself refuses Head Office, not just the page", async ({ page }) => {
    await signIn(page, HEAD_OFFICE_USERNAME)

    // The redirect above is navigation only. This is the control.
    const response = await page.request.get("/api/v1/activity-logs")
    expect(response.status()).toBe(403)
    const body = await response.json()
    expect(body.items).toBeUndefined()
  })
})

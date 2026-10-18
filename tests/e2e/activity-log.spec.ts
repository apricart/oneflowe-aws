import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import {
  HEAD_OFFICE_USERNAME,
  SEEDED_DELETE_ACTION,
  SEEDED_ENTITY_ID,
  SUPER_ADMIN_USERNAME,
} from "./support/seed"
import { closeRoleRenameNoticeWhenShown } from "./support/session"

/**
 * The admin activity log in a real browser.
 *
 * Only what a browser can prove and the other suites cannot: that a Super Admin
 * signs in and reaches the screen, that the rows render and the filters and the
 * detail panel work against the live endpoint, and that Head Office reaches the
 * same screen for its own organization with Apricart's people anonymised
 * (`plans/OF-AUDIT-head-office-activity-log.md`). The merge, the cursor, the filters as SQL and every bound are covered in
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
  await closeRoleRenameNoticeWhenShown(page)
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

  test("Head Office reaches it from the menu and reads its own organization", async ({ page }) => {
    await signIn(page, HEAD_OFFICE_USERNAME)

    await page.getByRole("link", { name: "Activity Log" }).click()
    await expect(page).toHaveURL(/\/activity$/, { timeout: 150_000 })
    await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(/in your organization/)).toBeVisible()

    // Deterministic: the id belongs to one row seeded into this Head Office's
    // own organization, done there by the Super Admin.
    await page.getByLabel("Search").fill(SEEDED_ENTITY_ID)
    await expect(page.getByText(`Search: ${SEEDED_ENTITY_ID}`)).toBeVisible()
    await expect(page.getByText("Delete category").first()).toBeVisible({ timeout: 150_000 })
  })

  test("Head Office sees what Apricart changed, but not who or from where", async ({ page }) => {
    await signIn(page, HEAD_OFFICE_USERNAME)
    await page.goto("/activity")
    await expect(page.getByRole("heading", { name: "Activity log" })).toBeVisible({ timeout: 150_000 })
    await page.getByLabel("Search").fill(SEEDED_ENTITY_ID)

    await page.getByRole("button", { name: /Delete category, Deleted, Critical/ }).first().click()
    const panel = page.getByRole("dialog")
    await expect(panel).toBeVisible()
    await expect(panel.getByText("Apricart administrator", { exact: true })).toBeVisible()
    await expect(panel.getByText("Withheld")).toBeVisible()
    await expect(panel.getByText("E2E Retired Category")).toBeVisible()
    await expect(panel.getByText("E2E Super Admin")).toHaveCount(0)
    await expect(panel.getByText("198.51.100.11")).toHaveCount(0)
  })

  test("the endpoint fences Head Office to its own organization, not just the page", async ({ page }) => {
    await signIn(page, HEAD_OFFICE_USERNAME)

    const response = await page.request.get("/api/v1/activity-logs?limit=200")
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { items: Array<{ organizationId: number | null }> }
    const organizations = new Set(body.items.map((item) => item.organizationId))
    // One tenant, and never a platform row.
    expect(organizations.size).toBeLessThanOrEqual(1)
    expect(organizations.has(null)).toBe(false)

    // Asking for another organization is refused outright.
    const foreign = await page.request.get("/api/v1/activity-logs?organizationId=2147483000")
    expect(foreign.status()).toBe(403)
    expect((await foreign.json()).items).toBeUndefined()
  })
})

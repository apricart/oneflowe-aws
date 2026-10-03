import { expect, test, type Page } from "@playwright/test"

import { openFromSidebar } from "./support/admin-ui"
import { expectStatus, put, signIn, signOut, testDatabaseUrl } from "./support/session"
import { currentBudgetPeriod, destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * Allocating money budgets, by Head Office and by a Group User.
 *
 * - **Add-on validity** (`plans/OF-BUDGET-addon-validity.md`): a one-time add-on
 *   is granted with a last day, and whatever is unspent after it is withdrawn
 *   the next time the budget is read.
 * - **Group User budget allocation** (`plans/OF-GROUP-USER-budget-allocation.md`,
 *   `plans/OF-GROUP-USER-budget-allocation-per-user.md`): off by default, granted
 *   per user by Head Office, and when on it reaches only the user's own branches.
 *
 * The ledger arithmetic and the settlement are proved in the integration suite
 * (`budget-addon-expiry.test.ts`, `group-roles-api.test.ts`). This proves the
 * screens and the gates around them.
 */

const KEY = "bud"

let tenant: Tenant

/** Today in the application's calendar, which is the earliest an add-on may run to. */
function karachiToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date())
}

async function budgetRow(branchKey: string): Promise<{ id: number; allocated: number; credited: number }> {
  const [row] = await queryTestDb<{ id: number; allocated: string; credited: string }>(
    testDatabaseUrl(),
    `SELECT id, amount_allocated_cents AS allocated, amount_credited_cents AS credited
       FROM budgets WHERE branch_id = $1 AND period = $2`,
    [tenant.branches[branchKey].id, currentBudgetPeriod()],
  )
  return { id: row.id, allocated: Number(row.allocated), credited: Number(row.credited) }
}

function branchRow(page: Page, branchKey: string) {
  return page.getByRole("row").filter({ hasText: tenant.branches[branchKey].name })
}

test.describe.serial("budget allocation", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      groups: ["north"],
      branches: [
        { key: "alpha", group: "north", budgetCents: 1_000_000 },
        { key: "beta", group: "north", budgetCents: 1_000_000 },
        { key: "gamma", budgetCents: 1_000_000 },
      ],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "allocator", role: "GROUP_USER", groups: ["north"], budgetAllocationEnabled: true },
        { key: "approver", role: "GROUP_USER", groups: ["north"], budgetAllocationEnabled: false },
      ],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Head Office grants a one-time add-on that runs to a chosen day", async ({ page }) => {
    test.slow()
    const validUntil = karachiToday()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await openFromSidebar(page, "Budgets")
    await expect(branchRow(page, "alpha")).toBeVisible({ timeout: 150_000 })

    await branchRow(page, "alpha").getByRole("button", { name: "Allocate" }).click()
    const dialog = page.getByRole("dialog", { name: "Allocate Budget" })
    await dialog.getByRole("button", { name: "One-time Add-on" }).click()
    await dialog.getByLabel("Amount to Add (PKR)").fill("500")
    await dialog.getByLabel("Valid until").fill(validUntil)
    await dialog.getByRole("button", { name: "Apply Add-on" }).click()
    await expect(page.getByText("Budget Updated").first()).toBeVisible({ timeout: 150_000 })

    expect((await budgetRow("alpha")).credited).toBe(50_000)
    const addons = await queryTestDb<{ amount: string; valid_until_day: string }>(
      testDatabaseUrl(),
      `SELECT amount_cents AS amount,
              to_char(valid_until AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') AS valid_until_day
         FROM budget_addons WHERE budget_id = $1`,
      [(await budgetRow("alpha")).id],
    )
    expect(addons).toEqual([{ amount: "50000", valid_until_day: validUntil }])
    // The row shows the add-on beside the base.
    await expect(branchRow(page, "alpha").getByText("+Rs 500")).toBeVisible({ timeout: 150_000 })
  })

  test("an add-on whose day has passed is withdrawn when the budget is next read", async ({ page }) => {
    test.slow()
    const gamma = await budgetRow("gamma")
    await queryTestDb(
      testDatabaseUrl(),
      `WITH addon AS (
         INSERT INTO budget_addons (budget_id, amount_cents, reason, created_by_user_id, valid_until)
         VALUES ($1, 40000, 'E2E lapsed add-on', $2, now() - interval '1 hour')
       )
       UPDATE budgets SET amount_credited_cents = amount_credited_cents + 40000 WHERE id = $1`,
      [gamma.id, tenant.users.ho.id],
    )

    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/budgets")
    await expect(branchRow(page, "gamma")).toBeVisible({ timeout: 150_000 })

    await expect.poll(async () => (await budgetRow("gamma")).credited, { timeout: 150_000 }).toBe(0)
    const [addon] = await queryTestDb<{ expired: boolean; forfeited: string }>(
      testDatabaseUrl(),
      "SELECT expired_at IS NOT NULL AS expired, forfeited_cents AS forfeited FROM budget_addons WHERE budget_id = $1",
      [gamma.id],
    )
    expect(addon).toEqual({ expired: true, forfeited: "40000" })
  })

  test("a Group User with budget allocation sets a baseline for its own branches only", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.allocator.username, /\/dashboard/)
    await openFromSidebar(page, "Budgets")
    await expect(branchRow(page, "beta")).toBeVisible({ timeout: 150_000 })
    await expect(branchRow(page, "alpha")).toBeVisible()
    // Gamma is in the tenant but not in the user's group.
    await expect(branchRow(page, "gamma")).toHaveCount(0)

    await branchRow(page, "beta").getByRole("button", { name: "Allocate" }).click()
    const dialog = page.getByRole("dialog", { name: "Allocate Budget" })
    await dialog.getByRole("button", { name: "Monthly Base" }).click()
    await dialog.getByLabel("New Baseline Amount (PKR)").fill("25000")
    await dialog.getByRole("button", { name: "Update Baseline" }).click()
    await expect(page.getByText("Budget Updated").first()).toBeVisible({ timeout: 150_000 })
    expect((await budgetRow("beta")).allocated).toBe(2_500_000)

    // Outside its branches, the endpoint refuses it.
    await expectStatus(
      await put(page, "/api/v1/budgets", {
        branchId: tenant.branches.gamma.id,
        amountAllocatedCents: 1,
        type: "monthly",
      }),
      403,
    )
    expect((await budgetRow("gamma")).allocated).toBe(1_000_000)
  })

  test("a Group User without it is not offered Budgets, and the endpoint refuses it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.approver.username, /\/dashboard/)
    await expect(page.getByRole("link", { name: "Budgets", exact: true })).toHaveCount(0)
    await page.goto("/budgets")
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 150_000 })
    await expectStatus(
      await put(page, "/api/v1/budgets", {
        branchId: tenant.branches.alpha.id,
        amountAllocatedCents: 1,
        type: "monthly",
      }),
      403,
    )
  })

  test("Head Office grants budget allocation to that Group User in Edit User", async ({ page }) => {
    test.slow()
    const target = tenant.users.approver.username
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/users")
    await page.getByPlaceholder("Search users by name or email...").fill(target)
    const row = page.locator("tr", { hasText: target }).first()
    await expect(row).toBeVisible({ timeout: 150_000 })
    await row.click()
    await page.getByRole("button", { name: /edit profile/i }).click()
    const dialog = page.getByRole("dialog").filter({ hasText: "Edit User" })
    // The user's group assignments load after the dialog opens; saving before
    // they arrive would submit a Group User with no scope at all.
    await expect(dialog.getByText(tenant.groups.north.name).first()).toBeVisible({ timeout: 150_000 })
    const toggle = dialog.getByRole("switch", { name: "Budget Allocation" })
    await expect(toggle).toBeEnabled({ timeout: 150_000 })
    await expect(toggle).toHaveAttribute("data-state", "unchecked")
    await toggle.click()
    await dialog.getByRole("button", { name: /save changes/i }).click()
    await expect(dialog).toBeHidden({ timeout: 150_000 })
    await signOut(page)

    await signIn(page, target, /\/dashboard/)
    await expect(page.getByRole("link", { name: "Budgets", exact: true }).first()).toBeVisible({ timeout: 150_000 })
  })
})

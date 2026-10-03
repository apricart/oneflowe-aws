import { expect, test, type Page } from "@playwright/test"

import { openEditCompany as openCompany } from "./support/admin-ui"
import { E2E_PASSWORD } from "./support/environment"
import {
  BUDGET_TOGGLE_ORGANIZATION,
  BUDGET_TOGGLE_USERNAMES,
  destroyBudgetToggleE2E,
  readBudgetsEnabled,
  readTenantLedger,
  seedBudgetToggleE2E,
} from "./support/budget-toggle-seed"
import { queryTestDb } from "./support/tenant"

/**
 * The organization "Budget allocation" switch, in a real browser.
 *
 * What only a browser can prove: that a Super Admin can find and flip the
 * switch in Edit Company and it reaches the database; that an Order Portal
 * user of a tenant with budgets off, at a branch with no budget at all, sees no
 * budget and can still place an order; and that Head Office of that tenant is
 * not offered budget pages that have nothing to show. The ledger rules
 * themselves are covered by `tests/integration/organization-budget-toggle.test.ts`.
 */

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim() ?? ""
  if (!url || !/test/i.test(new URL(url).pathname)) {
    throw new Error("TEST_DATABASE_URL must name a disposable test database")
  }
  return url
}

async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    waitUntil: "commit",
    timeout: 120_000,
  })
}

async function openEditCompany(page: Page) {
  const [organization] = await queryTestDb<{ id: number }>(
    testDatabaseUrl(),
    "SELECT id FROM organizations WHERE name = $1",
    [BUDGET_TOGGLE_ORGANIZATION.name],
  )
  return openCompany(page, {
    organizationId: organization.id,
    organizationName: BUDGET_TOGGLE_ORGANIZATION.name,
  })
}

test.describe.serial("organization budget allocation switch", () => {
  test.beforeAll(async () => {
    await seedBudgetToggleE2E(testDatabaseUrl())
  })

  test.afterAll(async () => {
    await destroyBudgetToggleE2E(testDatabaseUrl())
  })

  test("Super Admin switches budget allocation on and back off in Edit Company", async ({ page }) => {
    // The first journey to sign in compiles the admin portal on the dev server.
    test.slow()
    await signIn(page, BUDGET_TOGGLE_USERNAMES.superAdmin)

    let dialog = await openEditCompany(page)
    const toggle = dialog.getByRole("switch", { name: "Budget allocation" })
    // Disabled until the dialog's settings read returns, which on a cold dev
    // server waits for that route to compile.
    await expect(toggle).toBeEnabled({ timeout: 120_000 })
    await expect(toggle).toHaveAttribute("data-state", "unchecked")
    // The model has no effect while off, so it is not offered.
    await expect(dialog.getByRole("button", { name: /Money value/ })).toHaveCount(0)

    await toggle.click()
    await expect(toggle).toHaveAttribute("data-state", "checked")
    await expect(dialog.getByRole("button", { name: /Money value/ })).toBeVisible()
    await dialog.getByRole("button", { name: "Save Changes" }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => readBudgetsEnabled(testDatabaseUrl())).toBe(true)

    dialog = await openEditCompany(page)
    const reopened = dialog.getByRole("switch", { name: "Budget allocation" })
    await expect(reopened).toBeEnabled({ timeout: 60_000 })
    await expect(reopened).toHaveAttribute("data-state", "checked")
    await reopened.click()
    await expect(dialog.getByText(/Orders already holding budget keep it until they are decided/)).toBeVisible()
    await dialog.getByRole("button", { name: "Save Changes" }).click()
    await expect(dialog).toBeHidden()
    await expect.poll(() => readBudgetsEnabled(testDatabaseUrl())).toBe(false)

    // The list says so too, rather than naming a model.
    await page.getByPlaceholder("Search companies...").fill(BUDGET_TOGGLE_ORGANIZATION.name)
    await expect(
      page.locator("article").filter({ hasText: BUDGET_TOGGLE_ORGANIZATION.name }).getByText("Budget off"),
    ).toBeVisible()
  })

  test("an Order Portal user orders at a branch with no budget, and no budget is shown or held", async ({ page }) => {
    test.slow()
    expect(await readBudgetsEnabled(testDatabaseUrl())).toBe(false)
    await signIn(page, BUDGET_TOGGLE_USERNAMES.orderPortal)
    await page.waitForURL(/\/shop$/, { timeout: 150_000 })

    await page.getByRole("button", { name: /Add .* to Cart/ }).first().click()
    // No budget card: with budgets on it reads "PKR … of PKR …".
    await expect(page.getByText(/of PKR/)).toHaveCount(0)

    await page.getByRole("button", { name: "Open Cart" }).click()
    await expect(page.getByText(/Remaining budget after/)).toHaveCount(0)
    await expect(page.getByText(/Cart exceeds remaining budget/)).toHaveCount(0)
    const proceed = page.getByRole("button", { name: /Proceed to checkout/ })
    await expect(proceed).toBeEnabled()
    await proceed.click()
    await page.getByRole("button", { name: "Place Order" }).click()

    // One order of 250.00, taken with no hold, and no budget row opened for it.
    await expect.poll(async () => (await readTenantLedger(testDatabaseUrl())).orders, { timeout: 60_000 })
      .toEqual([{ budgetTracked: false, totalCents: 25_000 }])
    expect((await readTenantLedger(testDatabaseUrl())).budgetRows).toBe(0)
  })

  test("Head Office is not offered budget pages, and the Budget Report says budgets are off", async ({ page }) => {
    test.slow()
    await signIn(page, BUDGET_TOGGLE_USERNAMES.headOffice)
    await page.waitForURL(/\/dashboard$/, { timeout: 150_000 })

    const navigation = page.locator("nav, aside").first()
    await expect(navigation.getByRole("link", { name: "Orders", exact: true }).first()).toBeVisible()
    // The shell drops these once its budget-policy read returns, which on a
    // cold development server waits for that route to compile.
    await expect(page.getByRole("link", { name: "Budgets", exact: true })).toHaveCount(0, { timeout: 150_000 })
    await expect(page.getByRole("link", { name: "Budget by Quantity", exact: true })).toHaveCount(0)

    await page.goto("/reports/budget-summary")
    await expect(page.getByText("Budget allocation is off for this organization")).toBeVisible({ timeout: 60_000 })
  })
})

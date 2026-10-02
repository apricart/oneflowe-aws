import { expect, test } from "@playwright/test"

import { openShopCheckout, setCompanySwitch } from "./support/admin-ui"
import {
  apiSession,
  expectStatus,
  patch,
  placeOrder,
  post,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * The organization "Require order approval" switch
 * (`plans/OF-ORDERS-organization-auto-approval.md`).
 *
 * The resolver, its lock and both creation paths are in
 * `tests/integration/order-auto-approval-*.test.ts`. This proves the journey:
 * a Super Admin finds the switch in Create and Edit Company; with it off, an
 * order placed in the store is approved the moment it exists — fulfilment
 * token and all, with no person recorded as its approver — while an order that
 * was already waiting stays waiting; and switching it back on restores the
 * approval step for the next order.
 */

const KEY = "auto"
const CREATED_COMPANY = { name: `E2E ${KEY} Created Org`, code: "E2E_AUTO_NEW" }

let tenant: Tenant

async function readOrders(): Promise<Array<{
  id: number
  status: string
  approved_by_user_id: string | null
  has_token: boolean
}>> {
  return queryTestDb(
    testDatabaseUrl(),
    `SELECT id, status, approved_by_user_id, approval_token_hash IS NOT NULL AS has_token
       FROM orders WHERE organization_id = $1 ORDER BY id`,
    [tenant.organizationId],
  )
}

test.describe.serial("organization auto-approval", () => {
  test.beforeAll(async ({ browser }) => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "main", budgetCents: 100_000_000 }],
      users: [
        { key: "op", role: "ORDER_PORTAL", branch: "main" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "main" },
        { key: "ho", role: "HEAD_OFFICE" },
      ],
      products: [{ code: "CUP", name: "E2E Auto Cup", priceCents: 1_500 }],
    })
    // An order already waiting when the switch goes off.
    const requester = await apiSession(browser, tenant.users.op.username)
    try {
      await placeOrder(requester.page, [{ organizationInventoryId: tenant.products.CUP.organizationInventoryId, quantity: 1 }])
    } finally {
      await requester.close()
    }
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Super Admin switches approval off in Edit Company", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await setCompanySwitch(page, tenant, "Require order approval", false)
    const [row] = await queryTestDb<{ required: boolean }>(
      testDatabaseUrl(),
      "SELECT order_approval_required AS required FROM organizations WHERE id = $1",
      [tenant.organizationId],
    )
    expect(row.required).toBe(false)
  })

  test("an order placed in the store is approved on creation; the waiting one is untouched", async ({ page, browser }) => {
    test.slow()
    await signIn(page, tenant.users.op.username, /\/shop/)
    const checkout = await openShopCheckout(page)
    await checkout.getByRole("button", { name: "Place Order" }).click()
    await expect(page.getByText("Order Submitted").first()).toBeVisible({ timeout: 150_000 })

    await expect.poll(readOrders, { timeout: 150_000 }).toEqual([
      expect.objectContaining({ status: "PENDING" }),
      // Fulfilment-ready: a token exists, and nobody is recorded as approving it.
      expect.objectContaining({ status: "APPROVED", approved_by_user_id: null, has_token: true }),
    ])

    // There is nothing left to decide on it.
    const [, approved] = await readOrders()
    const approver = await apiSession(browser, tenant.users.ba.username)
    try {
      const refused = await post(approver.page, `/api/v1/orders/${approved.id}/approve`, {})
      expect(refused.status()).toBeGreaterThanOrEqual(400)
      expect((await readOrders())[1].status).toBe("APPROVED")
    } finally {
      await approver.close()
    }
  })

  test("switching approval back on restores the approval step", async ({ page, browser }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await setCompanySwitch(page, tenant, "Require order approval", true)

    const requester = await apiSession(browser, tenant.users.op.username)
    try {
      const order = await placeOrder(requester.page, [
        { organizationInventoryId: tenant.products.CUP.organizationInventoryId, quantity: 1 },
      ])
      expect(order.status).toBe("PENDING")
    } finally {
      await requester.close()
    }
  })

  test("Create Company can start a company with approval off", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/organizations")
    await page.getByRole("button", { name: "Create Company" }).click()

    const dialog = page.getByRole("dialog", { name: "Create Company" })
    await dialog.getByLabel("Company name").fill(CREATED_COMPANY.name)
    await dialog.getByLabel("Code", { exact: true }).fill(CREATED_COMPANY.code)
    const toggle = dialog.getByRole("switch", { name: "Require order approval" })
    await expect(toggle).toHaveAttribute("data-state", "checked")
    await toggle.click()
    await expect(toggle).toHaveAttribute("data-state", "unchecked")
    await dialog.getByRole("button", { name: "Save Company" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Create Company" }).click()
    await expect(page.getByText("Company created successfully.")).toBeVisible({ timeout: 150_000 })

    const rows = await queryTestDb<{ required: boolean }>(
      testDatabaseUrl(),
      "SELECT order_approval_required AS required FROM organizations WHERE name = $1",
      [CREATED_COMPANY.name],
    )
    expect(rows).toEqual([{ required: false }])
  })

  test("Head Office cannot change the switch, even by calling the endpoint", async ({ browser }) => {
    const headOffice = await apiSession(browser, tenant.users.ho.username)
    try {
      await expectStatus(
        await patch(headOffice.page, `/api/v1/organizations/${tenant.organizationId}`, { orderApprovalRequired: false }),
        403,
      )
      const [row] = await queryTestDb<{ required: boolean }>(
        testDatabaseUrl(),
        "SELECT order_approval_required AS required FROM organizations WHERE id = $1",
        [tenant.organizationId],
      )
      expect(row.required).toBe(true)
    } finally {
      await headOffice.close()
    }
  })
})

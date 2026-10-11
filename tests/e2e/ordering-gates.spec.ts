import { expect, test, type Browser, type Page } from "@playwright/test"

import { openShopCheckout, setCompanySwitch } from "./support/admin-ui"
import {
  apiSession,
  approveOrder,
  expectStatus,
  fulfilOrder,
  markDelivered,
  placeOrder,
  post,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * What happens when a requester presses Place Order and something is owed.
 *
 * Three features meet at the same button, in the order the shop checks them:
 *
 * 1. **Unpaid invoices** (`plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md`)
 *    — with the organization's switch on, two delivered, invoiced, unpaid orders
 *    stop the branch ordering until one is paid.
 * 2. **Unacknowledged deliveries** (`plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md`)
 *    — with its own switch on, two delivered-but-still-approved orders stop the
 *    branch until one is settled.
 * 3. **Pending invoice notice** (`plans/OF-ORDERS-pending-invoice-notice.md`) — a
 *    notice, not a block: the requester is told and may continue.
 *
 * The counting rules are in the integration suite. This proves the journey: the
 * Super Admin switch in Edit Company reaches the gate, the requester sees the
 * right popup and no order is written, the server refuses the same request made
 * directly, and paying or settling lets the branch order again.
 */

const KEY = "gate"

let tenant: Tenant

async function ordersAt(branchKey: string): Promise<Array<{ id: number; status: string }>> {
  return queryTestDb(
    testDatabaseUrl(),
    "SELECT id, status FROM orders WHERE branch_id = $1 ORDER BY id",
    [tenant.branches[branchKey].id],
  )
}

async function invoiceNumber(orderId: number): Promise<string> {
  const [row] = await queryTestDb<{ invoice: string }>(
    testDatabaseUrl(),
    "SELECT receipt_data ->> 'invoiceNumber' AS invoice FROM orders WHERE id = $1",
    [orderId],
  )
  return row.invoice
}

/** Place an order as the given requester and approve it as the branch's admin. */
async function approvedOrder(browser: Browser, requester: string, approver: string): Promise<{ id: number; token: string }> {
  const requesterSession = await apiSession(browser, requester)
  const approverSession = await apiSession(browser, approver)
  try {
    const order = await placeOrder(requesterSession.page, [
      { organizationInventoryId: tenant.products.PAPER.organizationInventoryId, quantity: 1 },
    ])
    const token = await approveOrder(approverSession.page, Number(order.id))
    return { id: Number(order.id), token }
  } finally {
    await requesterSession.close()
    await approverSession.close()
  }
}

async function pressPlaceOrder(page: Page): Promise<void> {
  const checkout = await openShopCheckout(page)
  await checkout.getByRole("button", { name: "Place Order" }).click()
}

async function continuePastPendingInvoice(page: Page): Promise<void> {
  const notice = page.getByRole("alertdialog", { name: "Pending invoice" })
  await expect(notice).toBeVisible({ timeout: 150_000 })
  await notice.getByRole("button", { name: "Continue with order" }).click()
  await expect(page.getByText("Order Submitted").first()).toBeVisible({ timeout: 150_000 })
}

test.describe.serial("ordering gates at checkout", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [
        { key: "north", budgetCents: 100_000_000 },
        { key: "south", budgetCents: 100_000_000 },
      ],
      users: [
        { key: "opn", role: "ORDER_PORTAL", branch: "north" },
        { key: "ban", role: "BRANCH_ADMIN", branch: "north" },
        { key: "ops", role: "ORDER_PORTAL", branch: "south" },
        { key: "bas", role: "BRANCH_ADMIN", branch: "south" },
      ],
      products: [{ code: "PAPER", name: "E2E Gate Paper", priceCents: 5_000 }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("a pending invoice is a notice: Cancel places nothing, Continue places the order", async ({ page, browser }) => {
    test.slow()
    const first = await approvedOrder(browser, tenant.users.opn.username, tenant.users.ban.username)
    // Only an issued tax invoice is pending, and it is issued at delivery
    // (plans/OF-INVOICE-invoice-ledger.md): an approved order is a proforma.
    const superAdmin = await apiSession(browser, tenant.superAdmin.username)
    try {
      await markDelivered(superAdmin.page, first.id)
    } finally {
      await superAdmin.close()
    }

    await signIn(page, tenant.users.opn.username, /\/shop/)
    await pressPlaceOrder(page)
    const notice = page.getByRole("alertdialog", { name: "Pending invoice" })
    await expect(notice).toBeVisible({ timeout: 150_000 })
    await expect(notice).toContainText(await invoiceNumber(first.id))
    await notice.getByRole("button", { name: "Cancel" }).click()
    await expect(notice).toBeHidden()
    expect(await ordersAt("north")).toHaveLength(1)

    await page.getByRole("dialog", { name: "Order Confirmation" }).getByRole("button", { name: "Place Order" }).click()
    await continuePastPendingInvoice(page)
    expect(await ordersAt("north")).toHaveLength(2)
  })

  test("unacknowledged deliveries stop a branch once Super Admin switches the block on", async ({ page, browser }) => {
    test.slow()
    const superAdmin = await apiSession(browser, tenant.superAdmin.username)
    try {
      for (let n = 0; n < 2; n += 1) {
        const order = await approvedOrder(browser, tenant.users.ops.username, tenant.users.bas.username)
        await markDelivered(superAdmin.page, order.id)
      }

      await signIn(page, tenant.superAdmin.username, /\/dashboard/)
      await setCompanySwitch(page, tenant, "Block ordering on unacknowledged deliveries", true)
      await expect.poll(async () => (await queryTestDb<{ on: boolean }>(
        testDatabaseUrl(),
        "SELECT block_ordering_on_unacknowledged_deliveries AS on FROM organizations WHERE id = $1",
        [tenant.organizationId],
      ))[0].on, { timeout: 150_000 }).toBe(true)
      await page.context().clearCookies()

      await signIn(page, tenant.users.ops.username, /\/shop/)
      await pressPlaceOrder(page)
      const popup = page.getByRole("alertdialog", { name: "Delivered orders awaiting acknowledgement" })
      await expect(popup).toBeVisible({ timeout: 150_000 })
      await expect(popup).toContainText("acknowledge/fulfil")
      await popup.getByRole("button", { name: "View unacknowledged orders" }).click()
      await expect(page.getByRole("table", { name: "Delivered orders awaiting acknowledgement" }).locator("tbody tr")).toHaveCount(2)
      expect(await ordersAt("south")).toHaveLength(2)

      // The popup is presentation; the server refuses the same request made directly.
      const direct = await expectStatus(
        await post(page, "/api/v1/orders", {
          items: [{ organizationInventoryId: tenant.products.PAPER.organizationInventoryId, quantity: 1 }],
        }, { "Idempotency-Key": `e2e-gate-${Date.now()}` }),
        409,
      )
      expect(direct.code).toBe("UNACKNOWLEDGED_DELIVERIES_BLOCKED")

      // Settling one delivery drops the branch below the threshold.
      const [settle] = await queryTestDb<{ id: number; approval_token: string }>(
        testDatabaseUrl(),
        "SELECT id, approval_token FROM orders WHERE branch_id = $1 ORDER BY id LIMIT 1",
        [tenant.branches.south.id],
      )
      await fulfilOrder(superAdmin.page, settle.id, settle.approval_token)

      await page.goto("/shop")
      await pressPlaceOrder(page)
      await continuePastPendingInvoice(page)
      expect(await ordersAt("south")).toHaveLength(3)
    } finally {
      await superAdmin.close()
    }
  })

  test("unpaid invoices stop a branch until Super Admin marks one paid", async ({ page, browser }) => {
    test.slow()
    const superAdmin = await apiSession(browser, tenant.superAdmin.username)
    const approver = await apiSession(browser, tenant.users.ban.username)
    try {
      // North holds one delivered and one pending order from the first test.
      const [first, second] = await ordersAt("north")
      await approveOrder(approver.page, second.id)
      const tokens = await queryTestDb<{ id: number; approval_token: string; fulfillment_status: string }>(
        testDatabaseUrl(),
        "SELECT id, approval_token, fulfillment_status FROM orders WHERE id = ANY($1::int[]) ORDER BY id",
        [[first.id, second.id]],
      )
      for (const order of tokens) {
        if (order.fulfillment_status !== "DELIVERED") await markDelivered(superAdmin.page, order.id)
        await fulfilOrder(superAdmin.page, order.id, order.approval_token)
      }

      await signIn(page, tenant.superAdmin.username, /\/dashboard/)
      await setCompanySwitch(page, tenant, "Block ordering on unpaid invoices", true)
      await page.context().clearCookies()

      await signIn(page, tenant.users.opn.username, /\/shop/)
      await pressPlaceOrder(page)
      const popup = page.getByRole("alertdialog", { name: "Unpaid invoices" })
      await expect(popup).toBeVisible({ timeout: 150_000 })
      await expect(popup).toContainText(/pay your dues/i)
      expect(await ordersAt("north")).toHaveLength(2)

      const direct = await expectStatus(
        await post(page, "/api/v1/orders", {
          items: [{ organizationInventoryId: tenant.products.PAPER.organizationInventoryId, quantity: 1 }],
        }, { "Idempotency-Key": `e2e-gate-${Date.now()}` }),
        409,
      )
      expect(direct.code).toBe("PAYMENT_CONTROL_BLOCKED")

      // Paying one invoice is the remedy.
      await expectStatus(await post(superAdmin.page, `/api/v1/orders/${first.id}/payment-status`, { paymentStatus: "PAID" }))

      await page.goto("/shop")
      await pressPlaceOrder(page)
      await continuePastPendingInvoice(page)
      expect(await ordersAt("north")).toHaveLength(3)
    } finally {
      await superAdmin.close()
      await approver.close()
    }
  })
})

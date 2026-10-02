import { expect, test } from "@playwright/test"

import { openFromSidebar, openShopCheckout } from "./support/admin-ui"
import {
  apiSession,
  approveOrder,
  expectStatus,
  patch,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * Extra delivery addresses, gated on Head Office (`plans/OF-ADDR-multiple-delivery-addresses.md`).
 *
 * The rules and the SQL are proved in `tests/integration/delivery-addresses.test.ts`.
 * What only a browser proves: that an Order Portal user can ask for an address
 * without leaving the store, that a waiting address is counted but cannot be
 * chosen, that Head Office finds and decides the request on its own page, and
 * that the address chosen at checkout is the one the order and its invoice carry.
 */

const KEY = "addr"
const GATE_LABEL = "E2E Warehouse Gate 2"
const SITE_LABEL = "E2E Site Office"

let tenant: Tenant

async function readAddresses(): Promise<Array<{ id: number; label: string; status: string; decision_reason: string | null }>> {
  return queryTestDb(
    testDatabaseUrl(),
    `SELECT id, label, status, decision_reason FROM branch_delivery_addresses
      WHERE organization_id = $1 ORDER BY id`,
    [tenant.organizationId],
  )
}

test.describe.serial("delivery addresses", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "main", budgetCents: 100_000_000 }],
      users: [
        { key: "op", role: "ORDER_PORTAL", branch: "main" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "main" },
        { key: "ho", role: "HEAD_OFFICE" },
      ],
      products: [{ code: "SOAP", name: "E2E Address Soap", priceCents: 10_000 }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("an Order Portal user asks for an address at checkout; it waits and cannot be chosen", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.op.username, /\/shop/)
    const checkout = await openShopCheckout(page)
    await checkout.getByRole("button", { name: "Request a new address" }).click()

    const request = page.getByRole("dialog", { name: "Request a delivery address" })
    await request.getByLabel("Name for this address").fill(GATE_LABEL)
    await request.getByLabel("Address", { exact: true }).fill("Plot 14, Sector 23, Korangi")
    await request.getByLabel("City").fill("Karachi")
    await request.getByLabel("Why is it needed? (optional)").fill("Deliveries to the back gate")
    await request.getByRole("button", { name: "Send for approval" }).click()
    await expect(request).toBeHidden()

    await expect(checkout.getByText("1 still waiting for approval.")).toBeVisible()
    await checkout.getByLabel("Deliver to").click()
    // Only the branch's own address is offered: a waiting address is counted, never selectable.
    await expect(page.getByRole("option")).toHaveCount(1)
    await expect(page.getByRole("option", { name: /Branch's own address/ })).toBeVisible()
    await page.keyboard.press("Escape")

    await expect.poll(readAddresses, { timeout: 150_000 }).toEqual([
      expect.objectContaining({ label: GATE_LABEL, status: "pending" }),
    ])
  })

  test("the Branch Admin requests a second address from the page, and cannot decide its own", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ba.username, /\/dashboard/)
    await openFromSidebar(page, "Delivery Addresses")
    await expect(page.getByRole("heading", { name: "Delivery Addresses" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText("Where your branch can have orders delivered")).toBeVisible()
    // A requester is never offered the decision.
    await expect(page.getByRole("button", { name: "Review" })).toHaveCount(0)

    await page.getByRole("button", { name: /Request an address|Request/ }).first().click()
    const request = page.getByRole("dialog", { name: "Request a delivery address" })
    await request.getByLabel("Name for this address").fill(SITE_LABEL)
    await request.getByLabel("Address", { exact: true }).fill("Site office, Port Qasim")
    await request.getByRole("button", { name: "Send for approval" }).click()
    await expect(request).toBeHidden()
    await expect(page.getByText(SITE_LABEL)).toBeVisible()

    // And the server refuses the decision, not just the page.
    const [, site] = await readAddresses()
    await expectStatus(
      await patch(page, `/api/v1/delivery-addresses/${site.id}`, { decision: "approve" }),
      403,
    )
  })

  test("Head Office approves one request and rejects the other, with a note", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/delivery-addresses")
    await expect(page.getByText("Extra delivery addresses your branches have asked for")).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText("2 waiting")).toBeVisible()

    await page.locator("li").filter({ hasText: GATE_LABEL }).getByRole("button", { name: "Review" }).click()
    let decision = page.getByRole("dialog", { name: GATE_LABEL })
    await expect(decision.getByText("Deliveries to the back gate")).toBeVisible()
    await decision.getByRole("button", { name: "Approve" }).click()
    await expect(decision).toBeHidden()

    await page.locator("li").filter({ hasText: SITE_LABEL }).getByRole("button", { name: "Review" }).click()
    decision = page.getByRole("dialog", { name: SITE_LABEL })
    await decision.getByLabel("Note (optional)").fill("Use the branch address for the site office")
    await decision.getByRole("button", { name: "Reject" }).click()
    await expect(decision).toBeHidden()

    await expect.poll(readAddresses, { timeout: 150_000 }).toEqual([
      expect.objectContaining({ label: GATE_LABEL, status: "approved" }),
      expect.objectContaining({
        label: SITE_LABEL,
        status: "rejected",
        decision_reason: "Use the branch address for the site office",
      }),
    ])
    await expect(page.getByText("2 waiting")).toHaveCount(0)
  })

  test("the approved address is chosen at checkout and carried by the order and its invoice", async ({ page, browser }) => {
    test.slow()
    await signIn(page, tenant.users.op.username, /\/shop/)
    const checkout = await openShopCheckout(page)
    await checkout.getByLabel("Deliver to").click()
    // The rejected address is not offered; the approved one is.
    await expect(page.getByRole("option")).toHaveCount(2)
    await page.getByRole("option", { name: new RegExp(GATE_LABEL) }).click()
    await checkout.getByRole("button", { name: "Place Order" }).click()
    await expect(page.getByText("Order Submitted").first()).toBeVisible({ timeout: 150_000 })

    const [gate] = await readAddresses()
    const [order] = await queryTestDb<{ id: number; delivery_address_id: number | null; label: string | null }>(
      testDatabaseUrl(),
      `SELECT id, delivery_address_id, receipt_data ->> 'deliveryAddressLabel' AS label
         FROM orders WHERE organization_id = $1`,
      [tenant.organizationId],
    )
    expect(order).toEqual(expect.objectContaining({ delivery_address_id: gate.id, label: GATE_LABEL }))

    // The invoice exists once the order is approved; it prints where the goods go.
    const approver = await apiSession(browser, tenant.users.ba.username)
    try {
      await approveOrder(approver.page, order.id)
    } finally {
      await approver.close()
    }
    await page.goto(`/invoices/${order.id}`)
    await expect(page.getByText("Deliver to:")).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(new RegExp(GATE_LABEL, "i")).first()).toBeVisible()
  })
})

import { expect, test, type Page } from "@playwright/test"

import {
  apiSession,
  approveOrder,
  expectStatus,
  markDelivered,
  placeOrder,
  post,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { E2E_BASE_URL } from "./support/environment"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, type Tenant } from "./support/tenant"

/**
 * The invoice ledger, as a customer and Apricart see it
 * (`plans/OF-INVOICE-invoice-ledger.md`, the plan's E2E line):
 *
 *   approve → proforma, no number drawn
 *   in process → tax invoice, numbered from the series and dated today
 *                (plans/OF-INVOICE-issue-at-processing.md); delivery keeps it
 *   partial refund → numbered credit note, listed on the invoice and downloadable
 *   reprint → the invoice body is what was issued, whatever changed since
 *
 * The arithmetic, the races and the database's refusals are in
 * `lib/invoice-ledger*.test.ts` and `tests/integration/invoice-ledger*.test.ts`.
 * This proves the screens and the routes behind them carry it through.
 */

const KEY = "inv"
const CODE = tenantNames(KEY).code

let tenant: Tenant
let orderId: number

const karachiToday = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date())

async function invoiceRow(id: number) {
  const [row] = await queryTestDb<{ number: string; issue_date: string; status: string; total_cents: string; credited_total_cents: string }>(
    testDatabaseUrl(),
    "SELECT number, to_char(issue_date, 'YYYY-MM-DD') AS issue_date, status, total_cents, credited_total_cents FROM invoices WHERE order_id = $1",
    [id],
  )
  return row
}

async function sequenceValue(): Promise<number> {
  const [row] = await queryTestDb<{ last_value: number | null }>(
    testDatabaseUrl(),
    "SELECT last_value FROM invoice_sequences WHERE organization_id = $1",
    [tenant.organizationId],
  )
  return Number(row?.last_value ?? 0)
}

async function openInvoice(page: Page, id: number) {
  await page.goto(`/invoices/${id}`)
  const title = page.locator(".masthead-title")
  await expect(title).toBeVisible({ timeout: 150_000 })
  return title
}

test.describe.serial("the invoice ledger", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [
        { key: "north", budgetCents: 100_000_000, address: "Plot 1, Clifton", city: "Karachi" },
        { key: "south", budgetCents: 100_000_000 },
      ],
      users: [
        { key: "opn", role: "ORDER_PORTAL", branch: "north" },
        { key: "ban", role: "BRANCH_ADMIN", branch: "north" },
        { key: "ops", role: "ORDER_PORTAL", branch: "south" },
        { key: "ho", role: "HEAD_OFFICE" },
      ],
      products: [{ code: "TEA", name: "E2E Invoice Tea", priceCents: 1_180 }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("an approved order is a proforma, and no invoice number is drawn for it", async ({ page, browser }) => {
    test.slow()
    const before = await sequenceValue()
    const requester = await apiSession(browser, tenant.users.opn.username)
    const approver = await apiSession(browser, tenant.users.ban.username)
    try {
      const order = await placeOrder(requester.page, [{ organizationInventoryId: tenant.products.TEA.organizationInventoryId, quantity: 2 }])
      orderId = Number(order.id)
      await approveOrder(approver.page, orderId)
    } finally {
      await requester.close()
      await approver.close()
    }

    expect(await sequenceValue()).toBe(before)
    const [snapshot] = await queryTestDb<{ invoice: string | null }>(
      testDatabaseUrl(), "SELECT receipt_data ->> 'invoiceNumber' AS invoice FROM orders WHERE id = $1", [orderId],
    )
    expect(snapshot.invoice).toBeNull()

    await signIn(page, tenant.users.ho.username)
    const title = await openInvoice(page, orderId)
    await expect(title).toContainText("PROFORMA INVOICE")
    await expect(title).toContainText("Not a tax invoice")
    await expect(page.getByText("Issued when processed", { exact: true })).toBeVisible()
  })

  test("In Process issues the tax invoice, numbered from the series and dated today in Karachi; delivery keeps it", async ({ page, browser }) => {
    test.slow()
    const admin = await apiSession(browser, tenant.superAdmin.username)
    try {
      await expectStatus(await post(admin.page, `/api/v1/orders/${orderId}/fulfillment-status`, { fulfillmentStatus: "IN_PROCESS" }))
      const issued = await invoiceRow(orderId)
      expect(issued).toMatchObject({ number: `${CODE}-APR-000001`, issue_date: karachiToday(), status: "ISSUED" })

      await markDelivered(admin.page, orderId, { from: "IN_PROCESS" })
    } finally {
      await admin.close()
    }

    const invoice = await invoiceRow(orderId)
    expect(invoice).toMatchObject({ number: `${CODE}-APR-000001`, issue_date: karachiToday(), status: "ISSUED" })
    expect(Number(invoice.total_cents)).toBe(2_360)

    await signIn(page, tenant.users.ho.username)
    const title = await openInvoice(page, orderId)
    await expect(title).toContainText("INVOICE")
    await expect(title).not.toContainText("PROFORMA")
    await expect(page.getByText(`${CODE}-APR-000001`, { exact: true })).toBeVisible()
  })

  test("a partial refund issues a credit note the invoice lists and the customer can download", async ({ page, browser }) => {
    test.slow()
    const [item] = await queryTestDb<{ id: number }>(testDatabaseUrl(), "SELECT id FROM order_items WHERE order_id = $1", [orderId])
    const admin = await apiSession(browser, tenant.superAdmin.username)
    try {
      await expectStatus(await post(admin.page, `/api/v1/orders/${orderId}/refunds`, {
        items: [{ id: item.id, quantity: 1 }],
        reason: "One carton damaged",
      }))
    } finally {
      await admin.close()
    }

    const invoice = await invoiceRow(orderId)
    expect(invoice.status).toBe("PARTIALLY_CREDITED")
    expect(Number(invoice.credited_total_cents)).toBe(1_180)

    await signIn(page, tenant.users.ho.username)
    await openInvoice(page, orderId)
    const notes = page.getByRole("region", { name: "Credit notes" })
    await expect(notes).toContainText(`${CODE}-CN-000001`)
    // The invoice body still carries what was issued; the credit is listed beside it.
    await expect(page.locator(".payable-value")).toContainText("23.60")

    const downloading = page.waitForEvent("download")
    await notes.getByRole("button", { name: "Download" }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe(`credit-note-${CODE}-CN-000001.pdf`)
  })

  test("a reprint is the invoice that was issued, after the branch and organization change", async ({ page }) => {
    test.slow()
    await queryTestDb(testDatabaseUrl(), "UPDATE branches SET address = 'Moved Somewhere Else' WHERE id = $1", [tenant.branches.north.id])
    await queryTestDb(testDatabaseUrl(), "UPDATE organizations SET ntn_number = '7777777-7' WHERE id = $1", [tenant.organizationId])

    await signIn(page, tenant.users.ho.username)
    await openInvoice(page, orderId)
    await expect(page.getByText(`${CODE}-APR-000001`, { exact: true })).toBeVisible()
    await expect(page.getByText("Moved Somewhere Else")).toHaveCount(0)
    await expect(page.getByText("7777777-7")).toHaveCount(0)
  })

  test("a credit note is refused outside the order's reach", async ({ browser, playwright }) => {
    const [note] = await queryTestDb<{ id: number }>(
      testDatabaseUrl(),
      "SELECT cn.id FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id WHERE i.order_id = $1",
      [orderId],
    )
    const path = `/api/v1/receipts/${orderId}/credit-notes/${note.id}/download`

    const anonymous = await playwright.request.newContext({ baseURL: E2E_BASE_URL })
    try {
      expect((await anonymous.get(path)).status()).toBe(401)
    } finally {
      await anonymous.dispose()
    }

    // A requester at another branch of the same customer.
    const south = await apiSession(browser, tenant.users.ops.username)
    try {
      expect((await south.page.request.get(path)).status()).toBe(403)
    } finally {
      await south.close()
    }
  })
})

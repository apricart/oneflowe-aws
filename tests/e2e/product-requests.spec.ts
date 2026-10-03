import { expect, test } from "@playwright/test"

import { openFromSidebar } from "./support/admin-ui"
import { expectStatus, post, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * Head Office asks for a new product; Super Admin decides
 * (`plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`).
 *
 * The access rules and validation are in `tests/integration/product-requests-api.test.ts`
 * and the form's behaviour in the component tests. This is the round trip
 * across two portals: Head Office raises a request from the catalogue menu,
 * Super Admin finds it in the cross-tenant queue and approves it with a note,
 * Head Office reads the outcome — and approving it created no product, because
 * a request is information only.
 */

const KEY = "preq"
const PRODUCT_NAME = "E2E Requested Hand Sanitiser"
const REVIEW_NOTE = "Will be added as a catalogue product next week"

let tenant: Tenant

async function readRequests(): Promise<Array<{
  status: string
  brand: string | null
  expected_price_cents: number | null
  review_note: string | null
  estimated_available_on: unknown
}>> {
  return queryTestDb(
    testDatabaseUrl(),
    `SELECT status, brand, expected_price_cents, review_note, estimated_available_on FROM product_requests
      WHERE organization_id = $1 ORDER BY id`,
    [tenant.organizationId],
  )
}

test.describe.serial("product requests", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "main" }],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "main" },
      ],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Head Office raises a request from the catalogue menu", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.getByRole("button", { name: "Product Catalog" }).click()
    await openFromSidebar(page, "Product Requests")
    await expect(page.getByRole("heading", { name: "Product Requests" })).toBeVisible({ timeout: 150_000 })

    await page.getByRole("button", { name: "Request a product" }).click()
    const dialog = page.getByRole("dialog", { name: "Request a new product" })
    await dialog.getByLabel("Product name").fill(PRODUCT_NAME)
    await dialog.getByLabel("Brand / manufacturer").fill("Dettol")
    await dialog.getByLabel("Expected price per unit (PKR)").fill("450.50")
    await dialog.getByLabel("Estimated monthly quantity").fill("120")
    await dialog.getByRole("button", { name: "Send request" }).click()
    await expect(page.getByText("Request sent").first()).toBeVisible({ timeout: 150_000 })
    await expect(dialog).toBeHidden()

    const row = page.getByRole("row", { name: `Open request for ${PRODUCT_NAME}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText("Pending")
    expect(await readRequests()).toEqual([
      expect.objectContaining({ status: "PENDING", brand: "Dettol", expected_price_cents: 45_050 }),
    ])
  })

  test("Super Admin finds it in the queue and approves it with a note; no product is created", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/inventory/product-requests")
    const row = page.getByRole("row", { name: `Open request for ${PRODUCT_NAME}` })
    await expect(row).toBeVisible({ timeout: 150_000 })
    // Super Admin's queue spans tenants, so the row says whose request it is.
    await expect(row).toContainText(tenant.organizationName)

    await row.click()
    const detail = page.getByRole("dialog", { name: PRODUCT_NAME })
    await expect(detail).toBeVisible()
    await detail.getByLabel("Note to Head Office (optional)").fill(REVIEW_NOTE)
    // Approving needs the date the product is expected in the catalogue.
    await detail.getByRole("button", { name: "In 2 weeks" }).click()
    await detail.getByRole("button", { name: "Approve" }).click()
    await expect(page.getByText("Request approved").first()).toBeVisible({ timeout: 150_000 })

    await expect.poll(readRequests, { timeout: 150_000 }).toEqual([
      expect.objectContaining({ status: "APPROVED", review_note: REVIEW_NOTE, estimated_available_on: expect.anything() }),
    ])
    const products = await queryTestDb(testDatabaseUrl(), "SELECT id FROM global_products WHERE name = $1", [PRODUCT_NAME])
    expect(products).toHaveLength(0)
  })

  test("Head Office reads the decision and the note", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/inventory/product-requests")
    const row = page.getByRole("row", { name: `Open request for ${PRODUCT_NAME}` })
    await expect(row).toContainText("Approved", { timeout: 150_000 })
    await expect(row).toContainText("Expected by")
    await row.click()
    const detail = page.getByRole("dialog", { name: PRODUCT_NAME })
    await expect(detail.getByText(REVIEW_NOTE)).toBeVisible()
    await expect(detail.getByText(/Expected in the catalogue by/)).toBeVisible()
    // Head Office can read the decision but is never offered one.
    await expect(detail.getByRole("button", { name: "Approve" })).toHaveCount(0)
  })

  test("a Branch Admin is turned away by the page and by the endpoint", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ba.username, /\/dashboard/)
    await expect(page.getByText("Product Requests", { exact: true })).toHaveCount(0)
    await page.goto("/inventory/product-requests")
    await expect(page.getByText(/Access restricted|Product requests are available to/).first()).toBeVisible({ timeout: 150_000 })

    await expectStatus(await post(page, "/api/v1/product-requests", { productName: "Smuggled" }), 403)
    expect(await readRequests()).toHaveLength(1)
  })
})

import { expect, test } from "@playwright/test"

import { login } from "./support/auth"
import { queryE2E } from "./support/database"
import {
  E2E_BUDGET_CENTS,
  E2E_PRODUCT,
  E2E_SECONDARY_BRANCH,
  E2E_SECONDARY_ORGANIZATION,
  E2E_SECONDARY_PRODUCT,
  E2E_USERS,
} from "./support/fixtures"

test.describe.serial("Order Portal checkout and figures", () => {
  test("rejects an over-budget order without changing stock or ledgers", async ({ page }) => {
    await login(page, E2E_USERS.orderPortal, "/shop")

    const inventoryResponse = await page.request.get(
      "/api/v1/branch/inventory?visibility=visible",
    )
    expect(inventoryResponse.ok()).toBeTruthy()
    const inventory = await inventoryResponse.json()
    const product = inventory.items.find(
      (item: { productCode?: string }) => item.productCode === E2E_PRODUCT.code,
    )
    expect(product).toBeTruthy()

    const response = await page.evaluate(async (organizationInventoryId) => {
      const result = await fetch("/api/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "e2e-over-budget-order-0001",
        },
        body: JSON.stringify({
          items: [{ organizationInventoryId, quantity: 100 }],
        }),
      })

      return {
        status: result.status,
        body: await result.json(),
      }
    }, product.id)

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      error: expect.stringContaining("Insufficient budget"),
    })

    const [ledger] = await queryE2E<{
      stock_quantity: string
      amount_held_cents: string
      order_count: string
    }>(
      `
        SELECT
          gp.stock_quantity,
          b.amount_held_cents,
          (
            SELECT COUNT(*)
            FROM orders o
            JOIN users u ON u.id = o.created_by_user_id
            WHERE u.username = $1
          ) AS order_count
        FROM global_products gp
        JOIN organization_inventory oi ON oi.global_product_id = gp.id
        JOIN branch_inventory bi ON bi.organization_inventory_id = oi.id
        JOIN branches br ON br.id = bi.branch_id
        JOIN budgets b ON b.branch_id = br.id
        WHERE gp.product_code = $2
          AND b.period = TO_CHAR(NOW() AT TIME ZONE 'UTC', 'YYYY-MM')
        LIMIT 1
      `,
      [E2E_USERS.orderPortal, E2E_PRODUCT.code],
    )

    expect(Number(ledger.stock_quantity)).toBe(E2E_PRODUCT.startingStock)
    expect(Number(ledger.amount_held_cents)).toBe(0)
    expect(Number(ledger.order_count)).toBe(0)
  })

  test("ignores another tenant's branch parameters", async ({ page }) => {
    await login(page, E2E_USERS.orderPortal, "/shop")

    const [secondary] = await queryE2E<{
      organization_id: number
      branch_id: number
    }>(
      `
        SELECT o.id AS organization_id, b.id AS branch_id
        FROM organizations o
        JOIN branches b ON b.organization_id = o.id
        WHERE o.code = $1 AND b.code = $2
        LIMIT 1
      `,
      [E2E_SECONDARY_ORGANIZATION.code, E2E_SECONDARY_BRANCH.code],
    )

    const response = await page.request.get(
      `/api/v1/branch/inventory?organizationId=${secondary.organization_id}&branchId=${secondary.branch_id}&visibility=visible`,
    )
    expect(response.ok()).toBeTruthy()
    const body = await response.json()
    const names = body.items.map(
      (item: { customName?: string; productName: string }) =>
        item.customName || item.productName,
    )

    expect(names).toContain(E2E_PRODUCT.name)
    expect(names).not.toContain(E2E_SECONDARY_PRODUCT.name)
  })

  test("places an order and reconciles UI, API, and database figures", async ({ page }) => {
    await login(page, E2E_USERS.orderPortal, "/shop")
    await expect(page.getByRole("heading", { name: "Order Portal" })).toBeVisible()
    await expect(page.getByText("PKR 1000.00", { exact: true })).toBeVisible()

    const search = page.getByPlaceholder("Search products by name or code...")
    await search.fill(E2E_PRODUCT.code)

    const productCard = page
      .locator("div.group.cursor-pointer")
      .filter({ hasText: E2E_PRODUCT.name })
    await expect(productCard).toBeVisible()
    await expect(productCard.getByText("PKR 12.50", { exact: true })).toBeVisible()
    await productCard.getByRole("button", { name: "Add 1 to Cart" }).click()

    await page.getByRole("button", { name: /Checkout/ }).click()
    await expect(page.getByRole("dialog", { name: "Cart" })).toBeVisible()
    await page.getByRole("button", { name: "Proceed to checkout" }).click()

    const confirmation = page.getByRole("dialog", { name: "Order Confirmation" })
    await expect(confirmation.getByText(`${E2E_PRODUCT.name} x1`)).toBeVisible()
    await expect(confirmation.getByText("PKR 12.50", { exact: true })).toHaveCount(2)
    await expect(
      confirmation.getByText("Remaining Budget: PKR 987.50"),
    ).toBeVisible()

    const orderResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/orders") &&
        response.request().method() === "POST",
    )
    await confirmation.getByRole("button", { name: "Place Order" }).click()
    const orderResponse = await orderResponsePromise
    expect(orderResponse.ok()).toBeTruthy()
    const orderPayload = await orderResponse.json()
    expect(orderPayload.order).toMatchObject({
      status: "PENDING",
      subtotalCents: E2E_PRODUCT.priceCents,
      taxCents: 0,
      totalCents: E2E_PRODUCT.priceCents,
    })

    await expect(page.getByText("Order Submitted", { exact: true })).toBeVisible()
    await expect(page.getByText("PKR 987.50", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: /Active Orders/ }).click()
    await expect(page.getByText("Awaiting Approval")).toBeVisible()
    await expect(
      page.getByText(`Order ${orderPayload.order.tid}`, { exact: true }),
    ).toBeVisible()
    await expect(page.getByText("PKR 12.50", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "View Details" }).click()
    const orderDetails = page.getByRole("dialog", { name: "Order Details" })
    await expect(orderDetails.getByText(E2E_PRODUCT.name)).toBeVisible()

    const [ledger] = await queryE2E<{
      subtotal_cents: string
      tax_cents: string
      total_cents: string
      receipt_data: {
        subtotal: number
        tax: number
        totalAmount: number
      } | null
      quantity: string
      price_cents: string
      stock_quantity: string
      amount_allocated_cents: string
      amount_spent_cents: string
      amount_held_cents: string
      amount_credited_cents: string
    }>(
      `
        SELECT
          o.subtotal_cents,
          o.tax_cents,
          o.total_cents,
          o.receipt_data,
          oi.quantity,
          oi.price_cents,
          gp.stock_quantity,
          b.amount_allocated_cents,
          b.amount_spent_cents,
          b.amount_held_cents,
          b.amount_credited_cents
        FROM orders o
        JOIN users u ON u.id = o.created_by_user_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN global_products gp ON gp.id = oi.global_product_id
        JOIN budgets b
          ON b.branch_id = o.branch_id
         AND b.period = TO_CHAR(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        WHERE u.username = $1
        ORDER BY o.created_at DESC
        LIMIT 1
      `,
      [E2E_USERS.orderPortal],
    )

    const allocated = Number(ledger.amount_allocated_cents)
    const credited = Number(ledger.amount_credited_cents)
    const spent = Number(ledger.amount_spent_cents)
    const held = Number(ledger.amount_held_cents)
    const remaining = allocated + credited - spent - held

    expect(Number(ledger.quantity)).toBe(1)
    expect(Number(ledger.price_cents)).toBe(E2E_PRODUCT.priceCents)
    expect(Number(ledger.subtotal_cents)).toBe(E2E_PRODUCT.priceCents)
    expect(Number(ledger.tax_cents)).toBe(0)
    expect(Number(ledger.total_cents)).toBe(E2E_PRODUCT.priceCents)
    expect(Number(ledger.stock_quantity)).toBe(E2E_PRODUCT.startingStock - 1)
    expect(allocated).toBe(E2E_BUDGET_CENTS)
    expect(held).toBe(E2E_PRODUCT.priceCents)
    expect(remaining).toBe(E2E_BUDGET_CENTS - E2E_PRODUCT.priceCents)
    expect(ledger.receipt_data).toMatchObject({
      subtotal: E2E_PRODUCT.priceCents / 100,
      tax: 0,
      totalAmount: E2E_PRODUCT.priceCents / 100,
    })
  })

  test("edits a pending order and reconciles its existing reservations", async ({ page }) => {
    await login(page, E2E_USERS.orderPortal, "/shop")
    await page.getByRole("button", { name: /Active Orders/ }).click()

    await page.getByRole("button", { name: "Edit Order" }).first().click()
    const cart = page.getByRole("dialog", { name: /Edit Order/ })
    await expect(cart).toBeVisible()
    await expect(page.getByRole("heading", { name: "Products" })).toHaveCount(0)
    await expect(cart.getByRole("button", { name: "Add products" })).toBeVisible()
    await cart.getByRole("button", { name: `Increase ${E2E_PRODUCT.name} quantity` }).click()
    await cart.getByRole("button", { name: "Review changes" }).click()

    const confirmation = page.getByRole("dialog", { name: "Confirm Order Changes" })
    await expect(confirmation.getByText(`${E2E_PRODUCT.name} x2`)).toBeVisible()

    const updateResponsePromise = page.waitForResponse(
      (response) =>
        /\/api\/v1\/orders\/\d+$/.test(new URL(response.url()).pathname)
        && response.request().method() === "PUT",
    )
    await confirmation.getByRole("button", { name: "Save Changes" }).click()
    const updateResponse = await updateResponsePromise
    expect(updateResponse.ok()).toBeTruthy()
    const updatePayload = await updateResponse.json()
    expect(updatePayload.order).toMatchObject({
      status: "PENDING",
      subtotalCents: E2E_PRODUCT.priceCents * 2,
      totalCents: E2E_PRODUCT.priceCents * 2,
    })

    await expect(page.getByText("Order Updated", { exact: true })).toBeVisible()
    await expect(page.getByText("PKR 975.00", { exact: true })).toBeVisible()

    const [ledger] = await queryE2E<{
      quantity: string
      stock_quantity: string
      amount_held_cents: string
      receipt_data: { subtotal: number; totalAmount: number } | null
      audit_count: string
    }>(
      `
        SELECT
          oi.quantity,
          gp.stock_quantity,
          b.amount_held_cents,
          o.receipt_data,
          (
            SELECT COUNT(*)
            FROM audit_logs al
            WHERE al.entity = 'order'
              AND al.entity_id = o.id::text
              AND al.action = 'ORDER_EDITED'
          ) AS audit_count
        FROM orders o
        JOIN users u ON u.id = o.created_by_user_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN global_products gp ON gp.id = oi.global_product_id
        JOIN budgets b
          ON b.branch_id = o.branch_id
         AND b.period = TO_CHAR(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        WHERE u.username = $1
        ORDER BY o.created_at DESC
        LIMIT 1
      `,
      [E2E_USERS.orderPortal],
    )

    expect(Number(ledger.quantity)).toBe(2)
    expect(Number(ledger.stock_quantity)).toBe(E2E_PRODUCT.startingStock - 2)
    expect(Number(ledger.amount_held_cents)).toBe(E2E_PRODUCT.priceCents * 2)
    expect(Number(ledger.audit_count)).toBe(1)
    expect(ledger.receipt_data).toMatchObject({
      subtotal: (E2E_PRODUCT.priceCents * 2) / 100,
      totalAmount: (E2E_PRODUCT.priceCents * 2) / 100,
    })
  })

  test("blocks the creator from editing after approval", async ({ page }) => {
    const [approvedOrder] = await queryE2E<{
      id: number
      organization_inventory_id: number
    }>(
      `
        UPDATE orders
        SET status = 'APPROVED', approved_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT o.id
          FROM orders o
          JOIN users u ON u.id = o.created_by_user_id
          WHERE u.username = $1
          ORDER BY o.created_at DESC
          LIMIT 1
        )
        RETURNING
          id,
          (
            SELECT oi.organization_inventory_id
            FROM order_items oi
            WHERE oi.order_id = orders.id
            LIMIT 1
          ) AS organization_inventory_id
      `,
      [E2E_USERS.orderPortal],
    )

    await login(page, E2E_USERS.orderPortal, "/shop")
    await page.getByRole("button", { name: /Active Orders/ }).click()
    await expect(page.getByText("Active", { exact: true }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Edit Order" })).toHaveCount(0)

    const response = await page.evaluate(async (input) => {
      const result = await fetch(`/api/v1/orders/${input.orderId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{
            organizationInventoryId: input.organizationInventoryId,
            quantity: 3,
          }],
        }),
      })
      return { status: result.status, body: await result.json() }
    }, {
      orderId: approvedOrder.id,
      organizationInventoryId: approvedOrder.organization_inventory_id,
    })
    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      error: expect.stringContaining("Only pending orders can be edited"),
    })

    const [unchanged] = await queryE2E<{
      status: string
      quantity: string
      stock_quantity: string
      amount_held_cents: string
    }>(
      `
        SELECT o.status, oi.quantity, gp.stock_quantity, b.amount_held_cents
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN global_products gp ON gp.id = oi.global_product_id
        JOIN budgets b
          ON b.branch_id = o.branch_id
         AND b.period = TO_CHAR(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM')
        WHERE o.id = $1
      `,
      [approvedOrder.id],
    )
    expect(unchanged.status).toBe("APPROVED")
    expect(Number(unchanged.quantity)).toBe(2)
    expect(Number(unchanged.stock_quantity)).toBe(E2E_PRODUCT.startingStock - 2)
    expect(Number(unchanged.amount_held_cents)).toBe(E2E_PRODUCT.priceCents * 2)
  })
})

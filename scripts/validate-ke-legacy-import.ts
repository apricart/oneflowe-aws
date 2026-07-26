import { readFileSync } from "fs"
import { resolve } from "path"
import * as dotenv from "dotenv"
import { KE_ORGANIZATION, LEGACY_SOURCE, prepareKeLegacySource } from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const EXPECTED_ACTOR_ID = "3c0d853b-1296-4b30-b68d-fd27696e9222"
const EXPECTED_MANIFEST = "9d899a39e3a6adc2df236fc3ec629d69b981a837c2b54e588c783e29c9de58ba"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function main() {
  const snapshotPath = resolve(process.argv[2] || "backups/ke-import-state-2026-07-13-pre-migration.json")
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, any>
  const source = prepareKeLegacySource()
  const expected = source.prepared.reduce((totals, order) => ({
    orders: totals.orders + 1,
    items: totals.items + order.lines.length,
    quantity: totals.quantity + order.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents: totals.subtotalCents + order.subtotalCents,
    taxCents: totals.taxCents + order.taxCents,
    totalCents: totals.totalCents + order.totalCents,
  }), { orders: 0, items: 0, quantity: 0, subtotalCents: 0, taxCents: 0, totalCents: 0 })

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const batchResult = await client.query(`
      select id, organization_id, source_system, source_manifest, status, counts,
             imported_by_user_id, created_at, completed_at
      from legacy_import_batches
      where organization_id = $1 and source_system = $2
      order by created_at desc
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE])
    assert(batchResult.rows.length === 1, `Expected exactly one K-Electric import batch, found ${batchResult.rows.length}`)
    const batch = batchResult.rows[0]
    assert(batch.status === "COMPLETED", `Batch status is ${batch.status}`)
    assert(batch.imported_by_user_id === EXPECTED_ACTOR_ID, "Unexpected import actor")
    assert(batch.source_manifest?.digest === EXPECTED_MANIFEST, "Batch manifest digest mismatch")
    assert(Number(batch.counts?.orders) === expected.orders, "Batch order count metadata mismatch")
    assert(Number(batch.counts?.newProducts) === 144, "Batch new-product count metadata mismatch")
    assert(Number(batch.counts?.newHistoricalUsers) === 4, "Batch historical-user count metadata mismatch")

    const orderStats = (await client.query(`
      select count(distinct o.id)::int as orders,
             count(oi.id)::int as items,
             coalesce(sum(oi.quantity), 0)::text as quantity,
             coalesce(sum(round(oi.quantity * oi.price_cents)), 0)::text as subtotal_cents
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join order_items oi on oi.order_id = o.id
      where loi.batch_id = $1
    `, [batch.id])).rows[0]
    // Tax/total need an order-level query because the item join fans orders out.
    const financialStats = (await client.query(`
      select count(*)::int as orders,
             coalesce(sum(o.subtotal_cents), 0)::text as subtotal_cents,
             coalesce(sum(o.tax_cents), 0)::text as tax_cents,
             coalesce(sum(o.total_cents), 0)::text as total_cents
      from legacy_order_imports loi join orders o on o.id = loi.order_id
      where loi.batch_id = $1
    `, [batch.id])).rows[0]
    assert(orderStats.orders === expected.orders, `Order count mismatch: ${orderStats.orders}`)
    assert(orderStats.items === expected.items, `Item count mismatch: ${orderStats.items}`)
    assert(Number(orderStats.quantity) === expected.quantity, `Quantity mismatch: ${orderStats.quantity}`)
    assert(Number(orderStats.subtotal_cents) === expected.subtotalCents, "Item subtotal mismatch")
    assert(financialStats.orders === expected.orders, "Financial order count mismatch")
    assert(Number(financialStats.subtotal_cents) === expected.subtotalCents, "Order subtotal mismatch")
    assert(Number(financialStats.tax_cents) === expected.taxCents, "Tax mismatch")
    assert(Number(financialStats.total_cents) === expected.totalCents, "Grand total mismatch")

    const violations = (await client.query(`
      select count(*)::int as count
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join users u on u.id = o.created_by_user_id
      join roles r on r.id = u.role_id
      where loi.batch_id = $1 and (
        loi.organization_id <> $2 or o.organization_id <> $2 or b.organization_id <> $2
        or u.organization_id <> $2 or u.branch_id <> o.branch_id or r.name <> 'ORDER_PORTAL'
        or o.status <> 'FULFILLED' or o.fulfillment_status <> 'DELIVERED'
        or o.payment_status <> 'UNPAID' or o.refund_amount_cents is not null
        or o.receipt_data is null or o.tid <> 'KE-LEGACY-' || loi.legacy_order_id::text
      )
    `, [batch.id, KE_ORGANIZATION.id])).rows[0].count
    assert(violations === 0, `Found ${violations} tenant/order-state violations`)

    const catalog = (await client.query(`
      select
        (select count(*)::int from legacy_product_mappings where organization_id = $1 and source_system = $2) as product_mappings,
        (select count(*)::int from organization_inventory where organization_id = $1 and deleted_at is null) as organization_inventory,
        (select count(*)::int from branch_inventory where organization_id = $1 and deleted_at is null) as branch_inventory,
        (select count(*)::int from global_products where metadata->>'legacySource' = $2) as new_products,
        (select count(*)::int from global_products where metadata->>'legacySource' = $2 and (status <> 'inactive' or stock_quantity <> 0 or deleted_at is not null)) as unsafe_new_products,
        (select count(*)::int from legacy_user_mappings where organization_id = $1 and source_system = $2) as user_mappings,
        (select count(*)::int from legacy_user_mappings where organization_id = $1 and source_system = $2 and is_synthetic = true) as synthetic_users,
        (select count(*)::int from legacy_user_mappings lum join users u on u.id = lum.user_id where lum.organization_id = $1 and lum.source_system = $2 and lum.is_synthetic = true and (u.is_active = true or u.organization_id <> $1 or u.branch_id <> lum.branch_id)) as unsafe_synthetic_users
    `, [KE_ORGANIZATION.id, LEGACY_SOURCE])).rows[0]
    assert(catalog.product_mappings === 145, `Product mapping count mismatch: ${catalog.product_mappings}`)
    assert(catalog.organization_inventory === 145, `Organization inventory count mismatch: ${catalog.organization_inventory}`)
    assert(catalog.new_products === 144, `New product count mismatch: ${catalog.new_products}`)
    assert(catalog.unsafe_new_products === 0, "New product status/stock safety check failed")
    assert(catalog.synthetic_users === 4, `Synthetic user count mismatch: ${catalog.synthetic_users}`)
    assert(catalog.unsafe_synthetic_users === 0, "Synthetic user tenant/branch/active safety check failed")

    const reporting = (await client.query(`
      select
        count(distinct o.branch_id)::int as branches_with_orders,
        count(distinct b.group_id)::int as groups_with_orders,
        count(*) filter (where b.group_id is null)::int as orders_without_group,
        count(distinct o.created_by_user_id)::int as users_with_orders,
        count(distinct oi.global_product_id)::int as products_with_orders
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join branches b on b.id = o.branch_id
      join order_items oi on oi.order_id = o.id
      where loi.batch_id = $1
    `, [batch.id])).rows[0]
    assert(reporting.orders_without_group === 0, "Imported orders include branches without a reporting group")
    assert(reporting.products_with_orders === 145, "Product-report coverage mismatch")

    const operational = {
      budgets: (await client.query("select * from budgets where organization_id = $1 order by id", [KE_ORGANIZATION.id])).rows,
      quantityBudgets: (await client.query("select * from product_quantity_budgets where organization_id = $1 order by id", [KE_ORGANIZATION.id])).rows,
      invoiceSequence: (await client.query("select * from invoice_sequences where organization_id = $1", [KE_ORGANIZATION.id])).rows,
    }
    assert(JSON.stringify(operational.budgets) === JSON.stringify(snapshot.budgets), "Money budgets changed")
    assert(JSON.stringify(operational.quantityBudgets) === JSON.stringify(snapshot.quantityBudgets), "Quantity budgets changed")
    assert(JSON.stringify(operational.invoiceSequence) === JSON.stringify(snapshot.invoiceSequence), "Invoice sequence changed")

    const existingProductIds = snapshot.globalProducts.map((product: any) => Number(product.id))
    const currentExistingProducts = (await client.query(`
      select id, product_code, name, category_id, base_price_cents, unit, status, stock_quantity, deleted_at, created_at, updated_at
      from global_products where id = any($1::int[]) order by id
    `, [existingProductIds])).rows
    const changedExistingProducts = snapshot.globalProducts.flatMap((before: any, index: number) => {
      const after = currentExistingProducts[index]
      return JSON.stringify(after) === JSON.stringify(before)
        ? []
        : [{ id: before.id, before, after: after ?? null }]
    })
    assert(
      changedExistingProducts.length === 0,
      `A pre-existing global product changed: ${JSON.stringify(changedExistingProducts)}`,
    )

    await client.query("commit")
    console.log(JSON.stringify({
      status: "PASS",
      batchId: batch.id,
      actorUserId: batch.imported_by_user_id,
      manifestDigest: batch.source_manifest.digest,
      orders: expected.orders,
      items: expected.items,
      quantity: expected.quantity,
      subtotalCents: expected.subtotalCents,
      taxCents: expected.taxCents,
      totalCents: expected.totalCents,
      productMappings: catalog.product_mappings,
      organizationInventory: catalog.organization_inventory,
      branchInventory: catalog.branch_inventory,
      newProducts: catalog.new_products,
      userMappings: catalog.user_mappings,
      syntheticUsers: catalog.synthetic_users,
      branchesWithOrders: reporting.branches_with_orders,
      groupsWithOrders: reporting.groups_with_orders,
      usersWithOrders: reporting.users_with_orders,
      productsWithOrders: reporting.products_with_orders,
      operationalLedgersUnchanged: true,
      preExistingProductsUnchanged: true,
    }, null, 2))
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

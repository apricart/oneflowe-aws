#!/usr/bin/env tsx

import { createHash } from "crypto"
import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import type { PoolClient } from "pg"
import * as dotenv from "dotenv"
import {
  KE_PRODUCT_CODE_MIGRATION as CONFIG,
  buildKeProductCodeMappingPayload,
  expectedKeProductCode,
  sha256Json,
  type KeProductCodeMapping,
} from "../lib/legacy-import/ke-product-codes"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRecord = Record<string, any>

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function number(value: unknown): number {
  const parsed = Number(value)
  assert(Number.isFinite(parsed), `Expected number, received ${String(value)}`)
  return parsed
}

function normalized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertRowsEqual(section: string, expectedValue: unknown[], actualValue: unknown[]): void {
  const expected = normalized(expectedValue)
  const actual = normalized(actualValue)
  if (JSON.stringify(expected) === JSON.stringify(actual)) return

  const limit = Math.max(expected.length, actual.length)
  let mismatchIndex = 0
  while (mismatchIndex < limit && JSON.stringify(expected[mismatchIndex]) === JSON.stringify(actual[mismatchIndex])) {
    mismatchIndex += 1
  }
  const expectedRow = expected[mismatchIndex] as JsonRecord | undefined
  const actualRow = actual[mismatchIndex] as JsonRecord | undefined
  throw new Error(
    `${section} differs from the immediate pre-change snapshot at index ${mismatchIndex}`
      + ` (expected id ${String(expectedRow?.id ?? "missing")}, actual id ${String(actualRow?.id ?? "missing")})`,
  )
}

async function one(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRecord> {
  const result = await client.query(text, params)
  assert(result.rows.length === 1, `Expected one row, found ${result.rows.length}`)
  return result.rows[0]
}

async function validateImmediateBaseline(client: PoolClient, baseline: JsonRecord, fileSha256: string): Promise<JsonRecord> {
  assert(baseline.kind === "KE_IMPORT_PRE_MIGRATION_SAFETY_SNAPSHOT", "Invalid immediate baseline snapshot kind")
  assert(number(baseline.organizationId) === CONFIG.organization.id, "Immediate baseline belongs to another organization")
  assert(Array.isArray(baseline.globalProducts) && Array.isArray(baseline.orderItems), "Immediate baseline is incomplete")

  const targetIds = new Set(Array.from(
    { length: CONFIG.productCount },
    (_, index) => CONFIG.firstProductId + index,
  ))

  const productIds = baseline.globalProducts.map((row: JsonRecord) => number(row.id))
  const actualProducts = normalized((await client.query(`
    select id, product_code, name, category_id, base_price_cents, unit, status,
           stock_quantity, deleted_at, created_at, updated_at
    from global_products where id = any($1::int[]) order by id
  `, [productIds])).rows)
  const expectedProducts = normalized(baseline.globalProducts).map((row: JsonRecord, index: number) => {
    if (!targetIds.has(number(row.id))) return row
    return {
      ...row,
      product_code: expectedKeProductCode(number(row.id)),
      // Updating the catalog code intentionally advances only these rows' timestamps.
      updated_at: actualProducts[index]?.updated_at,
    }
  })
  assertRowsEqual("globalProducts", expectedProducts, actualProducts)

  const orderItemIds = baseline.orderItems.map((row: JsonRecord) => number(row.id))
  const actualOrderItems = normalized((await client.query(`
    select id, organization_id, organization_inventory_id, order_id, global_product_id,
           product_name, product_code, unit, quantity, price_cents, created_at
    from order_items where id = any($1::int[]) order by id
  `, [orderItemIds])).rows)
  const expectedOrderItems = normalized(baseline.orderItems).map((row: JsonRecord) => targetIds.has(number(row.global_product_id))
    ? { ...row, product_code: expectedKeProductCode(number(row.global_product_id)) }
    : row)
  assertRowsEqual("orderItems", expectedOrderItems, actualOrderItems)

  const exactSections: Array<{
    name: string
    baselineRows: JsonRecord[]
    query: string
    ids: unknown[]
  }> = [
    {
      name: "branches",
      baselineRows: baseline.branches,
      query: "select id, organization_id, name, code, status, group_id, baseline_budget_cents, updated_at from branches where id = any($1::int[]) order by id",
      ids: baseline.branches.map((row: JsonRecord) => row.id),
    },
    {
      name: "users",
      baselineRows: baseline.users,
      query: "select u.id, u.organization_id, u.branch_id, u.username, u.full_name, u.employee_id, u.role_id, r.name as role_name, u.is_active, u.deleted_at, u.created_at, u.updated_at from users u join roles r on r.id = u.role_id where u.id = any($1::uuid[]) order by u.id",
      ids: baseline.users.map((row: JsonRecord) => row.id),
    },
    {
      name: "organizationInventory",
      baselineRows: baseline.organizationInventory,
      query: "select * from organization_inventory where id = any($1::int[]) order by id",
      ids: baseline.organizationInventory.map((row: JsonRecord) => row.id),
    },
    {
      name: "branchInventory",
      baselineRows: baseline.branchInventory,
      query: "select * from branch_inventory where id = any($1::int[]) order by id",
      ids: baseline.branchInventory.map((row: JsonRecord) => row.id),
    },
    {
      name: "groups",
      baselineRows: baseline.groups,
      query: "select * from groups where id = any($1::int[]) order by id",
      ids: baseline.groups.map((row: JsonRecord) => row.id),
    },
    {
      name: "orders",
      baselineRows: baseline.orders,
      query: "select id, tid, organization_id, branch_id, status, fulfillment_status, payment_status, subtotal_cents, tax_cents, total_cents, created_by_user_id, created_at, fulfilled_at, updated_at from orders where id = any($1::int[]) order by id",
      ids: baseline.orders.map((row: JsonRecord) => row.id),
    },
    {
      name: "budgets",
      baselineRows: baseline.budgets,
      query: "select * from budgets where id = any($1::int[]) order by id",
      ids: baseline.budgets.map((row: JsonRecord) => row.id),
    },
    {
      name: "quantityBudgets",
      baselineRows: baseline.quantityBudgets,
      query: "select * from product_quantity_budgets where id = any($1::int[]) order by id",
      ids: baseline.quantityBudgets.map((row: JsonRecord) => row.id),
    },
  ]
  for (const section of exactSections) {
    if (section.baselineRows.length === 0) continue
    const currentRows = (await client.query(section.query, [section.ids])).rows
    assertRowsEqual(section.name, section.baselineRows, currentRows)
  }

  const currentOrganization = (await client.query(
    "select id, name, code, status, created_at, updated_at from organizations where id = $1",
    [CONFIG.organization.id],
  )).rows
  assertRowsEqual("organization", baseline.organization, currentOrganization)
  const currentInvoiceSequence = (await client.query(
    "select * from invoice_sequences where organization_id = $1",
    [CONFIG.organization.id],
  )).rows
  assertRowsEqual("invoiceSequence", baseline.invoiceSequence, currentInvoiceSequence)

  return {
    generatedAt: baseline.generatedAt,
    fileSha256,
    globalProducts: baseline.globalProducts.length,
    organizationInventory: baseline.organizationInventory.length,
    branchInventory: baseline.branchInventory.length,
    orders: baseline.orders.length,
    orderItems: baseline.orderItems.length,
  }
}

async function protectedBehaviorDigest(client: PoolClient): Promise<string> {
  const targetIds = Array.from({ length: CONFIG.productCount }, (_, index) => CONFIG.firstProductId + index)
  const queries: Record<string, { text: string; params?: unknown[] }> = {
    targetProductsWithoutCodes: {
      text: `select id, name, description, category_id, image_url, base_price_cents,
                    discount_type, discount_value_cents, discount_start_at, discount_end_at,
                    discount_active, unit, status, stock_quantity, allow_decimal_quantity,
                    quantity_step, metadata, created_by_user_id, created_at, last_synced_at, deleted_at
             from global_products where id = any($1::int[]) order by id`,
      params: [targetIds],
    },
    importedItemsWithoutCodes: {
      text: `select oi.id, oi.organization_id, oi.organization_inventory_id, oi.order_id,
                    oi.global_product_id, oi.product_name, oi.unit, oi.quantity,
                    oi.price_cents, oi.created_at
             from legacy_order_imports loi join order_items oi on oi.order_id = loi.order_id
             where loi.batch_id = $1 and oi.global_product_id = any($2::int[])
             order by oi.id`,
      params: [CONFIG.importBatchId, targetIds],
    },
    targetOrganizationInventoryExceptRemovedRow: {
      text: `select * from organization_inventory
             where global_product_id = any($1::int[]) and id <> $2 order by id`,
      params: [targetIds, CONFIG.ublAssignment.id],
    },
    targetBranchInventory: {
      text: `select bi.* from branch_inventory bi
             join organization_inventory oi on oi.id = bi.organization_inventory_id
             where oi.global_product_id = any($1::int[]) order by bi.id`,
      params: [targetIds],
    },
    targetQuantityBudgets: {
      text: `select * from product_quantity_budgets where global_product_id = any($1::int[]) order by id`,
      params: [targetIds],
    },
    targetQuantityAllocations: {
      text: `select * from product_quantity_budget_allocations where global_product_id = any($1::int[]) order by id`,
      params: [targetIds],
    },
    targetParallelOrganizationProducts: {
      text: `select * from organization_products where global_product_id = any($1::int[]) order by id`,
      params: [targetIds],
    },
    targetParallelBranchProducts: {
      text: `select * from branch_products where global_product_id = any($1::int[]) order by id`,
      params: [targetIds],
    },
    targetRestockRequests: {
      text: `select * from restock_requests where global_product_id = any($1::int[]) order by id`,
      params: [targetIds],
    },
  }
  const sections: JsonRecord = {}
  for (const [name, query] of Object.entries(queries)) {
    sections[name] = normalized((await client.query(query.text, query.params ?? [])).rows)
  }
  return sha256Json(sections)
}

async function main(): Promise<void> {
  const commitReportPath = arg("--commit-report")
  const baselinePath = arg("--baseline")
  const commitReport = commitReportPath
    ? JSON.parse(readFileSync(resolve(commitReportPath), "utf8")) as JsonRecord
    : null
  const baselineAbsolutePath = baselinePath ? resolve(baselinePath) : null
  const baselineRaw = baselineAbsolutePath ? readFileSync(baselineAbsolutePath, "utf8") : null
  const baseline = baselineRaw ? JSON.parse(baselineRaw) as JsonRecord : null
  let baselineFileSha256: string | null = null
  if (baselineAbsolutePath && baselineRaw) {
    const sidecarPath = `${baselineAbsolutePath}.sha256`
    assert(existsSync(sidecarPath), `Immediate baseline checksum sidecar is missing: ${sidecarPath}`)
    const expectedSha256 = readFileSync(sidecarPath, "utf8").trim().split(/\s+/)[0]?.toLowerCase()
    baselineFileSha256 = createHash("sha256").update(baselineRaw).digest("hex")
    assert(/^[a-f0-9]{64}$/.test(expectedSha256), "Immediate baseline checksum sidecar is invalid")
    assert(baselineFileSha256 === expectedSha256, "Immediate baseline checksum does not match its sidecar")
  }
  if (commitReport) {
    assert(commitReport.kind === "KE_LEGACY_PRODUCT_CODE_RENUMBER_COMMIT" && commitReport.status === "COMPLETED", "Invalid product-code commit report")
    const payload = buildKeProductCodeMappingPayload(commitReport.mappings, commitReport.removedUblAssignment)
    assert(sha256Json(payload) === commitReport.mappingDigest, "Commit report mapping digest is invalid")
  }

  const targetIds = Array.from({ length: CONFIG.productCount }, (_, index) => CONFIG.firstProductId + index)
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    const organization = await one(client, `select id, code, name, status from organizations where id = $1`, [CONFIG.organization.id])
    assert(organization.code === CONFIG.organization.code && organization.name === CONFIG.organization.name && organization.status === "active", "K-Electric organization safety check failed")
    const baselineValidation = baseline && baselineFileSha256
      ? await validateImmediateBaseline(client, baseline, baselineFileSha256)
      : null

    const products = (await client.query(`
      select gp.id, gp.name, gp.product_code, gp.status, gp.stock_quantity::text,
             gp.deleted_at, gp.metadata
      from legacy_product_mappings lpm join global_products gp on gp.id = lpm.global_product_id
      where lpm.organization_id = $1 and lpm.source_system = $2
        and gp.metadata->>'legacySource' = $2 and gp.metadata->>'historicalOnly' = 'true'
      order by gp.id
    `, [CONFIG.organization.id, CONFIG.sourceSystem])).rows
    assert(products.length === CONFIG.productCount, `Expected ${CONFIG.productCount} products, found ${products.length}`)
    for (let index = 0; index < products.length; index += 1) {
      const product = products[index]
      const expectedId = CONFIG.firstProductId + index
      assert(product.id === expectedId, `Product ID sequence mismatch at ${product.id}`)
      assert(product.product_code === expectedKeProductCode(product.id), `Product ${product.id} has code ${product.product_code}`)
      assert(product.status === "inactive" && number(product.stock_quantity) === 0 && product.deleted_at === null, `Product ${product.id} operational state changed`)
    }

    const itemStats = await one(client, `
      select count(*)::int items,
             count(*) filter (where oi.product_code <> gp.product_code)::int code_mismatches,
             count(*) filter (where oi.product_code like 'LEG-KE-%')::int legacy_codes,
             coalesce(sum(oi.quantity),0)::text quantity,
             coalesce(sum(round(oi.quantity * oi.price_cents)),0)::text revenue_cents
      from legacy_order_imports loi
      join order_items oi on oi.order_id = loi.order_id
      join global_products gp on gp.id = oi.global_product_id
      where loi.batch_id = $1 and loi.organization_id = $2 and oi.organization_id = $2
        and oi.global_product_id = any($3::int[])
    `, [CONFIG.importBatchId, CONFIG.organization.id, targetIds])
    assert(itemStats.items === CONFIG.renamedItemCount, "Renumbered order-item count mismatch")
    assert(itemStats.code_mismatches === 0 && itemStats.legacy_codes === 0, "Imported order-item codes are inconsistent")
    assert(number(itemStats.quantity) === CONFIG.renamedItemQuantity, "Renumbered item quantity mismatch")
    assert(number(itemStats.revenue_cents) === CONFIG.renamedItemRevenueCents, "Renumbered item revenue mismatch")

    const allImportStats = await one(client, `
      select count(distinct o.id)::int orders, count(oi.id)::int items,
             coalesce(sum(oi.quantity),0)::text quantity,
             coalesce(sum(round(oi.quantity * oi.price_cents)),0)::text subtotal_cents
      from legacy_order_imports loi join orders o on o.id = loi.order_id
      join order_items oi on oi.order_id = o.id where loi.batch_id = $1
    `, [CONFIG.importBatchId])
    const financialStats = await one(client, `
      select count(*)::int orders, coalesce(sum(o.subtotal_cents),0)::text subtotal_cents,
             coalesce(sum(o.tax_cents),0)::text tax_cents,
             coalesce(sum(o.total_cents),0)::text total_cents
      from legacy_order_imports loi join orders o on o.id = loi.order_id
      where loi.batch_id = $1
    `, [CONFIG.importBatchId])
    assert(allImportStats.orders === CONFIG.importedOrderCount && allImportStats.items === CONFIG.importedItemCount, "Full import order/item counts changed")
    assert(number(allImportStats.quantity) === 41_199 && number(allImportStats.subtotal_cents) === 4_115_178_900, "Full import quantity/revenue changed")
    assert(financialStats.orders === CONFIG.importedOrderCount, "Full import financial order count changed")
    assert(number(financialStats.subtotal_cents) === 4_115_178_900, "Full import subtotal changed")
    assert(number(financialStats.tax_cents) === 648_720, "Full import tax changed")
    assert(number(financialStats.total_cents) === 4_115_827_620, "Full import total changed")

    const ublAssignment = await one(client, `
      select count(*)::int count from organization_inventory
      where id = $1 or (organization_id = $2 and global_product_id = $3)
    `, [CONFIG.ublAssignment.id, CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId])
    assert(ublAssignment.count === 0, "Guarded UBL assignment still exists")

    const crossTenant = await one(client, `
      select
        (select count(*)::int from organization_inventory where global_product_id = any($1::int[]) and organization_id <> $2) organization_inventory,
        (select count(*)::int from branch_inventory bi join organization_inventory oi on oi.id = bi.organization_inventory_id where oi.global_product_id = any($1::int[]) and bi.organization_id <> $2) branch_inventory,
        (select count(*)::int from order_items where global_product_id = any($1::int[]) and organization_id <> $2) order_items,
        (select count(*)::int from organization_products where global_product_id = any($1::int[]) and organization_id <> $2) organization_products,
        (select count(*)::int from branch_products where global_product_id = any($1::int[]) and organization_id <> $2) branch_products,
        (select count(*)::int from product_quantity_budgets where global_product_id = any($1::int[]) and organization_id <> $2) quantity_budgets,
        (select count(*)::int from product_quantity_budget_allocations where global_product_id = any($1::int[]) and organization_id <> $2) quantity_allocations,
        (select count(*)::int from restock_requests where global_product_id = any($1::int[]) and organization_id <> $2) restock_requests,
        (select count(*)::int from legacy_product_mappings where global_product_id = any($1::int[]) and organization_id <> $2) legacy_mappings
    `, [targetIds, CONFIG.organization.id])
    assert(Object.values(crossTenant).every((value) => value === 0), `Cross-tenant references remain: ${JSON.stringify(crossTenant)}`)

    const uniqueIndex = await one(client, `
      select count(*) filter (where ix.indisunique and ix.indisvalid and ix.indisready)::int count,
             max(pg_get_indexdef(ix.indexrelid)) definition
      from pg_index ix join pg_class i on i.oid = ix.indexrelid where i.relname = $1
    `, [CONFIG.normalizedUniqueIndex])
    assert(uniqueIndex.count === 1, "Normalized active product-code unique index is missing, unready, or invalid")
    const indexDefinition = String(uniqueIndex.definition ?? "").toLowerCase()
    assert(indexDefinition.includes("lower(btrim("), "Normalized product-code index has an unexpected expression")
    assert(indexDefinition.includes("deleted_at is null"), "Normalized product-code index has an unexpected predicate")
    const normalizedDuplicates = await one(client, `
      select count(*)::int count from (
        select upper(btrim(product_code)) from global_products where deleted_at is null
        group by upper(btrim(product_code)) having count(*) > 1
      ) duplicates
    `)
    assert(normalizedDuplicates.count === 0, "Normalized active product-code duplicates exist")
    const series = await one(client, `
      select max(substring(product_code from '[0-9]+$')::int)::int maximum
      from global_products where product_code ~ '^PRD--[0-9]+$' and deleted_at is null
    `)
    assert(number(series.maximum) >= CONFIG.lastCodeNumber, `Canonical series maximum ${series.maximum} is below the migrated range`)

    const auditRows = (await client.query(`
      select id, user_id, organization_id, entity_id, metadata, created_at
      from audit_logs where action = 'LEGACY_PRODUCT_CODE_RENUMBER'
        and organization_id = $1 and entity_id = $2
      order by created_at desc limit 1
    `, [CONFIG.organization.id, CONFIG.importBatchId])).rows
    assert(auditRows.length === 1, "Product-code migration audit record is missing")
    const audit = auditRows[0]
    if (commitReport) {
      assert(audit.id === commitReport.audit.id, "Commit report/audit ID mismatch")
      assert(audit.metadata?.mappingDigest === commitReport.mappingDigest, "Commit report/audit digest mismatch")
      assert(audit.metadata?.behaviorDigest === commitReport.behaviorDigest, "Commit report/audit behavior digest mismatch")
      assert(audit.metadata?.runId === commitReport.runId, "Commit report/K-Electric audit run ID mismatch")

      const ublAudit = await one(client, `
        select id, user_id, organization_id, action, entity, entity_id, metadata, created_at
        from audit_logs where id = $1
      `, [commitReport.ublAudit?.id])
      assert(ublAudit.organization_id === CONFIG.ublOrganization.id, "UBL audit belongs to another tenant")
      assert(ublAudit.action === "DELETE" && ublAudit.entity === "OrganizationAssignment", "UBL audit action/entity mismatch")
      assert(ublAudit.entity_id === String(CONFIG.ublAssignment.id), "UBL audit assignment ID mismatch")
      assert(ublAudit.user_id === commitReport.actor?.id, "UBL audit actor mismatch")
      assert(ublAudit.metadata?.runId === commitReport.runId, "Commit report/UBL audit run ID mismatch")
      assert(number(ublAudit.metadata?.removedAssignment?.id) === CONFIG.ublAssignment.id, "UBL audit is missing the deleted assignment snapshot")
    }
    assert(Array.isArray(audit.metadata?.mappings) && audit.metadata.mappings.length === CONFIG.productCount, "Audit mapping is incomplete")

    const behaviorDigest = await protectedBehaviorDigest(client)
    const expectedBehaviorDigest = commitReport?.behaviorDigest ?? audit.metadata?.behaviorDigest
    assert(behaviorDigest === expectedBehaviorDigest, "Protected operational/reporting data differs from the committed migration snapshot")

    await client.query("commit")
    console.log(JSON.stringify({
      status: "PASS",
      batchId: CONFIG.importBatchId,
      auditId: audit.id,
      mappingDigest: audit.metadata.mappingDigest,
      behaviorDigest,
      products: CONFIG.productCount,
      orderItems: CONFIG.renamedItemCount,
      quantity: CONFIG.renamedItemQuantity,
      revenueCents: CONFIG.renamedItemRevenueCents,
      fullImport: {
        orders: financialStats.orders,
        items: allImportStats.items,
        quantity: allImportStats.quantity,
        subtotalCents: financialStats.subtotal_cents,
        taxCents: financialStats.tax_cents,
        totalCents: financialStats.total_cents,
      },
      ublAssignmentRemoved: true,
      crossTenantReferences: 0,
      nextProductCode: `PRD--${number(series.maximum) + 1}`,
      immediateBaseline: baselineValidation,
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
  console.error(JSON.stringify({ status: "FAILED", error: error instanceof Error ? error.message : String(error) }, null, 2))
  process.exit(1)
})

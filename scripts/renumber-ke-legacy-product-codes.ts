#!/usr/bin/env tsx
/**
 * One-time, dry-run-first correction of synthetic LEG-KE product codes.
 *
 * The apply path is intentionally narrower than the admin APIs: it removes one
 * dependency-free UBL assignment and renumbers only the 144 products proven to
 * have been created by the completed K-Electric legacy import. Catalog codes and
 * imported order-item snapshots are changed atomically; prices, stock, budgets,
 * orders, assignments, and financial values are verified unchanged.
 */

import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
import type { PoolClient } from "pg"
import * as dotenv from "dotenv"
import {
  KE_PRODUCT_CODE_MIGRATION as CONFIG,
  buildKeProductCodeMappingPayload,
  buildKeProductCodeMappings,
  classifyKeProductCodeState,
  expectedKeProductCode,
  sha256Json,
  type KeProductCodeMapping,
  type KeProductCodeState,
} from "../lib/legacy-import/ke-product-codes"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRecord = Record<string, any>

interface Options {
  apply: boolean
  simulate: boolean
  actorUserId?: string
  confirmation?: string
  preflightPath?: string
  outputPath?: string
}

interface CollectedState {
  database: JsonRecord
  organizations: JsonRecord[]
  batch: JsonRecord
  importedProducts: JsonRecord[]
  state: KeProductCodeState
  mappings: KeProductCodeMapping[]
  mappingDigest: string | null
  mappingPayload: JsonRecord | null
  ublAssignment: JsonRecord | null
  normalizedUniqueIndex: JsonRecord | null
  counts: JsonRecord
  dependencyCounts: JsonRecord
  crossTenantCounts: JsonRecord
  targetCollisions: JsonRecord[]
  normalizedDuplicates: JsonRecord[]
  schemaSafety: JsonRecord
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseOptions(): Options {
  return {
    apply: process.argv.includes("--apply"),
    simulate: process.argv.includes("--simulate"),
    actorUserId: arg("--actor-user-id"),
    confirmation: arg("--confirm"),
    preflightPath: arg("--preflight"),
    outputPath: arg("--output"),
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function asNumber(value: unknown): number {
  const number = Number(value)
  assert(Number.isFinite(number), `Expected a finite number, received ${String(value)}`)
  return number
}

function normalized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeJsonExclusive(path: string, value: unknown): void {
  const absolutePath = resolve(path)
  assert(!existsSync(absolutePath), `Refusing to overwrite existing output: ${absolutePath}`)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
}

function assertOutputWritable(path: string): void {
  const absolutePath = resolve(path)
  assert(!existsSync(absolutePath), `Refusing to overwrite existing output: ${absolutePath}`)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const probe = `${absolutePath}.write-probe-${process.pid}`
  writeFileSync(probe, "write-check\n", { encoding: "utf8", flag: "wx" })
  unlinkSync(probe)
}

async function one(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRecord> {
  const result = await client.query(text, params)
  assert(result.rows.length === 1, `Expected exactly one row, found ${result.rows.length}`)
  return result.rows[0]
}

async function count(client: PoolClient, text: string, params: unknown[] = []): Promise<number> {
  return asNumber((await one(client, text, params)).count)
}

async function collectState(client: PoolClient): Promise<CollectedState> {
  const targetIds = Array.from(
    { length: CONFIG.productCount },
    (_, index) => CONFIG.firstProductId + index,
  )
  const targetCodes = targetIds.map((id) => expectedKeProductCode(id).toUpperCase())

  const database = await one(client, `
    select current_database() database_name, current_user database_user,
           current_setting('server_version') server_version, now() captured_at
  `)
  const organizations = (await client.query(`
    select id, code, name, status from organizations where id = any($1::int[]) order by id
  `, [[CONFIG.ublOrganization.id, CONFIG.organization.id]])).rows
  assert(organizations.length === 2, "K-Electric or UBL organization is missing")
  for (const expected of [CONFIG.ublOrganization, CONFIG.organization]) {
    const actual = organizations.find((row) => row.id === expected.id)
    assert(actual, `Organization ${expected.id} is missing`)
    assert(actual.code === expected.code && actual.name === expected.name && actual.status === "active", `Organization safety gate failed for ${expected.name}`)
  }

  const batch = await one(client, `
    select lib.id, lib.organization_id, lib.source_system, lib.status, lib.source_manifest,
           lib.counts, lib.imported_by_user_id, lib.created_at, lib.completed_at,
           count(loi.id)::int imported_orders
    from legacy_import_batches lib
    left join legacy_order_imports loi on loi.batch_id = lib.id
    where lib.id = $1
    group by lib.id
  `, [CONFIG.importBatchId])
  assert(batch.organization_id === CONFIG.organization.id, "Import batch tenant mismatch")
  assert(batch.source_system === CONFIG.sourceSystem && batch.status === "COMPLETED", "Import batch source/status mismatch")
  assert(batch.source_manifest?.digest === CONFIG.importManifestDigest, "Import batch source manifest mismatch")
  assert(batch.imported_orders === CONFIG.importedOrderCount, `Expected ${CONFIG.importedOrderCount} imported orders, found ${batch.imported_orders}`)

  const importedProducts = (await client.query(`
    select gp.id, gp.name, gp.product_code, gp.status, gp.stock_quantity::text,
           gp.deleted_at, gp.metadata, lpm.normalized_name,
           lpm.organization_inventory_id, oi.organization_id mapped_inventory_org_id,
           oi.global_product_id mapped_inventory_product_id,
           oi.deleted_at mapped_inventory_deleted_at
    from legacy_product_mappings lpm
    join global_products gp on gp.id = lpm.global_product_id
    join organization_inventory oi on oi.id = lpm.organization_inventory_id
    where lpm.organization_id = $1 and lpm.source_system = $2
      and gp.metadata->>'legacySource' = $2
      and gp.metadata->>'historicalOnly' = 'true'
    order by gp.id
  `, [CONFIG.organization.id, CONFIG.sourceSystem])).rows
  const codeRows = importedProducts.map((row) => ({ id: row.id, name: row.name, productCode: row.product_code }))
  const state = classifyKeProductCodeState(codeRows)
  assert(state !== "MIXED", "Imported products are in a mixed/partial code state; refusing to continue")
  for (const product of importedProducts) {
    assert(product.status === "inactive" && asNumber(product.stock_quantity) === 0 && product.deleted_at === null, `Imported product ${product.id} is no longer inactive/zero-stock/current`)
    assert(product.mapped_inventory_org_id === CONFIG.organization.id, `Product ${product.id} mapping is cross-tenant`)
    assert(product.mapped_inventory_product_id === product.id && product.mapped_inventory_deleted_at === null, `Product ${product.id} mapping references an invalid K-Electric assignment`)
  }

  const catalogMappingStats = await one(client, `
    select count(*)::int total_mappings,
           count(*) filter (where gp.id = $3 and gp.product_code = $4 and gp.name = $5)::int reused_product_mappings,
           count(*) filter (where gp.metadata->>'legacySource' = $2 and gp.metadata->>'historicalOnly' = 'true')::int importer_created
    from legacy_product_mappings lpm join global_products gp on gp.id = lpm.global_product_id
    where lpm.organization_id = $1 and lpm.source_system = $2
  `, [CONFIG.organization.id, CONFIG.sourceSystem, CONFIG.reusedProduct.id, CONFIG.reusedProduct.code, CONFIG.reusedProduct.name])
  assert(catalogMappingStats.total_mappings === CONFIG.productCount + 1, "Legacy product mapping count changed")
  assert(catalogMappingStats.reused_product_mappings === 1 && catalogMappingStats.importer_created === CONFIG.productCount, "Imported/reused product identity check failed")

  const ublRows = (await client.query(`
    select oi.id, oi.organization_id, oi.global_product_id, oi.assigned_by_user_id,
           oi.is_active, oi.custom_name, oi.custom_price_cents, oi.custom_description,
           oi.custom_image_url, oi.assigned_at, oi.updated_at, oi.deleted_at
    from organization_inventory oi
    where oi.id = $1 or (oi.organization_id = $2 and oi.global_product_id = $3)
    order by oi.id
  `, [CONFIG.ublAssignment.id, CONFIG.ublAssignment.organizationId, CONFIG.ublAssignment.globalProductId])).rows
  assert(ublRows.length <= 1, "Multiple UBL assignments unexpectedly match the guarded product")
  const ublAssignment = ublRows[0] ? normalized(ublRows[0]) : null
  if (state === "PENDING") {
    assert(ublAssignment, "Expected UBL assignment 320 is missing before renumbering")
    assert(
      ublAssignment.id === CONFIG.ublAssignment.id
        && ublAssignment.organization_id === CONFIG.ublAssignment.organizationId
        && ublAssignment.global_product_id === CONFIG.ublAssignment.globalProductId
        && ublAssignment.deleted_at === null,
      "UBL assignment identity/state changed",
    )
  } else {
    assert(ublAssignment === null, "UBL assignment still exists after product-code migration")
  }

  const dependencyCounts = {
    branchInventory: await count(client, `select count(*)::int count from branch_inventory where organization_inventory_id = $1`, [CONFIG.ublAssignment.id]),
    orderItemsByAssignment: await count(client, `select count(*)::int count from order_items where organization_inventory_id = $1`, [CONFIG.ublAssignment.id]),
    quantityBudgets: await count(client, `select count(*)::int count from product_quantity_budgets where organization_inventory_id = $1`, [CONFIG.ublAssignment.id]),
    quantityAllocations: await count(client, `select count(*)::int count from product_quantity_budget_allocations where organization_inventory_id = $1`, [CONFIG.ublAssignment.id]),
    legacyMappings: await count(client, `select count(*)::int count from legacy_product_mappings where organization_inventory_id = $1`, [CONFIG.ublAssignment.id]),
    organizationProducts: await count(client, `select count(*)::int count from organization_products where organization_id = $1 and global_product_id = $2`, [CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId]),
    branchProducts: await count(client, `select count(*)::int count from branch_products where organization_id = $1 and global_product_id = $2`, [CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId]),
    restockRequests: await count(client, `select count(*)::int count from restock_requests where organization_id = $1 and global_product_id = $2`, [CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId]),
  }
  assert(Object.values(dependencyCounts).every((value) => value === 0), `UBL assignment has dependencies: ${JSON.stringify(dependencyCounts)}`)

  const crossTenantCounts = {
    organizationInventory: await count(client, `
      select count(*)::int count from organization_inventory
      where global_product_id = any($1::int[]) and organization_id <> $2
        and id <> $3
    `, [targetIds, CONFIG.organization.id, CONFIG.ublAssignment.id]),
    branchInventory: await count(client, `
      select count(*)::int count from branch_inventory bi
      join organization_inventory oi on oi.id = bi.organization_inventory_id
      where oi.global_product_id = any($1::int[]) and bi.organization_id <> $2
    `, [targetIds, CONFIG.organization.id]),
    orderItems: await count(client, `select count(*)::int count from order_items where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    organizationProducts: await count(client, `select count(*)::int count from organization_products where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    branchProducts: await count(client, `select count(*)::int count from branch_products where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    quantityBudgets: await count(client, `select count(*)::int count from product_quantity_budgets where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    quantityAllocations: await count(client, `select count(*)::int count from product_quantity_budget_allocations where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    restockRequests: await count(client, `select count(*)::int count from restock_requests where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
    legacyMappings: await count(client, `select count(*)::int count from legacy_product_mappings where global_product_id = any($1::int[]) and organization_id <> $2`, [targetIds, CONFIG.organization.id]),
  }
  assert(Object.values(crossTenantCounts).every((value) => value === 0), `Unexpected cross-tenant product references: ${JSON.stringify(crossTenantCounts)}`)

  const itemStats = await one(client, `
    select count(*)::int imported_items,
           count(*) filter (where oi.global_product_id = any($2::int[]))::int target_items,
           count(*) filter (where oi.global_product_id = $3)::int reused_items,
           count(*) filter (where oi.product_code = gp.product_code)::int matching_catalog_codes,
           coalesce(sum(oi.quantity), 0)::text quantity,
           coalesce(sum(round(oi.quantity * oi.price_cents)), 0)::text subtotal_cents,
           coalesce(sum(oi.quantity) filter (where oi.global_product_id = any($2::int[])), 0)::text target_quantity,
           coalesce(sum(round(oi.quantity * oi.price_cents)) filter (where oi.global_product_id = any($2::int[])), 0)::text target_revenue_cents
    from legacy_order_imports loi
    join order_items oi on oi.order_id = loi.order_id
    join global_products gp on gp.id = oi.global_product_id
    where loi.batch_id = $1 and loi.organization_id = $4 and oi.organization_id = $4
  `, [CONFIG.importBatchId, targetIds, CONFIG.reusedProduct.id, CONFIG.organization.id])
  assert(itemStats.imported_items === CONFIG.importedItemCount, "Imported item count changed")
  assert(itemStats.target_items === CONFIG.renamedItemCount, "Renumbered item count changed")
  assert(itemStats.reused_items === CONFIG.reusedProduct.importedItemCount, "Reused Sugar item count changed")
  assert(itemStats.matching_catalog_codes === CONFIG.importedItemCount, "Catalog/order-item product codes are inconsistent")
  assert(asNumber(itemStats.target_quantity) === CONFIG.renamedItemQuantity, "Renumbered item quantity changed")
  assert(asNumber(itemStats.target_revenue_cents) === CONFIG.renamedItemRevenueCents, "Renumbered item revenue changed")
  const targetItemsOutsideBatch = await count(client, `
    select count(*)::int count
    from order_items oi
    left join legacy_order_imports loi
      on loi.order_id = oi.order_id and loi.batch_id = $1 and loi.organization_id = $2
    where oi.global_product_id = any($3::int[]) and loi.id is null
  `, [CONFIG.importBatchId, CONFIG.organization.id, targetIds])
  assert(targetItemsOutsideBatch === 0, "Imported products are referenced by non-imported order items")
  const targetItemIdentityViolations = await count(client, `
    select count(*)::int count
    from order_items oi
    join orders o on o.id = oi.order_id
    left join legacy_order_imports loi
      on loi.order_id = oi.order_id and loi.batch_id = $1
      and loi.organization_id = $2 and loi.source_system = $3
    where oi.global_product_id = any($4::int[])
      and (oi.organization_id <> $2 or o.organization_id <> $2 or loi.id is null)
  `, [CONFIG.importBatchId, CONFIG.organization.id, CONFIG.sourceSystem, targetIds])
  assert(targetItemIdentityViolations === 0, "Target order-item/order/import-ledger tenant identity check failed")

  const financialStats = await one(client, `
    select count(*)::int orders,
           coalesce(sum(o.subtotal_cents), 0)::text subtotal_cents,
           coalesce(sum(o.tax_cents), 0)::text tax_cents,
           coalesce(sum(o.total_cents), 0)::text total_cents,
           count(*) filter (where o.organization_id <> $2)::int cross_tenant_orders
    from legacy_order_imports loi join orders o on o.id = loi.order_id
    where loi.batch_id = $1
  `, [CONFIG.importBatchId, CONFIG.organization.id])
  assert(financialStats.orders === CONFIG.importedOrderCount && financialStats.cross_tenant_orders === 0, "Imported order tenant/count check failed")
  assert(asNumber(financialStats.subtotal_cents) === 4_115_178_900, "Imported subtotal changed")
  assert(asNumber(financialStats.tax_cents) === 648_720, "Imported tax changed")
  assert(asNumber(financialStats.total_cents) === 4_115_827_620, "Imported total changed")

  const targetCollisions = (await client.query(`
    select id, product_code, name, deleted_at
    from global_products
    where id <> all($1::int[]) and upper(btrim(product_code)) = any($2::text[])
    order by id
  `, [targetIds, targetCodes])).rows
  assert(targetCollisions.length === 0, `Target product-code collision: ${JSON.stringify(targetCollisions)}`)
  const normalizedDuplicates = (await client.query(`
    select upper(btrim(product_code)) normalized_code, count(*)::int rows,
           array_agg(id order by id) product_ids
    from global_products where deleted_at is null
    group by upper(btrim(product_code)) having count(*) > 1
    order by normalized_code
  `)).rows
  assert(normalizedDuplicates.length === 0, `Existing normalized product-code duplicates: ${JSON.stringify(normalizedDuplicates)}`)
  const series = await one(client, `
    select coalesce(max(substring(product_code from '[0-9]+$')::int), 0)::int maximum
    from global_products
    where id <> all($1::int[]) and product_code ~ '^PRD--[0-9]+$'
  `, [targetIds])
  assert(series.maximum === CONFIG.firstCodeNumber - 1, `Canonical product-code series outside the imported targets ends at ${series.maximum}, expected ${CONFIG.firstCodeNumber - 1}`)

  const normalizedIndexRows = (await client.query(`
    select i.relname index_name, ix.indisunique, ix.indisvalid, ix.indisready,
           pg_get_indexdef(ix.indexrelid) index_definition
    from pg_index ix join pg_class i on i.oid = ix.indexrelid
    where i.relname = $1
  `, [CONFIG.normalizedUniqueIndex])).rows
  assert(normalizedIndexRows.length <= 1, "Duplicate normalized product-code index names found")
  const normalizedUniqueIndex = normalizedIndexRows[0] ?? null
  if (normalizedUniqueIndex) {
    const definition = String(normalizedUniqueIndex.index_definition).toLowerCase().replace(/\s+/g, " ")
    assert(normalizedUniqueIndex.indisunique && normalizedUniqueIndex.indisvalid && normalizedUniqueIndex.indisready, "Normalized product-code index is not ready/unique/valid")
    assert(definition.includes("lower(btrim(") && definition.includes("deleted_at is null"), "Normalized product-code index definition is not the expected partial normalized index")
  }

  const foreignKeys = (await client.query(`
    select con.conrelid::regclass::text referencing_table, con.confdeltype delete_action
    from pg_constraint con
    where con.contype = 'f' and con.confrelid = 'organization_inventory'::regclass
    order by referencing_table
  `)).rows
  const expectedForeignKeys = [
    { referencing_table: "branch_inventory", delete_action: "c" },
    { referencing_table: "legacy_product_mappings", delete_action: "a" },
    { referencing_table: "product_quantity_budget_allocations", delete_action: "c" },
    { referencing_table: "product_quantity_budgets", delete_action: "c" },
  ]
  assert(JSON.stringify(foreignKeys) === JSON.stringify(expectedForeignKeys), `organization_inventory FK schema drift: ${JSON.stringify(foreignKeys)}`)
  const userTriggers = (await client.query(`
    select tgrelid::regclass::text table_name, tgname trigger_name
    from pg_trigger
    where not tgisinternal and tgrelid = any(array[
      'organization_inventory'::regclass, 'global_products'::regclass, 'order_items'::regclass
    ])
    order by table_name, trigger_name
  `)).rows
  assert(userTriggers.length === 0, `Unexpected user-defined migration target triggers: ${JSON.stringify(userTriggers)}`)
  const schemaSafety = { foreignKeys, userTriggers }

  let mappings: KeProductCodeMapping[] = []
  let payload: JsonRecord | null = null
  let mappingDigest: string | null = null
  if (state === "PENDING") {
    mappings = buildKeProductCodeMappings(codeRows)
    payload = buildKeProductCodeMappingPayload(mappings, ublAssignment!) as JsonRecord
    mappingDigest = sha256Json(payload)
  }

  return {
    database,
    organizations,
    batch,
    importedProducts,
    state,
    mappings,
    mappingDigest,
    mappingPayload: payload,
    ublAssignment,
    normalizedUniqueIndex,
    counts: {
      productMappings: catalogMappingStats.total_mappings,
      importedProducts: catalogMappingStats.importer_created,
      importedOrders: batch.imported_orders,
      importedItems: itemStats.imported_items,
      renamedItems: itemStats.target_items,
      reusedItems: itemStats.reused_items,
      importedQuantity: itemStats.quantity,
      renamedItemQuantity: itemStats.target_quantity,
      renamedItemRevenueCents: itemStats.target_revenue_cents,
      importedSubtotalCents: itemStats.subtotal_cents,
      importedTaxCents: financialStats.tax_cents,
      importedTotalCents: financialStats.total_cents,
    },
    dependencyCounts,
    crossTenantCounts,
    targetCollisions,
    normalizedDuplicates,
    schemaSafety,
  }
}

async function behaviorSnapshot(client: PoolClient): Promise<{ digest: string; sections: JsonRecord }> {
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
  return { sections, digest: sha256Json(sections) }
}

async function validateActor(client: PoolClient, actorUserId: string): Promise<JsonRecord> {
  const actors = (await client.query(`
    select u.id, u.email, u.is_active, u.deleted_at, r.name role_name
    from users u join roles r on r.id = u.role_id
    where u.id = $1
  `, [actorUserId])).rows
  assert(actors.length === 1, "Audit actor does not exist")
  const actor = actors[0]
  assert(actor.role_name === "SUPER_ADMIN" && actor.is_active === true && actor.deleted_at === null, "Audit actor must be an active, non-deleted SUPER_ADMIN")
  return actor
}

async function lockMigrationTables(client: PoolClient): Promise<void> {
  await client.query("set local lock_timeout = '8s'")
  await client.query("set local statement_timeout = '60s'")
  await client.query("set local idle_in_transaction_session_timeout = '60s'")
  await client.query(`select pg_advisory_xact_lock(1263482710, $1)`, [CONFIG.organization.id])
  await client.query(`
    lock table global_products, organization_inventory, branch_inventory,
      product_quantity_budgets, product_quantity_budget_allocations,
      legacy_product_mappings, organization_products, branch_products,
      restock_requests in share row exclusive mode
  `)
}

async function invalidateProductCaches(): Promise<JsonRecord> {
  const patterns = [
    "cache:global-inv*",
    "cache:org-inv*",
    "cache:branch-inv*",
    "cache:inv:org-products*",
    "cache:inv:branch-products*",
    "cache:analytics:catalog-performance*",
    "product-summary:*",
  ]
  const { redis } = await import("../lib/redis-cli")
  if (!redis) return { status: "SKIPPED", reason: "Redis configuration is unavailable", patterns }
  let deleted = 0
  const deletedByPattern: Record<string, number> = {}
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern)
    deletedByPattern[pattern] = keys.length
    for (let index = 0; index < keys.length; index += 100) {
      const chunk = keys.slice(index, index + 100)
      if (chunk.length > 0) deleted += await redis.del(...chunk)
    }
  }
  return { status: "CLEARED", deleted, deletedByPattern }
}

function summary(state: CollectedState): JsonRecord {
  return {
    state: state.state,
    organization: CONFIG.organization,
    batchId: CONFIG.importBatchId,
    products: state.counts.importedProducts,
    renamedOrderItems: state.counts.renamedItems,
    codeRange: [`PRD--${CONFIG.firstCodeNumber}`, `PRD--${CONFIG.lastCodeNumber}`],
    ublAssignmentPresent: Boolean(state.ublAssignment),
    dependencies: state.dependencyCounts,
    crossTenantReferencesExcludingGuardedUblRow: state.crossTenantCounts,
    normalizedUniqueIndexInstalled: Boolean(state.normalizedUniqueIndex?.indisunique && state.normalizedUniqueIndex?.indisvalid && state.normalizedUniqueIndex?.indisready),
    mappingDigest: state.mappingDigest,
  }
}

async function dryRun(client: PoolClient, options: Options): Promise<void> {
  await client.query("begin transaction isolation level repeatable read read only")
  try {
    const state = await collectState(client)
    const behavior = await behaviorSnapshot(client)
    await client.query("commit")
    const report = normalized({
      kind: "KE_LEGACY_PRODUCT_CODE_RENUMBER_PREFLIGHT",
      version: CONFIG.version,
      generatedAt: new Date().toISOString(),
      mode: "DRY_RUN",
      readyForApply: state.state === "PENDING" && Boolean(state.normalizedUniqueIndex?.indisunique && state.normalizedUniqueIndex?.indisvalid && state.normalizedUniqueIndex?.indisready),
      ...summary(state),
      database: state.database,
      organizations: state.organizations,
      batch: state.batch,
      counts: state.counts,
      ublAssignment: state.ublAssignment,
      mappingPayload: state.mappingPayload,
      behaviorDigest: behavior.digest,
      targetCollisions: state.targetCollisions,
      normalizedDuplicates: state.normalizedDuplicates,
      schemaSafety: state.schemaSafety,
    })
    if (options.outputPath) writeJsonExclusive(options.outputPath, report)
    console.log(JSON.stringify({
      ...summary(state),
      readyForApply: report.readyForApply,
      output: options.outputPath ? resolve(options.outputPath) : null,
      note: state.state === "APPLIED"
        ? "Migration is already applied; no database writes are required."
        : report.readyForApply
          ? "Dry-run passed; apply still requires the saved preflight and explicit confirmations."
          : "Dry-run passed, but the normalized unique-index migration must be installed before apply.",
    }, null, 2))
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  }
}

async function applyMigration(client: PoolClient, options: Options): Promise<void> {
  assert(options.apply !== options.simulate, "Choose exactly one of --apply or --simulate")
  assert(options.preflightPath, "--preflight=<saved dry-run report> is required")
  if (options.apply) assert(options.outputPath, "--output=<new commit report path> is required with --apply")
  assert(options.actorUserId, "--actor-user-id=<active SUPER_ADMIN UUID> is required")
  assert(options.confirmation === CONFIG.confirmation, `Required: --confirm=${CONFIG.confirmation}`)
  const output = options.outputPath ? resolve(options.outputPath) : null
  if (options.apply) assertOutputWritable(output!)

  const saved = JSON.parse(readFileSync(resolve(options.preflightPath), "utf8")) as JsonRecord
  assert(saved.kind === "KE_LEGACY_PRODUCT_CODE_RENUMBER_PREFLIGHT" && saved.mode === "DRY_RUN", "Invalid preflight report")
  assert(saved.state === "PENDING" && saved.mappingDigest, "Preflight is not for a pending migration")
  assert(saved.mappingPayload && sha256Json(saved.mappingPayload) === saved.mappingDigest, "Saved preflight mapping digest is invalid")

  await client.query("begin transaction isolation level serializable")
  let committed = false
  const runId = randomUUID()
  try {
    await lockMigrationTables(client)
    const actor = await validateActor(client, options.actorUserId)
    const before = await collectState(client)
    assert(before.state === "PENDING", `Expected PENDING state, found ${before.state}`)
    assert(before.mappingDigest === saved.mappingDigest, "Live mapping/UBL state changed since the saved preflight")
    assert(
      before.normalizedUniqueIndex?.indisunique === true
        && before.normalizedUniqueIndex?.indisvalid === true
        && before.normalizedUniqueIndex?.indisready === true,
      `Required unique index ${CONFIG.normalizedUniqueIndex} is not installed, ready, and valid`,
    )
    const beforeBehavior = await behaviorSnapshot(client)

    const deletedAssignment = await client.query(`
      delete from organization_inventory
      where id = $1 and organization_id = $2 and global_product_id = $3 and deleted_at is null
      returning *
    `, [CONFIG.ublAssignment.id, CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId])
    assert(deletedAssignment.rowCount === 1, "Exact guarded UBL assignment was not deleted")
    assert(sha256Json(normalized(deletedAssignment.rows[0])) === sha256Json(before.ublAssignment), "Deleted UBL assignment differs from preflight snapshot")

    const ublAudit = await client.query(`
      insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
      values ($1, $2, 'DELETE', 'OrganizationAssignment', $3, $4::jsonb)
      returning id, created_at
    `, [options.actorUserId, CONFIG.ublOrganization.id, String(CONFIG.ublAssignment.id), JSON.stringify({
      runId,
      reason: "Remove the only cross-tenant assignment before K-Electric legacy product-code normalization",
      removedAssignment: before.ublAssignment,
      dependencyCounts: before.dependencyCounts,
      reversible: true,
    })])

    const databaseMappings = before.mappings.map((mapping) => ({
      global_product_id: mapping.globalProductId,
      product_name: mapping.productName,
      old_code: mapping.oldCode,
      new_code: mapping.newCode,
    }))
    const mappingJson = JSON.stringify(databaseMappings)
    const productsUpdated = await client.query(`
      update global_products gp
      set product_code = m.new_code, updated_at = now()
      from jsonb_to_recordset($1::jsonb)
        as m(global_product_id int, product_name text, old_code text, new_code text)
      where gp.id = m.global_product_id and gp.product_code = m.old_code
      returning gp.id, gp.product_code
    `, [mappingJson])
    assert(productsUpdated.rowCount === CONFIG.productCount, `Expected ${CONFIG.productCount} global product updates, got ${productsUpdated.rowCount}`)

    const itemsUpdated = await client.query(`
      update order_items oi
      set product_code = m.new_code
      from jsonb_to_recordset($1::jsonb)
        as m(global_product_id int, product_name text, old_code text, new_code text),
        legacy_order_imports loi
      where loi.batch_id = $2 and loi.organization_id = $3 and loi.source_system = $4
        and oi.order_id = loi.order_id and oi.organization_id = $3
        and oi.global_product_id = m.global_product_id and oi.product_code = m.old_code
      returning oi.id
    `, [mappingJson, CONFIG.importBatchId, CONFIG.organization.id, CONFIG.sourceSystem])
    assert(itemsUpdated.rowCount === CONFIG.renamedItemCount, `Expected ${CONFIG.renamedItemCount} order-item updates, got ${itemsUpdated.rowCount}`)

    const after = await collectState(client)
    assert(after.state === "APPLIED", `Post-update state is ${after.state}`)
    assert(after.ublAssignment === null, "UBL assignment still exists after deletion")
    const afterBehavior = await behaviorSnapshot(client)
    assert(afterBehavior.digest === beforeBehavior.digest, "A protected operational/reporting field changed during the migration")

    const audit = await client.query(`
      insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
      values ($1, $2, 'LEGACY_PRODUCT_CODE_RENUMBER', 'legacy_import_batch', $3, $4::jsonb)
      returning id, created_at
    `, [options.actorUserId, CONFIG.organization.id, CONFIG.importBatchId, JSON.stringify({
      version: CONFIG.version,
      runId,
      mappingDigest: before.mappingDigest,
      mappings: before.mappings,
      ublAssignment: before.ublAssignment,
      productsUpdated: productsUpdated.rowCount,
      orderItemsUpdated: itemsUpdated.rowCount,
      behaviorDigest: beforeBehavior.digest,
      codeRange: [`PRD--${CONFIG.firstCodeNumber}`, `PRD--${CONFIG.lastCodeNumber}`],
      sourceSystem: CONFIG.sourceSystem,
      importBatchId: CONFIG.importBatchId,
      stockBudgetPriceOrFinancialValuesChanged: false,
    })])

    if (options.simulate) {
      await client.query("rollback")
      console.log(JSON.stringify({
        status: "SIMULATION_PASS",
        committed: false,
        rolledBack: true,
        runId,
        productsUpdated: productsUpdated.rowCount,
        orderItemsUpdated: itemsUpdated.rowCount,
        removedUblAssignmentId: CONFIG.ublAssignment.id,
        mappingDigest: before.mappingDigest,
        behaviorDigest: beforeBehavior.digest,
        simulatedAuditRows: [ublAudit.rows[0].id, audit.rows[0].id],
      }, null, 2))
      return
    }

    await client.query("commit")
    committed = true
    let cache: JsonRecord
    try {
      cache = await invalidateProductCaches()
    } catch (error) {
      cache = { status: "WARNING", error: error instanceof Error ? error.message : String(error), maxKnownStaleSeconds: 300 }
    }
    const report = normalized({
      kind: "KE_LEGACY_PRODUCT_CODE_RENUMBER_COMMIT",
      version: CONFIG.version,
      generatedAt: new Date().toISOString(),
      mode: "APPLY",
      status: "COMPLETED",
      organization: CONFIG.organization,
      batchId: CONFIG.importBatchId,
      runId,
      actor,
      audit: audit.rows[0],
      ublAudit: ublAudit.rows[0],
      mappingDigest: before.mappingDigest,
      mappings: before.mappings,
      removedUblAssignment: before.ublAssignment,
      productsUpdated: productsUpdated.rowCount,
      orderItemsUpdated: itemsUpdated.rowCount,
      behaviorDigest: beforeBehavior.digest,
      cache,
    })
    let reportWrite: JsonRecord = { status: "WRITTEN", output: output! }
    try {
      writeJsonExclusive(output!, report)
    } catch (error) {
      reportWrite = { status: "WARNING", output, error: error instanceof Error ? error.message : String(error) }
    }
    console.log(JSON.stringify({
      status: "COMPLETED",
      committed: true,
      productsUpdated: productsUpdated.rowCount,
      orderItemsUpdated: itemsUpdated.rowCount,
      codeRange: [`PRD--${CONFIG.firstCodeNumber}`, `PRD--${CONFIG.lastCodeNumber}`],
      removedUblAssignmentId: CONFIG.ublAssignment.id,
      mappingDigest: before.mappingDigest,
      behaviorDigest: beforeBehavior.digest,
      cache,
      reportWrite,
    }, null, 2))
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => undefined)
    throw error
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    if (options.apply || options.simulate) await applyMigration(client, options)
    else await dryRun(client, options)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(JSON.stringify({ status: "FAILED", error: message }, null, 2))
  process.exit(1)
})

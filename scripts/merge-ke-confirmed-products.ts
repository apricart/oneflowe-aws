#!/usr/bin/env tsx
/**
 * Guarded, dry-run-first merge of confirmed K-Electric duplicate products.
 *
 * The canonical global product keeps its base price and descriptive fields.
 * Its stock becomes the greatest stock currently recorded on any member of the
 * duplicate cluster. K-Electric's organization price is set from the latest
 * positive K-Electric order line. Historical order snapshot fields and money
 * are never rewritten; only their product/inventory identities are re-keyed.
 *
 * Product 202's UBL assignment is deliberately retained, so that global product
 * is not deactivated. Product 182's dependency-free K-E-Demo assignment is
 * deliberately removed, as approved for this maintenance operation.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import { invalidateCachePrefixes } from "../lib/cache-cli"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const SOURCE_SYSTEM = "KE_LOGISTICS"
const ADVISORY_LOCK = 700015
const APPLY_CONFIRMATION = "MERGE:KE:CONFIRMED-PRODUCTS"

type JsonRow = Record<string, any>

interface ClusterConfig {
  key: string
  canonicalId: number
  canonicalName: string
  losers: Array<{ id: number; name: string }>
  retainedExternal?: { productId: number; organizationId: number; inventoryId: number }
  removableDemoInventoryId?: number
}

const CLUSTERS: ClusterConfig[] = [
  {
    key: "sugar-1kg",
    canonicalId: 7,
    canonicalName: "Sugar",
    losers: [{ id: 182, name: "Sugar (01 KG)" }],
    removableDemoInventoryId: 352,
  },
  {
    key: "nescafe-classic-100g",
    canonicalId: 18,
    canonicalName: "Nescafe Classic Coffee 100gm",
    losers: [{ id: 190, name: "Nescafe Classic Coffee (100 GM)" }],
  },
  {
    key: "nescafe-classic-200g",
    canonicalId: 19,
    canonicalName: "Nescafe Classic Coffee 200gm",
    losers: [
      { id: 253, name: "Nescafe Classic Coffee (200 GM)" },
      { id: 341, name: "Nescafe Classic Coffee  (200gm)" },
    ],
  },
  {
    key: "rose-petal-popup",
    canonicalId: 6,
    canonicalName: "Rose Petal Pop-up",
    losers: [{ id: 202, name: "Rose Petal Pop-Up (1pcs)" }],
    retainedExternal: { productId: 202, organizationId: 6, inventoryId: 326 },
  },
  {
    key: "tapal-family-mixture-900g",
    canonicalId: 12,
    canonicalName: "Tapal Family Mixture 900gm",
    losers: [{ id: 209, name: "Tapal Family Mixture Tea (900 GM)" }],
  },
  {
    key: "tapal-family-mixture-430g",
    canonicalId: 17,
    canonicalName: "Tapal Family Mixture 430gm",
    losers: [{ id: 227, name: "Tapal Family Mixture Tea (430 GM)" }],
  },
]

const MEMBER_IDS = [...new Set(CLUSTERS.flatMap((cluster) => [
  cluster.canonicalId,
  ...cluster.losers.map((loser) => loser.id),
]))].sort((a, b) => a - b)
const LOSER_IDS = [...new Set(CLUSTERS.flatMap((cluster) => cluster.losers.map((loser) => loser.id)))]
  .sort((a, b) => a - b)

interface CollectedState {
  database: JsonRow
  organization: JsonRow
  products: JsonRow[]
  organizationInventory: JsonRow[]
  branchInventory: JsonRow[]
  organizationProducts: JsonRow[]
  legacyMappings: JsonRow[]
  orderItems: JsonRow[]
  affectedOrders: JsonRow[]
  refundItems: JsonRow[]
  unsupported: Record<string, JsonRow[]>
  inventoryDependencies: JsonRow[]
  jsonAuditReferences: JsonRow[]
}

interface ClusterPlan {
  key: string
  canonicalId: number
  canonicalName: string
  loserIds: number[]
  survivorOrganizationInventoryId: number
  survivorOriginalProductId: number
  sourceOrganizationInventoryIds: number[]
  latestKePriceCents: number
  latestPriceOrderId: number
  latestPriceOrderItemId: number
  latestPriceOrderCreatedAt: string
  canonicalBasePriceCents: number
  canonicalStockBefore: string
  memberStocksBefore: Array<{ productId: number; stock: string }>
  canonicalStockAfter: string
  orderItemIdsToMove: number[]
  constraintBlockedOrderItemIds: number[]
  orderItemsToMove: number
  affectedOrderGrossCents: string
  branchRowsBefore: number
  branchUnionCount: number
  branchCollisionCount: number
  organizationProductSurvivorId: number
  organizationProductDeleteIds: number[]
  mappingIds: number[]
  retainedExternal: ClusterConfig["retainedExternal"] | null
  removableDemoInventoryId: number | null
}

interface MergePlan {
  organization: typeof ORGANIZATION
  policy: JsonRow
  clusters: ClusterPlan[]
  totals: JsonRow
  protectedFingerprints: JsonRow
}

interface OrderItemConstraintState {
  constraint: JsonRow
  invalidRows: JsonRow[]
}

const ORDER_ITEM_CHECK_DEFINITION = "CHECK (((quantity > (0)::numeric) AND (quantity <= (1000000)::numeric) AND (price_cents >= 0))) NOT VALID"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

const flag = (name: string) => process.argv.includes(`--${name}`)

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as JsonRow
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const digestOf = (value: unknown) => sha256(canonical(value))

function asNumber(value: unknown, label: string): number {
  const number = Number(value)
  assert(Number.isFinite(number), `${label} is not a finite number: ${String(value)}`)
  return number
}

function writeJsonExclusive(path: string, value: unknown): string {
  const absolute = resolve(path)
  assert(!existsSync(absolute), `Refusing to overwrite existing output: ${absolute}`)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 })
  return absolute
}

function assertOutputWritable(path: string): void {
  const absolute = resolve(path)
  assert(!existsSync(absolute), `Refusing to overwrite existing output: ${absolute}`)
  mkdirSync(dirname(absolute), { recursive: true })
  const probe = `${absolute}.write-probe-${process.pid}`
  writeFileSync(probe, "write-check\n", { encoding: "utf8", flag: "wx" })
  unlinkSync(probe)
}

async function rows(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRow[]> {
  return (await client.query(text, params)).rows
}

async function one(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRow> {
  const result = await rows(client, text, params)
  assert(result.length === 1, `Expected one row, found ${result.length}`)
  return result[0]
}

async function collectOrderItemConstraintState(client: PoolClient): Promise<OrderItemConstraintState> {
  const constraint = await one(client, `
    select conname, convalidated, pg_get_constraintdef(oid) definition
      from pg_constraint
     where conrelid='public.order_items'::regclass
       and conname='order_items_values_valid_ck'
  `)
  const invalidRows = await rows(client, `
    select * from order_items
     where not (quantity > 0 and quantity <= 1000000 and price_cents >= 0)
     order by id
  `)
  return { constraint, invalidRows }
}

function immutableConstraintRows(state: OrderItemConstraintState): JsonRow[] {
  return state.invalidRows.map((row) => {
    const { global_product_id: _globalProductId, organization_inventory_id: _inventoryId, ...immutable } = row
    return immutable
  })
}

function assertExpectedOrderItemConstraint(state: OrderItemConstraintState): void {
  assert(state.constraint.conname === "order_items_values_valid_ck",
    "order_items value constraint is missing")
  assert(state.constraint.convalidated === false,
    "order_items value constraint validation state changed")
  assert(state.constraint.definition === ORDER_ITEM_CHECK_DEFINITION,
    `order_items value constraint definition changed: ${state.constraint.definition}`)
  assert(state.invalidRows.length === 24,
    `Expected 24 pre-existing order_items constraint exceptions, found ${state.invalidRows.length}`)
  assert(state.invalidRows.every((row) =>
    asNumber(row.quantity, `order item ${row.id} quantity`) === 0
      && asNumber(row.price_cents, `order item ${row.id} price`) >= 0),
  "A pre-existing order_items constraint exception is not a zero-quantity legacy artifact")
}

async function collectState(client: PoolClient): Promise<CollectedState> {
  const database = await one(client, `
    select current_database() database_name, current_user database_user,
           current_setting('transaction_read_only') transaction_read_only,
           current_setting('transaction_isolation') transaction_isolation,
           now() captured_at
  `)
  const organization = await one(client,
    `select id, code, name, status from organizations where id = $1`, [ORGANIZATION.id])

  const products = await rows(client, `
    select * from global_products where id = any($1::int[]) order by id
  `, [MEMBER_IDS])
  const organizationInventory = await rows(client, `
    select * from organization_inventory
     where global_product_id = any($1::int[])
     order by global_product_id, organization_id, id
  `, [MEMBER_IDS])
  const inventoryIds = organizationInventory.map((row) => Number(row.id))
  const branchInventory = inventoryIds.length === 0 ? [] : await rows(client, `
    select bi.* from branch_inventory bi
     where bi.organization_inventory_id = any($1::int[])
     order by bi.organization_inventory_id, bi.branch_id, bi.id
  `, [inventoryIds])
  const organizationProducts = await rows(client, `
    select * from organization_products
     where global_product_id = any($1::int[])
     order by organization_id, global_product_id, id
  `, [MEMBER_IDS])
  const legacyMappings = await rows(client, `
    select * from legacy_product_mappings
     where global_product_id = any($1::int[])
     order by organization_id, source_system, normalized_name, id
  `, [MEMBER_IDS])
  const orderItems = await rows(client, `
    select oi.*, o.created_at order_created_at,
           exists (
             select 1 from legacy_order_imports loi
              where loi.order_id = oi.order_id
                and loi.organization_id = $2
                and loi.source_system = $3
           ) is_ke_legacy
      from order_items oi
      join orders o on o.id = oi.order_id
     where oi.global_product_id = any($1::int[])
     order by oi.id
  `, [MEMBER_IDS, ORGANIZATION.id, SOURCE_SYSTEM])
  const affectedOrderIds = [...new Set(orderItems
    .filter((row) => Number(row.organization_id) === ORGANIZATION.id)
    .map((row) => Number(row.order_id)))].sort((a, b) => a - b)
  const affectedOrders = affectedOrderIds.length === 0 ? [] : await rows(client, `
    select id, organization_id, tid, status, fulfillment_status, payment_status,
           subtotal_cents, tax_cents, total_cents, refund_amount_cents,
           created_at, updated_at
      from orders where id = any($1::int[]) order by id
  `, [affectedOrderIds])
  const affectedOrderItemIds = orderItems.map((row) => Number(row.id))
  const refundItems = affectedOrderItemIds.length === 0 ? [] : await rows(client, `
    select ri.* from refund_items ri
     where ri.order_item_id = any($1::int[])
     order by ri.id
  `, [affectedOrderItemIds])

  const unsupported = {
    branchProducts: await rows(client,
      `select * from branch_products where global_product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    productAssignments: await rows(client,
      `select * from product_assignments where global_product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    restockRequests: await rows(client,
      `select * from restock_requests where global_product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    productModifiers: await rows(client,
      `select * from product_modifiers where product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    quantityBudgets: await rows(client,
      `select * from product_quantity_budgets where global_product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    quantityAllocations: await rows(client,
      `select * from product_quantity_budget_allocations where global_product_id = any($1::int[]) order by id`, [LOSER_IDS]),
    supportThreads: await rows(client,
      `select * from support_threads where product_id = any($1::int[]) order by id`, [LOSER_IDS]),
  }
  const inventoryDependencies = inventoryIds.length === 0 ? [] : await rows(client, `
    select oi.id organization_inventory_id,
           (select count(*)::int from group_inventory_prices x where x.organization_inventory_id=oi.id) group_prices,
           (select count(*)::int from product_quantity_budgets x where x.organization_inventory_id=oi.id) quantity_budgets,
           (select count(*)::int from product_quantity_budget_allocations x where x.organization_inventory_id=oi.id) quantity_allocations
      from organization_inventory oi
     where oi.id = any($1::int[])
     order by oi.id
  `, [inventoryIds])
  const jsonAuditReferences = await rows(client, `
    select id, file_name, status, imported_product_ids, created_at
      from product_import_batches
     where exists (
       select 1 from jsonb_array_elements_text(coalesce(imported_product_ids, '[]'::jsonb)) x(value)
        where x.value ~ '^[0-9]+$' and x.value::int = any($1::int[])
     )
     order by id
  `, [LOSER_IDS])

  return {
    database,
    organization,
    products,
    organizationInventory,
    branchInventory,
    organizationProducts,
    legacyMappings,
    orderItems,
    affectedOrders,
    refundItems,
    unsupported,
    inventoryDependencies,
    jsonAuditReferences,
  }
}

function protectedFingerprints(state: CollectedState): JsonRow {
  const immutableOrderItems = state.orderItems.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    orderId: row.order_id,
    productName: row.product_name,
    productCode: row.product_code,
    unit: row.unit,
    quantity: row.quantity,
    priceCents: row.price_cents,
    createdAt: row.created_at,
  }))
  const canonicalBasePrices = CLUSTERS.map((cluster) => {
    const product = state.products.find((row) => Number(row.id) === cluster.canonicalId)
    return { id: cluster.canonicalId, basePriceCents: product?.base_price_cents }
  })
  const protectedOtherTenants = state.organizationInventory.filter((row) =>
    Number(row.organization_id) !== ORGANIZATION.id
      && Number(row.id) !== 352,
  )
  const otherTenantOrderItems = state.orderItems.filter((row) =>
    Number(row.organization_id) !== ORGANIZATION.id,
  )
  return {
    immutableOrderItems: digestOf(immutableOrderItems),
    affectedOrders: digestOf(state.affectedOrders),
    refundItems: digestOf(state.refundItems),
    canonicalBasePrices: digestOf(canonicalBasePrices),
    protectedOtherTenants: digestOf(protectedOtherTenants),
    otherTenantOrderItems: digestOf(otherTenantOrderItems),
  }
}

function assertNeutralOrganizationProduct(row: JsonRow, label: string): void {
  assert(row.custom_name == null, `${label} carries a custom name`)
  assert(row.custom_description == null, `${label} carries a custom description`)
  assert(row.custom_price_cents == null, `${label} carries a custom price`)
  assert(row.custom_image_url == null, `${label} carries a custom image`)
  assert(Number(row.priority ?? 0) === 0, `${label} carries non-zero priority`)
  assert(Array.isArray(row.tags) && row.tags.length === 0, `${label} carries tags`)
  assert(row.metadata && Object.keys(row.metadata).length === 0, `${label} carries metadata`)
}

function buildPlan(state: CollectedState, constraintState: OrderItemConstraintState): MergePlan {
  assertExpectedOrderItemConstraint(constraintState)
  assert(
    Number(state.organization.id) === ORGANIZATION.id
      && state.organization.code === ORGANIZATION.code
      && state.organization.name === ORGANIZATION.name
      && state.organization.status === "active",
    `Organization identity is not ${ORGANIZATION_CONFIRMATION}`,
  )
  assert(state.products.length === MEMBER_IDS.length,
    `Expected ${MEMBER_IDS.length} product rows, found ${state.products.length}`)
  for (const rowsForTable of Object.values(state.unsupported)) {
    assert(rowsForTable.length === 0,
      `Unsupported losing-product dependency found: ${JSON.stringify(rowsForTable[0])}`)
  }
  for (const dependency of state.inventoryDependencies) {
    assert(Number(dependency.group_prices) === 0, `Inventory ${dependency.organization_inventory_id} has group prices`)
    assert(Number(dependency.quantity_budgets) === 0, `Inventory ${dependency.organization_inventory_id} has quantity budgets`)
    assert(Number(dependency.quantity_allocations) === 0, `Inventory ${dependency.organization_inventory_id} has quantity allocations`)
  }

  const plans: ClusterPlan[] = []
  for (const config of CLUSTERS) {
    const memberIds = [config.canonicalId, ...config.losers.map((loser) => loser.id)]
    const loserIds = config.losers.map((loser) => loser.id)
    const canonicalProduct = state.products.find((row) => Number(row.id) === config.canonicalId)
    assert(canonicalProduct?.name === config.canonicalName,
      `${config.key}: canonical product identity changed`)
    assert(canonicalProduct.deleted_at == null, `${config.key}: canonical product is deleted`)
    assert(canonicalProduct.metadata?.legacySource !== SOURCE_SYSTEM,
      `${config.key}: canonical product is migration-owned`)
    for (const loser of config.losers) {
      const product = state.products.find((row) => Number(row.id) === loser.id)
      assert(product?.name === loser.name, `${config.key}: losing product ${loser.id} identity changed`)
      assert(product.deleted_at == null, `${config.key}: losing product ${loser.id} is deleted`)
      const hasKeLegacyMapping = state.legacyMappings.some((row) =>
        Number(row.organization_id) === ORGANIZATION.id
          && row.source_system === SOURCE_SYSTEM
          && Number(row.global_product_id) === loser.id)
      assert(product.metadata?.legacySource === SOURCE_SYSTEM || hasKeLegacyMapping,
        `${config.key}: losing product ${loser.id} is not K-Electric migration-owned`)
    }

    const losingOrderItems = state.orderItems.filter((row) => loserIds.includes(Number(row.global_product_id)))
    assert(losingOrderItems.every((row) =>
      Number(row.organization_id) === ORGANIZATION.id && row.is_ke_legacy === true),
    `${config.key}: a losing product is referenced by a non-K-Electric or non-legacy order`)
    const keMemberOrderItems = state.orderItems.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id && memberIds.includes(Number(row.global_product_id)))
    const positiveLines = keMemberOrderItems.filter((row) =>
      asNumber(row.quantity, `${config.key} quantity`) > 0
        && asNumber(row.price_cents, `${config.key} price`) > 0)
      .sort((left, right) => {
        const time = new Date(String(right.order_created_at)).getTime()
          - new Date(String(left.order_created_at)).getTime()
        return time || Number(right.id) - Number(left.id)
      })
    assert(positiveLines.length > 0, `${config.key}: no positive K-Electric order price exists`)
    const latest = positiveLines[0]

    const orderBuckets = new Map<number, number[]>()
    for (const item of keMemberOrderItems) {
      const orderId = Number(item.order_id)
      orderBuckets.set(orderId, [...(orderBuckets.get(orderId) ?? []), Number(item.global_product_id)])
    }
    const mixedOrder = [...orderBuckets.entries()].find(([, ids]) => new Set(ids).size > 1)
    assert(!mixedOrder, `${config.key}: order ${mixedOrder?.[0]} contains multiple duplicate member products`)

    const liveKeInventory = state.organizationInventory.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id
        && memberIds.includes(Number(row.global_product_id))
        && row.deleted_at == null)
    const expectedInventoryProducts = new Set(memberIds.filter((id) =>
      id !== config.canonicalId || liveKeInventory.some((row) => Number(row.global_product_id) === id)))
    for (const loserId of loserIds) {
      assert(liveKeInventory.filter((row) => Number(row.global_product_id) === loserId).length === 1,
        `${config.key}: expected one live K-Electric inventory row for loser ${loserId}`)
    }
    assert(liveKeInventory.length === expectedInventoryProducts.size,
      `${config.key}: unexpected K-Electric organization inventory multiplicity`)

    const canonicalInventory = liveKeInventory.find((row) => Number(row.global_product_id) === config.canonicalId)
    const itemUsage = new Map<number, number>()
    for (const item of keMemberOrderItems) {
      const inventoryId = Number(item.organization_inventory_id)
      itemUsage.set(inventoryId, (itemUsage.get(inventoryId) ?? 0) + 1)
    }
    const survivor = canonicalInventory ?? [...liveKeInventory].sort((left, right) =>
      (itemUsage.get(Number(right.id)) ?? 0) - (itemUsage.get(Number(left.id)) ?? 0)
        || Number(left.id) - Number(right.id))[0]
    assert(survivor, `${config.key}: no K-Electric inventory survivor exists`)
    const sourceInventory = liveKeInventory.filter((row) => Number(row.id) !== Number(survivor.id))

    const constraintBlockedOrderItems = losingOrderItems.filter((row) =>
      !(asNumber(row.quantity, `${config.key} quantity`) > 0
        && asNumber(row.quantity, `${config.key} quantity`) <= 1_000_000
        && asNumber(row.price_cents, `${config.key} price`) >= 0))
    const knownConstraintExceptions = new Set(constraintState.invalidRows.map((row) => Number(row.id)))
    assert(constraintBlockedOrderItems.every((row) => knownConstraintExceptions.has(Number(row.id))),
      `${config.key}: a blocked order item is absent from the constraint exception snapshot`)
    assert(constraintBlockedOrderItems.every((row) =>
      asNumber(row.quantity, `${config.key} blocked quantity`) === 0
        && asNumber(row.quantity, `${config.key} blocked quantity`)
          * asNumber(row.price_cents, `${config.key} blocked price`) === 0
        && Number(row.organization_inventory_id) === Number(survivor.id)),
    `${config.key}: a constraint-blocked row is not a zero-gross survivor-inventory artifact`)

    const branchRows = state.branchInventory.filter((row) =>
      liveKeInventory.some((inventory) => Number(inventory.id) === Number(row.organization_inventory_id)))
    assert(branchRows.every((row) => Number(row.organization_id) === ORGANIZATION.id),
      `${config.key}: K-Electric inventory is attached to a foreign branch`)
    const branchGroups = new Map<number, JsonRow[]>()
    for (const branch of branchRows) {
      const branchId = Number(branch.branch_id)
      branchGroups.set(branchId, [...(branchGroups.get(branchId) ?? []), branch])
    }

    const orgProducts = state.organizationProducts.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id
        && memberIds.includes(Number(row.global_product_id)))
    assert(orgProducts.length >= 1, `${config.key}: no K-Electric organization_products row exists`)
    const canonicalOrgProduct = orgProducts.find((row) => Number(row.global_product_id) === config.canonicalId)
    const survivorOrgProduct = canonicalOrgProduct
      ?? orgProducts.find((row) => Number(row.global_product_id) === Number(survivor.global_product_id))
      ?? orgProducts[0]
    for (const row of orgProducts.filter((row) => Number(row.id) !== Number(survivorOrgProduct.id))) {
      assertNeutralOrganizationProduct(row, `${config.key} organization_products ${row.id}`)
    }

    const mappings = state.legacyMappings.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id
        && row.source_system === SOURCE_SYSTEM
        && memberIds.includes(Number(row.global_product_id)))
    assert(mappings.length >= loserIds.length, `${config.key}: expected legacy mappings are missing`)

    const memberProducts = state.products.filter((row) => memberIds.includes(Number(row.id)))
    const maxStock = Math.max(...memberProducts.map((row) => asNumber(row.stock_quantity, `${config.key} stock`)))
    const grossCents = losingOrderItems.reduce((total, row) =>
      total + asNumber(row.quantity, `${config.key} quantity`) * asNumber(row.price_cents, `${config.key} price`), 0)

    const externalLoserInventories = state.organizationInventory.filter((row) =>
      loserIds.includes(Number(row.global_product_id))
        && Number(row.organization_id) !== ORGANIZATION.id
        && row.deleted_at == null)
    if (config.retainedExternal) {
      assert(externalLoserInventories.some((row) =>
        Number(row.id) === config.retainedExternal!.inventoryId
          && Number(row.organization_id) === config.retainedExternal!.organizationId
          && Number(row.global_product_id) === config.retainedExternal!.productId),
      `${config.key}: protected external inventory changed`)
    }
    if (config.removableDemoInventoryId != null) {
      assert(externalLoserInventories.some((row) => Number(row.id) === config.removableDemoInventoryId),
        `${config.key}: approved K-E-Demo inventory is missing`)
    }
    const allowedExternalIds = new Set([
      config.retainedExternal?.inventoryId,
      config.removableDemoInventoryId,
    ].filter((value): value is number => value != null))
    const unexpectedExternal = externalLoserInventories.find((row) => !allowedExternalIds.has(Number(row.id)))
    assert(!unexpectedExternal,
      `${config.key}: unexpected external organization inventory ${unexpectedExternal?.id}`)

    plans.push({
      key: config.key,
      canonicalId: config.canonicalId,
      canonicalName: config.canonicalName,
      loserIds,
      survivorOrganizationInventoryId: Number(survivor.id),
      survivorOriginalProductId: Number(survivor.global_product_id),
      sourceOrganizationInventoryIds: sourceInventory.map((row) => Number(row.id)).sort((a, b) => a - b),
      latestKePriceCents: asNumber(latest.price_cents, `${config.key} latest price`),
      latestPriceOrderId: Number(latest.order_id),
      latestPriceOrderItemId: Number(latest.id),
      latestPriceOrderCreatedAt: String(latest.order_created_at),
      canonicalBasePriceCents: asNumber(canonicalProduct.base_price_cents, `${config.key} base price`),
      canonicalStockBefore: String(canonicalProduct.stock_quantity),
      memberStocksBefore: memberProducts.map((row) => ({
        productId: Number(row.id), stock: String(row.stock_quantity),
      })).sort((left, right) => left.productId - right.productId),
      canonicalStockAfter: String(maxStock),
      orderItemIdsToMove: losingOrderItems.map((row) => Number(row.id)).sort((a, b) => a - b),
      constraintBlockedOrderItemIds: constraintBlockedOrderItems
        .map((row) => Number(row.id)).sort((a, b) => a - b),
      orderItemsToMove: losingOrderItems.length,
      affectedOrderGrossCents: String(grossCents),
      branchRowsBefore: branchRows.length,
      branchUnionCount: branchGroups.size,
      branchCollisionCount: [...branchGroups.values()].filter((group) => group.length > 1).length,
      organizationProductSurvivorId: Number(survivorOrgProduct.id),
      organizationProductDeleteIds: orgProducts.filter((row) => Number(row.id) !== Number(survivorOrgProduct.id))
        .map((row) => Number(row.id)).sort((a, b) => a - b),
      mappingIds: mappings.map((row) => Number(row.id)).sort((a, b) => a - b),
      retainedExternal: config.retainedExternal ?? null,
      removableDemoInventoryId: config.removableDemoInventoryId ?? null,
    })
  }

  const demoInventory = state.organizationInventory.find((row) => Number(row.id) === 352)
  if (demoInventory) {
    const demoBranches = state.branchInventory.filter((row) => Number(row.organization_inventory_id) === 352)
    assert(demoBranches.length === 0, "K-E-Demo inventory 352 unexpectedly has branch dependencies")
    const demoDependency = state.inventoryDependencies.find((row) => Number(row.organization_inventory_id) === 352)
    assert(demoDependency && Number(demoDependency.group_prices) === 0
      && Number(demoDependency.quantity_budgets) === 0
      && Number(demoDependency.quantity_allocations) === 0,
    "K-E-Demo inventory 352 unexpectedly has pricing/budget dependencies")
    assert(!state.orderItems.some((row) => Number(row.organization_inventory_id) === 352),
      "K-E-Demo inventory 352 unexpectedly has order dependencies")
    assert(!state.legacyMappings.some((row) => Number(row.organization_inventory_id) === 352),
      "K-E-Demo inventory 352 unexpectedly has legacy mapping dependencies")
  }

  const fingerprints = protectedFingerprints(state)
  const movedOrderItemIds = new Set(plans.flatMap((plan) => plan.orderItemIdsToMove))
  const constraintBlockedOrderItemIds = plans
    .flatMap((plan) => plan.constraintBlockedOrderItemIds).sort((a, b) => a - b)
  const untouchedConstraintRows = constraintState.invalidRows.filter((row) =>
    !constraintBlockedOrderItemIds.includes(Number(row.id)))
  return {
    organization: ORGANIZATION,
    policy: {
      canonicalGlobalBasePrice: "unchanged",
      keOrganizationPrice: "latest positive K-Electric order line across each confirmed cluster",
      historicalOrderSnapshots: "name, code, unit, quantity, price_cents and order money unchanged",
      canonicalStock: "maximum of canonical and losing product stock",
      losingStock: "zero only when the losing global product can be safely deactivated",
      keDemoProduct182Inventory352: "remove only after zero-dependency assertion",
      ublProduct202Inventory326: "retain byte-for-byte; keep global product 202 active",
      productImportBatchJson: "historical audit reference retained",
      constraintExceptionHandling: "three zero-quantity/zero-gross legacy rows receive identity-only updates inside an exact, rollback-protected NOT VALID constraint recreation window",
      orderItemConstraint: {
        definition: constraintState.constraint.definition,
        existingExceptionRows: constraintState.invalidRows.length,
        immutableRowsSha256: digestOf(immutableConstraintRows(constraintState)),
        untouchedRowsSha256: digestOf(untouchedConstraintRows),
      },
    },
    clusters: plans,
    totals: {
      clusters: plans.length,
      canonicalProducts: plans.length,
      losingProducts: plans.reduce((sum, plan) => sum + plan.loserIds.length, 0),
      orderItemsToMove: plans.reduce((sum, plan) => sum + plan.orderItemsToMove, 0),
      orderItemsDirectUpdate: plans.reduce((sum, plan) =>
        sum + plan.orderItemsToMove - plan.constraintBlockedOrderItemIds.length, 0),
      orderItemsConstraintWindowUpdate: constraintBlockedOrderItemIds.length,
      affectedGrossCents: String(plans.reduce((sum, plan) => sum + Number(plan.affectedOrderGrossCents), 0)),
      branchRowsBefore: plans.reduce((sum, plan) => sum + plan.branchRowsBefore, 0),
      branchUnionCount: plans.reduce((sum, plan) => sum + plan.branchUnionCount, 0),
      branchCollisions: plans.reduce((sum, plan) => sum + plan.branchCollisionCount, 0),
      refundItemRows: state.refundItems.filter((row) => movedOrderItemIds.has(Number(row.order_item_id))).length,
      jsonAuditReferencesRetained: state.jsonAuditReferences.length,
    },
    protectedFingerprints: fingerprints,
  }
}

async function assertWritableSchema(client: PoolClient): Promise<void> {
  const required: Record<string, string[]> = {
    global_products: ["id", "base_price_cents", "stock_quantity", "status", "metadata", "updated_at"],
    organization_inventory: ["id", "organization_id", "global_product_id", "custom_price_cents", "updated_at"],
    branch_inventory: ["id", "branch_id", "organization_inventory_id", "is_visible", "is_active", "deleted_at", "updated_at"],
    organization_products: ["id", "organization_id", "global_product_id", "updated_at"],
    legacy_product_mappings: ["id", "organization_id", "global_product_id", "organization_inventory_id", "updated_at"],
    order_items: ["id", "organization_id", "global_product_id", "organization_inventory_id", "price_cents"],
  }
  const found = await rows(client, `
    select table_name, column_name from information_schema.columns
     where table_schema='public' and table_name = any($1::text[])
  `, [Object.keys(required)])
  const columns = new Set(found.map((row) => `${row.table_name}.${row.column_name}`))
  for (const [table, names] of Object.entries(required)) {
    const missing = names.filter((name) => !columns.has(`${table}.${name}`))
    assert(missing.length === 0, `${table} is missing required columns: ${missing.join(", ")}`)
  }
}

async function lockTables(client: PoolClient): Promise<void> {
  await client.query(`
    lock table global_products, organization_inventory, branch_inventory,
      organization_products, branch_products, legacy_product_mappings,
      order_items, refund_items, product_quantity_budgets,
      product_quantity_budget_allocations, group_inventory_prices,
      restock_requests, product_assignments, product_modifiers, support_threads
    in share row exclusive mode
  `)
}

async function executeCluster(client: PoolClient, plan: ClusterPlan): Promise<JsonRow> {
  const survivorId = plan.survivorOrganizationInventoryId
  if (plan.survivorOriginalProductId !== plan.canonicalId) {
    const changed = await rows(client, `
      update organization_inventory
         set global_product_id=$1, updated_at=now()
       where id=$2 and organization_id=$3 and global_product_id=$4 and deleted_at is null
       returning id
    `, [plan.canonicalId, survivorId, ORGANIZATION.id, plan.survivorOriginalProductId])
    assert(changed.length === 1, `${plan.key}: failed to re-key survivor organization inventory`)
  }

  let branchRowsDeleted = 0
  let branchRowsMoved = 0
  for (const sourceId of plan.sourceOrganizationInventoryIds) {
    await client.query(`
      update branch_inventory target
         set is_visible = target.is_visible or source.is_visible,
             is_active = target.is_active or source.is_active,
             deleted_at = case
               when target.deleted_at is null or source.deleted_at is null then null
               else greatest(target.deleted_at, source.deleted_at)
             end,
             updated_at = now()
        from branch_inventory source
       where target.organization_inventory_id=$1
         and source.organization_inventory_id=$2
         and target.branch_id=source.branch_id
    `, [survivorId, sourceId])
    const deleted = await client.query(`
      delete from branch_inventory source
       where source.organization_inventory_id=$1
         and exists (
           select 1 from branch_inventory target
            where target.organization_inventory_id=$2
              and target.branch_id=source.branch_id
         )
    `, [sourceId, survivorId])
    branchRowsDeleted += deleted.rowCount ?? 0
    const moved = await client.query(`
      update branch_inventory
         set organization_inventory_id=$1, updated_at=now()
       where organization_inventory_id=$2
    `, [survivorId, sourceId])
    branchRowsMoved += moved.rowCount ?? 0
  }

  const directlyWritableOrderItemIds = plan.orderItemIdsToMove.filter((id) =>
    !plan.constraintBlockedOrderItemIds.includes(id))
  const movedOrderItems = await client.query(`
    update order_items oi
       set global_product_id=$1, organization_inventory_id=$2
     where oi.id = any($3::int[])
       and oi.organization_id=$4
       and oi.global_product_id = any($5::int[])
       and exists (
         select 1 from legacy_order_imports loi
          where loi.order_id=oi.order_id
            and loi.organization_id=$4
            and loi.source_system=$6
       )
  `, [plan.canonicalId, survivorId, directlyWritableOrderItemIds, ORGANIZATION.id, plan.loserIds, SOURCE_SYSTEM])
  assert((movedOrderItems.rowCount ?? 0) === directlyWritableOrderItemIds.length,
    `${plan.key}: expected ${directlyWritableOrderItemIds.length} direct order-item updates, wrote ${movedOrderItems.rowCount ?? 0}`)

  const movedMappings = await client.query(`
    update legacy_product_mappings
       set global_product_id=$1, organization_inventory_id=$2, updated_at=now()
     where id = any($3::int[])
       and organization_id=$4 and source_system=$5
  `, [plan.canonicalId, survivorId, plan.mappingIds, ORGANIZATION.id, SOURCE_SYSTEM])
  assert((movedMappings.rowCount ?? 0) === plan.mappingIds.length,
    `${plan.key}: legacy mapping update count changed`)

  if (plan.organizationProductDeleteIds.length > 0) {
    const deleted = await client.query(`
      delete from organization_products
       where id = any($1::int[]) and organization_id=$2
    `, [plan.organizationProductDeleteIds, ORGANIZATION.id])
    assert((deleted.rowCount ?? 0) === plan.organizationProductDeleteIds.length,
      `${plan.key}: organization-product delete count changed`)
  }
  const organizationProduct = await rows(client, `
    update organization_products
       set global_product_id=$1, updated_at=now()
     where id=$2 and organization_id=$3
     returning id
  `, [plan.canonicalId, plan.organizationProductSurvivorId, ORGANIZATION.id])
  assert(organizationProduct.length === 1, `${plan.key}: organization-product survivor is missing`)

  const priced = await rows(client, `
    update organization_inventory
       set custom_price_cents=$1, updated_at=now()
     where id=$2 and organization_id=$3 and global_product_id=$4 and deleted_at is null
     returning id
  `, [plan.latestKePriceCents, survivorId, ORGANIZATION.id, plan.canonicalId])
  assert(priced.length === 1, `${plan.key}: failed to set K-Electric organization price`)

  for (const sourceId of plan.sourceOrganizationInventoryIds) {
    const references = await one(client, `
      select
        (select count(*)::int from branch_inventory where organization_inventory_id=$1) branches,
        (select count(*)::int from order_items where organization_inventory_id=$1) order_items,
        (select count(*)::int from legacy_product_mappings where organization_inventory_id=$1) mappings,
        (select count(*)::int from group_inventory_prices where organization_inventory_id=$1) group_prices,
        (select count(*)::int from product_quantity_budgets where organization_inventory_id=$1) quantity_budgets,
        (select count(*)::int from product_quantity_budget_allocations where organization_inventory_id=$1) quantity_allocations
    `, [sourceId])
    assert(Object.values(references).every((value) => Number(value) === 0),
      `${plan.key}: source inventory ${sourceId} still has dependencies`)
    const deleted = await client.query(`
      delete from organization_inventory
       where id=$1 and organization_id=$2
    `, [sourceId, ORGANIZATION.id])
    assert((deleted.rowCount ?? 0) === 1, `${plan.key}: failed to remove source inventory ${sourceId}`)
  }

  const stock = await rows(client, `
    update global_products
       set stock_quantity=$1::numeric,
           updated_at=case when stock_quantity is distinct from $1::numeric then now() else updated_at end
     where id=$2 and base_price_cents=$3 and deleted_at is null
     returning id
  `, [plan.canonicalStockAfter, plan.canonicalId, plan.canonicalBasePriceCents])
  assert(stock.length === 1, `${plan.key}: canonical price/product guard failed during stock preservation`)

  return {
    key: plan.key,
    orderItemsMovedDirectly: movedOrderItems.rowCount ?? 0,
    orderItemsMovedInConstraintWindow: 0,
    orderItemsMoved: movedOrderItems.rowCount ?? 0,
    mappingsMoved: movedMappings.rowCount ?? 0,
    branchRowsMoved,
    branchRowsDeleted,
    keOrganizationPriceCents: plan.latestKePriceCents,
    canonicalStock: plan.canonicalStockAfter,
  }
}

async function moveConstraintBlockedOrderItems(
  client: PoolClient,
  plan: MergePlan,
  before: OrderItemConstraintState,
): Promise<Map<string, number>> {
  const plannedIds = plan.clusters
    .flatMap((cluster) => cluster.constraintBlockedOrderItemIds).sort((a, b) => a - b)
  if (plannedIds.length === 0) return new Map()

  assertExpectedOrderItemConstraint(before)
  assert(plannedIds.length === Number(plan.totals.orderItemsConstraintWindowUpdate),
    "Constraint-window order-item total changed")
  const plannedSet = new Set(plannedIds)
  const untouchedBefore = before.invalidRows.filter((row) => !plannedSet.has(Number(row.id)))
  assert(digestOf(immutableConstraintRows(before)) === plan.policy.orderItemConstraint.immutableRowsSha256,
    "Immutable constraint-exception fingerprint changed before the constraint window")
  assert(digestOf(untouchedBefore) === plan.policy.orderItemConstraint.untouchedRowsSha256,
    "Untouched constraint-exception fingerprint changed before the constraint window")

  // Fail instead of waiting behind live traffic. The exclusive lock is held only
  // for these three identity-only writes, constraint recreation, validation and commit.
  await client.query("set local lock_timeout = '5s'")
  await client.query("lock table order_items in access exclusive mode")
  const lockedConstraint = await collectOrderItemConstraintState(client)
  assert(digestOf(lockedConstraint) === digestOf(before),
    "order_items constraint exceptions changed before the exclusive window")

  await client.query("alter table order_items drop constraint order_items_values_valid_ck")
  const movedByCluster = new Map<string, number>()
  for (const cluster of plan.clusters) {
    if (cluster.constraintBlockedOrderItemIds.length === 0) continue
    const moved = await client.query(`
      update order_items oi
         set global_product_id=$1, organization_inventory_id=$2
       where oi.id=any($3::int[])
         and oi.organization_id=$4
         and oi.global_product_id=any($5::int[])
         and oi.quantity=0
         and oi.price_cents >= 0
         and exists (
           select 1 from legacy_order_imports loi
            where loi.order_id=oi.order_id
              and loi.organization_id=$4
              and loi.source_system=$6
         )
    `, [cluster.canonicalId, cluster.survivorOrganizationInventoryId,
      cluster.constraintBlockedOrderItemIds, ORGANIZATION.id, cluster.loserIds, SOURCE_SYSTEM])
    assert((moved.rowCount ?? 0) === cluster.constraintBlockedOrderItemIds.length,
      `${cluster.key}: constraint-window order-item update count changed`)
    movedByCluster.set(cluster.key, moved.rowCount ?? 0)
  }
  assert([...movedByCluster.values()].reduce((sum, count) => sum + count, 0) === plannedIds.length,
    "Constraint-window order-item total does not match the plan")

  await client.query(`
    alter table order_items add constraint order_items_values_valid_ck
    check (quantity > 0 and quantity <= 1000000 and price_cents >= 0) not valid
  `)
  const after = await collectOrderItemConstraintState(client)
  assertExpectedOrderItemConstraint(after)
  assert(digestOf(immutableConstraintRows(after)) === plan.policy.orderItemConstraint.immutableRowsSha256,
    "A historical value changed during the constraint window")
  const untouchedAfter = after.invalidRows.filter((row) => !plannedSet.has(Number(row.id)))
  assert(digestOf(untouchedAfter) === plan.policy.orderItemConstraint.untouchedRowsSha256,
    "A non-target constraint exception changed during the constraint window")
  for (const cluster of plan.clusters) {
    const ids = new Set(cluster.constraintBlockedOrderItemIds)
    const changed = after.invalidRows.filter((row) => ids.has(Number(row.id)))
    assert(changed.length === ids.size && changed.every((row) =>
      Number(row.global_product_id) === cluster.canonicalId
        && Number(row.organization_inventory_id) === cluster.survivorOrganizationInventoryId),
    `${cluster.key}: constraint-window identity postcondition failed`)
  }
  return movedByCluster
}

async function cleanDemoInventory(client: PoolClient): Promise<void> {
  const references = await one(client, `
    select
      (select count(*)::int from branch_inventory where organization_inventory_id=352) branches,
      (select count(*)::int from order_items where organization_inventory_id=352) order_items,
      (select count(*)::int from legacy_product_mappings where organization_inventory_id=352) mappings,
      (select count(*)::int from group_inventory_prices where organization_inventory_id=352) group_prices,
      (select count(*)::int from product_quantity_budgets where organization_inventory_id=352) quantity_budgets,
      (select count(*)::int from product_quantity_budget_allocations where organization_inventory_id=352) quantity_allocations
  `)
  assert(Object.values(references).every((value) => Number(value) === 0),
    "K-E-Demo inventory 352 gained a dependency; refusing cleanup")
  const deleted = await client.query(`
    delete from organization_inventory
     where id=352 and organization_id=2 and global_product_id=182 and deleted_at is null
  `)
  assert((deleted.rowCount ?? 0) === 1, "K-E-Demo inventory 352 changed before cleanup")
}

async function deactivateSafeLosers(client: PoolClient, plan: MergePlan): Promise<void> {
  for (const cluster of plan.clusters) {
    for (const loserId of cluster.loserIds) {
      if (cluster.retainedExternal?.productId === loserId) continue
      const references = await one(client, `
        select
          (select count(*)::int from organization_inventory where global_product_id=$1) organization_inventory,
          (select count(*)::int from organization_products where global_product_id=$1) organization_products,
          (select count(*)::int from branch_products where global_product_id=$1) branch_products,
          (select count(*)::int from legacy_product_mappings where global_product_id=$1) mappings,
          (select count(*)::int from order_items where global_product_id=$1) order_items,
          (select count(*)::int from product_assignments where global_product_id=$1) product_assignments,
          (select count(*)::int from product_modifiers where product_id=$1) product_modifiers,
          (select count(*)::int from product_quantity_budgets where global_product_id=$1) quantity_budgets,
          (select count(*)::int from product_quantity_budget_allocations where global_product_id=$1) quantity_allocations,
          (select count(*)::int from restock_requests where global_product_id=$1) restock_requests,
          (select count(*)::int from support_threads where product_id=$1) support_threads
      `, [loserId])
      assert(Object.values(references).every((value) => Number(value) === 0),
        `${cluster.key}: losing product ${loserId} still has dependencies: ${JSON.stringify(references)}`)
      const changed = await rows(client, `
        update global_products
           set status='inactive', stock_quantity=0,
               metadata=coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                 'mergedIntoProductId', $1::int,
                 'mergedForOrganizationId', $2::int,
                 'mergeReason', 'confirmed K-Electric duplicate'
               ),
               updated_at=now()
         where id=$3 and deleted_at is null
         returning id
      `, [cluster.canonicalId, ORGANIZATION.id, loserId])
      assert(changed.length === 1, `${cluster.key}: failed to deactivate losing product ${loserId}`)
    }
  }
}

async function validatePostState(
  client: PoolClient,
  before: CollectedState,
  plan: MergePlan,
): Promise<JsonRow> {
  const after = await collectState(client)
  const afterFingerprints = protectedFingerprints(after)
  for (const [key, value] of Object.entries(plan.protectedFingerprints)) {
    assert(afterFingerprints[key] === value, `Protected fingerprint changed: ${key}`)
  }

  for (const cluster of plan.clusters) {
    const movedIds = new Set(cluster.orderItemIdsToMove)
    const movedRows = after.orderItems.filter((row) => movedIds.has(Number(row.id)))
    assert(movedRows.length === cluster.orderItemsToMove,
      `${cluster.key}: post-merge order-item count changed`)
    assert(movedRows.every((row) =>
      Number(row.global_product_id) === cluster.canonicalId
        && Number(row.organization_inventory_id) === cluster.survivorOrganizationInventoryId),
    `${cluster.key}: post-merge order-item identities are inconsistent`)

    const inventory = after.organizationInventory.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id
        && ([cluster.canonicalId, ...cluster.loserIds].includes(Number(row.global_product_id)))
        && row.deleted_at == null)
    assert(inventory.length === 1
      && Number(inventory[0].id) === cluster.survivorOrganizationInventoryId
      && Number(inventory[0].global_product_id) === cluster.canonicalId
      && Number(inventory[0].custom_price_cents) === cluster.latestKePriceCents,
    `${cluster.key}: K-Electric inventory/price postcondition failed`)

    const branchRows = after.branchInventory.filter((row) =>
      Number(row.organization_inventory_id) === cluster.survivorOrganizationInventoryId)
    assert(branchRows.length === cluster.branchUnionCount,
      `${cluster.key}: branch union count changed from planned ${cluster.branchUnionCount} to ${branchRows.length}`)
    assert(new Set(branchRows.map((row) => Number(row.branch_id))).size === branchRows.length,
      `${cluster.key}: duplicate branch assignments remain`)

    const mappings = after.legacyMappings.filter((row) => cluster.mappingIds.includes(Number(row.id)))
    assert(mappings.length === cluster.mappingIds.length && mappings.every((row) =>
      Number(row.global_product_id) === cluster.canonicalId
        && Number(row.organization_inventory_id) === cluster.survivorOrganizationInventoryId),
    `${cluster.key}: legacy mapping postcondition failed`)

    const organizationProducts = after.organizationProducts.filter((row) =>
      Number(row.organization_id) === ORGANIZATION.id
        && [cluster.canonicalId, ...cluster.loserIds].includes(Number(row.global_product_id)))
    assert(organizationProducts.length === 1
      && Number(organizationProducts[0].id) === cluster.organizationProductSurvivorId
      && Number(organizationProducts[0].global_product_id) === cluster.canonicalId,
    `${cluster.key}: organization-product postcondition failed`)

    const product = after.products.find((row) => Number(row.id) === cluster.canonicalId)
    assert(product && Number(product.base_price_cents) === cluster.canonicalBasePriceCents,
      `${cluster.key}: canonical global base price changed`)
    assert(product && Number(product.stock_quantity) === Number(cluster.canonicalStockAfter),
      `${cluster.key}: canonical stock postcondition failed`)
    for (const loserId of cluster.loserIds) {
      const loser = after.products.find((row) => Number(row.id) === loserId)
      assert(loser, `${cluster.key}: losing product ${loserId} disappeared`)
      if (cluster.retainedExternal?.productId === loserId) {
        assert(loser.status === before.products.find((row) => Number(row.id) === loserId)?.status,
          `${cluster.key}: UBL-shared product ${loserId} status changed`)
      } else {
        assert(loser.status === "inactive" && Number(loser.stock_quantity) === 0,
          `${cluster.key}: losing product ${loserId} was not safely retired`)
      }
    }
  }

  assert(!after.organizationInventory.some((row) => Number(row.id) === 352),
    "K-E-Demo inventory 352 still exists")
  const ubl = after.organizationInventory.find((row) => Number(row.id) === 326)
  const beforeUbl = before.organizationInventory.find((row) => Number(row.id) === 326)
  assert(digestOf(ubl) === digestOf(beforeUbl), "UBL inventory 326 changed")

  return { fingerprints: afterFingerprints }
}

async function main(): Promise<void> {
  const committing = flag("commit")
  const date = new Date().toISOString().slice(0, 10)
  const output = resolve(arg("output") ?? `outputs/ke-confirmed-product-merge-${committing ? "commit" : "preflight"}-${date}.json`)
  assertOutputWritable(output)

  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    await assertWritableSchema(client)
    if (!committing) await client.query("begin transaction isolation level repeatable read read only")
    const state = await collectState(client)
    const constraintState = await collectOrderItemConstraintState(client)
    const plan = buildPlan(state, constraintState)
    const planSha256 = digestOf(plan)
    const report = {
      kind: "KE_CONFIRMED_PRODUCT_MERGE",
      mode: "DRY_RUN",
      generatedAt: new Date().toISOString(),
      database: state.database,
      planSha256,
      requiredCommitArguments: {
        confirmOrganization: ORGANIZATION_CONFIRMATION,
        confirmPlanSha256: planSha256,
        expectedOrderItems: plan.totals.orderItemsToMove,
        confirmation: APPLY_CONFIRMATION,
      },
      plan,
      snapshot: { ...state, orderItemConstraint: constraintState },
    }

    if (!committing) {
      await client.query("rollback")
      writeJsonExclusive(output, report)
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output,
        planSha256,
        totals: plan.totals,
        clusterPrices: plan.clusters.map((cluster) => ({
          key: cluster.key,
          canonicalId: cluster.canonicalId,
          latestKePriceCents: cluster.latestKePriceCents,
          canonicalStockBefore: cluster.canonicalStockBefore,
          canonicalStockAfter: cluster.canonicalStockAfter,
          orderItemsToMove: cluster.orderItemsToMove,
          branchCollisions: cluster.branchCollisionCount,
        })),
      }, null, 2))
      return
    }

    const preflightPath = arg("preflight")
    assert(preflightPath, "Commit requires --preflight=<reviewed dry-run report>")
    const preflight = JSON.parse(readFileSync(resolve(preflightPath), "utf8"))
    assert(preflight.kind === "KE_CONFIRMED_PRODUCT_MERGE" && preflight.mode === "DRY_RUN",
      "The supplied preflight is not a K-Electric product-merge dry run")
    assert(preflight.planSha256 === planSha256,
      "Live plan differs from the supplied preflight; run and review a new dry run")
    assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(arg("confirm-plan-sha256") === planSha256,
      `Commit requires --confirm-plan-sha256=${planSha256}`)
    assert(arg("expected-order-items") === String(plan.totals.orderItemsToMove),
      `Commit requires --expected-order-items=${plan.totals.orderItemsToMove}`)
    assert(arg("confirm") === APPLY_CONFIRMATION,
      `Commit requires --confirm=${APPLY_CONFIRMATION}`)

    const prechangePath = output.replace(/\.json$/i, "") + "-prechange.json"
    const prechange = writeJsonExclusive(prechangePath, {
      kind: "KE_CONFIRMED_PRODUCT_MERGE_PRECHANGE",
      generatedAt: new Date().toISOString(),
      planSha256,
      plan,
      snapshot: { ...state, orderItemConstraint: constraintState },
    })
    const prechangeSha256 = sha256(readFileSync(prechange, "utf8"))

    let auditLogId = 0
    let outcomes: JsonRow[] = []
    let postValidation: JsonRow = {}
    await client.query("begin isolation level serializable")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      await lockTables(client)
      const lockedState = await collectState(client)
      const lockedConstraintState = await collectOrderItemConstraintState(client)
      const lockedPlan = buildPlan(lockedState, lockedConstraintState)
      assert(digestOf(lockedPlan) === planSha256,
        "Protected live state changed after locking; transaction aborted")

      outcomes = []
      for (const cluster of lockedPlan.clusters) {
        outcomes.push(await executeCluster(client, cluster))
      }
      await cleanDemoInventory(client)
      const constraintWindowMoves = await moveConstraintBlockedOrderItems(
        client, lockedPlan, lockedConstraintState)
      for (const outcome of outcomes) {
        const moved = constraintWindowMoves.get(String(outcome.key)) ?? 0
        outcome.orderItemsMovedInConstraintWindow = moved
        outcome.orderItemsMoved = Number(outcome.orderItemsMovedDirectly) + moved
      }
      await deactivateSafeLosers(client, lockedPlan)
      postValidation = await validatePostState(client, lockedState, lockedPlan)

      const audit = await rows(client, `
        insert into audit_logs (
          user_id, organization_id, branch_id, action, entity, entity_id, metadata
        ) values (
          null, $1, null, 'KE_CONFIRMED_PRODUCT_MERGE', 'GlobalProductMerge', $2, $3::jsonb
        ) returning id
      `, [ORGANIZATION.id, planSha256.slice(0, 128), JSON.stringify({
        initiatedBy: "Codex production maintenance requested by workspace user",
        planSha256,
        prechangePath,
        prechangeSha256,
        policy: lockedPlan.policy,
        totals: lockedPlan.totals,
        outcomes,
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId), "Failed to write merge audit log")
      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    const committedReport = {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      auditLogId,
      prechange: { path: prechangePath, sha256: prechangeSha256 },
      outcomes,
      postValidation,
    }
    writeJsonExclusive(output, committedReport)

    const cache = await invalidateCachePrefixes([
      "global-inv", "inventory", "products", "shop", "org-inv", "branch-inv",
      "inv:org-products", "inv:branch-products", "orders", "analytics", "dashboard",
    ])
    console.log(JSON.stringify({
      mode: "COMMITTED",
      output,
      planSha256,
      auditLogId,
      totals: plan.totals,
      outcomes,
      cacheInvalidation: cache,
    }, null, 2))
    const failures = cache.filter((entry) => entry.error)
    if (failures.length > 0) {
      console.warn(`WARNING: ${failures.length} cache prefix(es) could not be invalidated.`)
    }
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

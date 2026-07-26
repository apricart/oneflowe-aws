#!/usr/bin/env tsx
/** Guarded reversal for renumber-ke-legacy-product-codes.ts. */

import { randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"
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

function normalized<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    )
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJson(normalized(left))) === JSON.stringify(canonicalJson(normalized(right)))
}

function assertOutputWritable(path: string): void {
  const absolutePath = resolve(path)
  assert(!existsSync(absolutePath), `Refusing to overwrite existing output: ${absolutePath}`)
  mkdirSync(dirname(absolutePath), { recursive: true })
  const probe = `${absolutePath}.write-probe-${process.pid}`
  writeFileSync(probe, "write-check\n", { encoding: "utf8", flag: "wx" })
  unlinkSync(probe)
}

function writeJsonExclusive(path: string, value: unknown): void {
  const absolutePath = resolve(path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
}

async function one(client: PoolClient, text: string, params: unknown[] = []): Promise<JsonRecord> {
  const result = await client.query(text, params)
  assert(result.rows.length === 1, `Expected one row, found ${result.rows.length}`)
  return result.rows[0]
}

async function count(client: PoolClient, text: string, params: unknown[] = []): Promise<number> {
  return Number((await one(client, text, params)).count)
}

function validateCommitReport(commit: JsonRecord): KeProductCodeMapping[] {
  assert(commit.kind === "KE_LEGACY_PRODUCT_CODE_RENUMBER_COMMIT" && commit.status === "COMPLETED", "Invalid renumber commit report")
  assert(commit.organization?.id === CONFIG.organization.id && commit.organization?.code === CONFIG.organization.code, "Commit report belongs to another organization")
  assert(commit.batchId === CONFIG.importBatchId, "Commit report batch ID mismatch")
  assert(typeof commit.runId === "string" && commit.runId.length > 0, "Commit report run ID is missing")
  assert(typeof commit.actor?.id === "string" && commit.actor.id.length > 0, "Commit report actor is missing")
  assert(Number.isSafeInteger(commit.audit?.id) && Number.isSafeInteger(commit.ublAudit?.id), "Commit report audit IDs are missing")
  assert(commit.audit.id !== commit.ublAudit.id, "Commit report audit IDs must be distinct")

  const mappings = commit.mappings as KeProductCodeMapping[]
  assert(Array.isArray(mappings) && mappings.length === CONFIG.productCount, "Commit report mapping count mismatch")
  for (let index = 0; index < mappings.length; index += 1) {
    const mapping = mappings[index]
    const expectedId = CONFIG.firstProductId + index
    assert(mapping.globalProductId === expectedId, `Commit report product sequence mismatch at ${expectedId}`)
    assert(typeof mapping.productName === "string" && mapping.productName.length > 0, `Commit report product ${expectedId} has no name`)
    assert(/^LEG-KE-[A-F0-9]{16}$/.test(mapping.oldCode), `Commit report product ${expectedId} has an invalid legacy code`)
    assert(mapping.newCode === expectedKeProductCode(expectedId), `Commit report product ${expectedId} has an invalid target code`)
  }
  assert(new Set(mappings.map((mapping) => mapping.oldCode)).size === CONFIG.productCount, "Commit report contains duplicate legacy codes")
  assert(new Set(mappings.map((mapping) => mapping.newCode)).size === CONFIG.productCount, "Commit report contains duplicate target codes")

  const removed = commit.removedUblAssignment
  assert(
    removed?.id === CONFIG.ublAssignment.id
      && removed.organization_id === CONFIG.ublOrganization.id
      && removed.global_product_id === CONFIG.ublAssignment.globalProductId
      && removed.deleted_at === null,
    "Commit report UBL assignment identity is invalid",
  )
  const payload = buildKeProductCodeMappingPayload(mappings, removed)
  assert(sha256Json(payload) === commit.mappingDigest, "Commit report mapping digest is invalid")
  assert(typeof commit.behaviorDigest === "string" && /^[a-f0-9]{64}$/.test(commit.behaviorDigest), "Commit report behavior digest is invalid")
  return mappings
}

async function validateSchemaSafety(client: PoolClient): Promise<void> {
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
  assert(sameJson(foreignKeys, expectedForeignKeys), `organization_inventory FK schema drift: ${JSON.stringify(foreignKeys)}`)

  const userTriggers = (await client.query(`
    select tgrelid::regclass::text table_name, tgname trigger_name
    from pg_trigger
    where not tgisinternal and tgrelid = any(array[
      'organization_inventory'::regclass, 'global_products'::regclass, 'order_items'::regclass
    ])
    order by table_name, trigger_name
  `)).rows
  assert(userTriggers.length === 0, `Unexpected user-defined rollback target triggers: ${JSON.stringify(userTriggers)}`)
}

async function validateSourceAudits(client: PoolClient, commit: JsonRecord, lockRows: boolean): Promise<void> {
  const lock = lockRows ? " for share" : ""
  const migrationAudit = await one(client, `
    select id, user_id, organization_id, action, entity, entity_id, metadata, created_at
    from audit_logs where id = $1${lock}
  `, [commit.audit.id])
  assert(migrationAudit.user_id === commit.actor.id, "K-Electric source audit actor mismatch")
  assert(migrationAudit.organization_id === CONFIG.organization.id, "K-Electric source audit tenant mismatch")
  assert(migrationAudit.action === "LEGACY_PRODUCT_CODE_RENUMBER" && migrationAudit.entity === "legacy_import_batch", "K-Electric source audit action/entity mismatch")
  assert(migrationAudit.entity_id === CONFIG.importBatchId, "K-Electric source audit batch mismatch")
  assert(migrationAudit.metadata?.runId === commit.runId, "K-Electric source audit run ID mismatch")
  assert(migrationAudit.metadata?.mappingDigest === commit.mappingDigest, "K-Electric source audit mapping digest mismatch")
  assert(migrationAudit.metadata?.behaviorDigest === commit.behaviorDigest, "K-Electric source audit behavior digest mismatch")
  assert(sameJson(migrationAudit.metadata?.mappings, commit.mappings), "K-Electric source audit mappings differ from the commit report")
  assert(sameJson(migrationAudit.metadata?.ublAssignment, commit.removedUblAssignment), "K-Electric source audit UBL snapshot differs from the commit report")

  const ublAudit = await one(client, `
    select id, user_id, organization_id, action, entity, entity_id, metadata, created_at
    from audit_logs where id = $1${lock}
  `, [commit.ublAudit.id])
  assert(ublAudit.user_id === commit.actor.id, "UBL source audit actor mismatch")
  assert(ublAudit.organization_id === CONFIG.ublOrganization.id, "UBL source audit tenant mismatch")
  assert(ublAudit.action === "DELETE" && ublAudit.entity === "OrganizationAssignment", "UBL source audit action/entity mismatch")
  assert(ublAudit.entity_id === String(CONFIG.ublAssignment.id), "UBL source audit assignment mismatch")
  assert(ublAudit.metadata?.runId === commit.runId, "UBL source audit run ID mismatch")
  assert(sameJson(ublAudit.metadata?.removedAssignment, commit.removedUblAssignment), "UBL source audit assignment snapshot differs from the commit report")
  assert(
    ublAudit.metadata?.dependencyCounts
      && Object.values(ublAudit.metadata.dependencyCounts).every((value) => Number(value) === 0),
    "UBL source audit records non-zero dependencies",
  )
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
      text: `select bi.* from branch_inventory bi join organization_inventory oi on oi.id = bi.organization_inventory_id
             where oi.global_product_id = any($1::int[]) order by bi.id`,
      params: [targetIds],
    },
    targetQuantityBudgets: { text: `select * from product_quantity_budgets where global_product_id = any($1::int[]) order by id`, params: [targetIds] },
    targetQuantityAllocations: { text: `select * from product_quantity_budget_allocations where global_product_id = any($1::int[]) order by id`, params: [targetIds] },
    targetParallelOrganizationProducts: { text: `select * from organization_products where global_product_id = any($1::int[]) order by id`, params: [targetIds] },
    targetParallelBranchProducts: { text: `select * from branch_products where global_product_id = any($1::int[]) order by id`, params: [targetIds] },
    targetRestockRequests: { text: `select * from restock_requests where global_product_id = any($1::int[]) order by id`, params: [targetIds] },
  }
  const sections: JsonRecord = {}
  for (const [name, query] of Object.entries(queries)) {
    sections[name] = normalized((await client.query(query.text, query.params ?? [])).rows)
  }
  return sha256Json(sections)
}

async function validateActor(client: PoolClient, actorUserId: string): Promise<JsonRecord> {
  const rows = (await client.query(`
    select u.id, u.email, u.is_active, u.deleted_at, r.name role_name
    from users u join roles r on r.id = u.role_id where u.id = $1
  `, [actorUserId])).rows
  assert(rows.length === 1, "Rollback actor does not exist")
  const actor = rows[0]
  assert(actor.role_name === "SUPER_ADMIN" && actor.is_active === true && actor.deleted_at === null, "Rollback actor must be an active SUPER_ADMIN")
  return actor
}

async function lockTables(client: PoolClient): Promise<void> {
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

async function inspectRollbackState(
  client: PoolClient,
  mappings: KeProductCodeMapping[],
  removedAssignment: JsonRecord,
  expectedBehaviorDigest: string,
): Promise<JsonRecord> {
  assert(mappings.length === CONFIG.productCount, "Rollback mapping count mismatch")
  const targetIds = mappings.map((row) => row.globalProductId)
  const products = (await client.query(`
    select id, product_code, name, status, stock_quantity::text, deleted_at, metadata
    from global_products where id = any($1::int[]) order by id
  `, [targetIds])).rows
  assert(products.length === CONFIG.productCount, "Rollback target product count mismatch")
  for (let index = 0; index < products.length; index += 1) {
    const product = products[index]
    const mapping = mappings[index]
    assert(product.id === mapping.globalProductId && product.product_code === mapping.newCode, `Product ${mapping.globalProductId} is not in the committed code state`)
    assert(product.status === "inactive" && Number(product.stock_quantity) === 0 && product.deleted_at === null, `Product ${product.id} became operational; rollback is unsafe`)
    assert(product.metadata?.legacySource === CONFIG.sourceSystem && product.metadata?.historicalOnly === true, `Product ${product.id} import identity changed`)
  }

  const collisions = (await client.query(`
    select gp.id, gp.product_code, gp.name from global_products gp
    join jsonb_to_recordset($1::jsonb) m(global_product_id int, old_code text)
      on upper(btrim(gp.product_code)) = upper(btrim(m.old_code))
    where gp.id <> all($2::int[])
    order by gp.id
  `, [JSON.stringify(mappings.map((row) => ({ global_product_id: row.globalProductId, old_code: row.oldCode }))), targetIds])).rows
  assert(collisions.length === 0, `A legacy code has been reused: ${JSON.stringify(collisions)}`)

  const items = await one(client, `
    select count(*)::int count,
           count(*) filter (where oi.product_code <> m.new_code)::int mismatches
    from legacy_order_imports loi join order_items oi on oi.order_id = loi.order_id
    join jsonb_to_recordset($1::jsonb) m(global_product_id int, new_code text)
      on m.global_product_id = oi.global_product_id
    where loi.batch_id = $2 and loi.organization_id = $3 and loi.source_system = $4
      and oi.organization_id = $3
  `, [JSON.stringify(mappings.map((row) => ({ global_product_id: row.globalProductId, new_code: row.newCode }))), CONFIG.importBatchId, CONFIG.organization.id, CONFIG.sourceSystem])
  assert(items.count === CONFIG.renamedItemCount && items.mismatches === 0, "Rollback order-item snapshot state is unsafe")
  const outsideItems = await count(client, `
    select count(*)::int count from order_items oi
    left join legacy_order_imports loi on loi.order_id = oi.order_id and loi.batch_id = $1
    where oi.global_product_id = any($2::int[]) and loi.id is null
  `, [CONFIG.importBatchId, targetIds])
  assert(outsideItems === 0, "Target products gained non-imported order items")

  const ublRows = await count(client, `
    select count(*)::int count from organization_inventory
    where id = $1 or (organization_id = $2 and global_product_id = $3)
  `, [CONFIG.ublAssignment.id, CONFIG.ublOrganization.id, CONFIG.ublAssignment.globalProductId])
  assert(ublRows === 0, "UBL assignment ID or product assignment has been reused")
  assert(
    removedAssignment.id === CONFIG.ublAssignment.id
      && removedAssignment.organization_id === CONFIG.ublOrganization.id
      && removedAssignment.global_product_id === CONFIG.ublAssignment.globalProductId
      && removedAssignment.deleted_at === null,
    "Commit report UBL assignment identity is invalid",
  )

  const crossTenant = await one(client, `
    select
      (select count(*)::int from organization_inventory where global_product_id = any($1::int[]) and organization_id <> $2) organization_inventory,
      (select count(*)::int from order_items where global_product_id = any($1::int[]) and organization_id <> $2) order_items,
      (select count(*)::int from organization_products where global_product_id = any($1::int[]) and organization_id <> $2) organization_products,
      (select count(*)::int from branch_products where global_product_id = any($1::int[]) and organization_id <> $2) branch_products,
      (select count(*)::int from product_quantity_budgets where global_product_id = any($1::int[]) and organization_id <> $2) quantity_budgets,
      (select count(*)::int from product_quantity_budget_allocations where global_product_id = any($1::int[]) and organization_id <> $2) quantity_allocations,
      (select count(*)::int from restock_requests where global_product_id = any($1::int[]) and organization_id <> $2) restock_requests,
      (select count(*)::int from legacy_product_mappings where global_product_id = any($1::int[]) and organization_id <> $2) legacy_mappings
  `, [targetIds, CONFIG.organization.id])
  assert(Object.values(crossTenant).every((value) => value === 0), `Rollback cross-tenant safety check failed: ${JSON.stringify(crossTenant)}`)

  const behaviorDigest = await protectedBehaviorDigest(client)
  assert(behaviorDigest === expectedBehaviorDigest, "Protected data changed after the committed renumber; rollback is unsafe")
  return { products: products.length, items: items.count, behaviorDigest, crossTenant }
}

async function invalidateCaches(): Promise<JsonRecord> {
  const patterns = ["cache:global-inv*", "cache:org-inv*", "cache:branch-inv*", "cache:inv:org-products*", "cache:inv:branch-products*", "cache:analytics:catalog-performance*", "product-summary:*"]
  const { redis } = await import("../lib/redis-cli")
  if (!redis) return { status: "SKIPPED", patterns }
  let deleted = 0
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern)
    for (let index = 0; index < keys.length; index += 100) {
      const chunk = keys.slice(index, index + 100)
      if (chunk.length) deleted += await redis.del(...chunk)
    }
  }
  return { status: "CLEARED", deleted, patterns }
}

async function main(): Promise<void> {
  const commitPath = arg("--commit-report")
  assert(commitPath, "--commit-report=<renumber commit report> is required")
  const commit = JSON.parse(readFileSync(resolve(commitPath), "utf8")) as JsonRecord
  const mappings = validateCommitReport(commit)

  const apply = process.argv.includes("--apply")
  const actorUserId = arg("--actor-user-id")
  const outputPath = arg("--output")
  const expectedConfirmation = `ROLLBACK:KE-LEGACY-PRODUCT-CODES:${commit.mappingDigest}:RESTORE-UBL-320`
  if (apply) {
    assert(actorUserId, "--actor-user-id is required with --apply")
    assert(outputPath, "--output is required with --apply")
    assert(arg("--confirm") === expectedConfirmation, `Required: --confirm=${expectedConfirmation}`)
    assertOutputWritable(outputPath)
  }

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  let committed = false
  try {
    await client.query(apply ? "begin transaction isolation level serializable" : "begin transaction isolation level repeatable read read only")
    if (apply) await lockTables(client)
    await validateSchemaSafety(client)
    await validateSourceAudits(client, commit, apply)
    const state = await inspectRollbackState(client, mappings, commit.removedUblAssignment, commit.behaviorDigest)
    if (!apply) {
      await client.query("commit")
      console.log(JSON.stringify({ status: "READY", mode: "DRY_RUN", mappingDigest: commit.mappingDigest, ...state, requiredConfirmation: expectedConfirmation }, null, 2))
      return
    }

    const actor = await validateActor(client, actorUserId!)
    const runId = randomUUID()
    const dbMappings = mappings.map((row) => ({ global_product_id: row.globalProductId, old_code: row.oldCode, new_code: row.newCode }))
    const itemsUpdated = await client.query(`
      update order_items oi set product_code = m.old_code
      from jsonb_to_recordset($1::jsonb) m(global_product_id int, old_code text, new_code text),
           legacy_order_imports loi
      where loi.batch_id = $2 and loi.organization_id = $3 and loi.source_system = $4
        and oi.order_id = loi.order_id and oi.organization_id = $3
        and oi.global_product_id = m.global_product_id and oi.product_code = m.new_code
      returning oi.id
    `, [JSON.stringify(dbMappings), CONFIG.importBatchId, CONFIG.organization.id, CONFIG.sourceSystem])
    assert(itemsUpdated.rowCount === CONFIG.renamedItemCount, "Rollback order-item update count mismatch")
    const productsUpdated = await client.query(`
      update global_products gp set product_code = m.old_code, updated_at = now()
      from jsonb_to_recordset($1::jsonb) m(global_product_id int, old_code text, new_code text)
      where gp.id = m.global_product_id and gp.product_code = m.new_code
      returning gp.id
    `, [JSON.stringify(dbMappings)])
    assert(productsUpdated.rowCount === CONFIG.productCount, "Rollback product update count mismatch")

    const removed = commit.removedUblAssignment
    const restored = await client.query(`
      insert into organization_inventory (
        id, organization_id, global_product_id, assigned_by_user_id, is_active,
        custom_name, custom_price_cents, custom_description, custom_image_url,
        assigned_at, updated_at, deleted_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      returning *
    `, [
      removed.id, removed.organization_id, removed.global_product_id, removed.assigned_by_user_id,
      removed.is_active, removed.custom_name, removed.custom_price_cents, removed.custom_description,
      removed.custom_image_url, removed.assigned_at, removed.updated_at, removed.deleted_at,
    ])
    assert(restored.rowCount === 1 && sha256Json(normalized(restored.rows[0])) === sha256Json(normalized(removed)), "Restored UBL assignment differs from the original")

    const behaviorDigest = await protectedBehaviorDigest(client)
    assert(behaviorDigest === commit.behaviorDigest, "Rollback changed a protected non-code field")
    const ublAudit = await client.query(`
      insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
      values ($1,$2,'RESTORE','OrganizationAssignment',$3,$4::jsonb) returning id, created_at
    `, [actorUserId, CONFIG.ublOrganization.id, String(CONFIG.ublAssignment.id), JSON.stringify({ runId, restoredAssignment: removed, sourceMappingDigest: commit.mappingDigest })])
    const rollbackAudit = await client.query(`
      insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
      values ($1,$2,'LEGACY_PRODUCT_CODE_RENUMBER_ROLLBACK','legacy_import_batch',$3,$4::jsonb) returning id, created_at
    `, [actorUserId, CONFIG.organization.id, CONFIG.importBatchId, JSON.stringify({
      runId, sourceMappingDigest: commit.mappingDigest, productsUpdated: productsUpdated.rowCount,
      orderItemsUpdated: itemsUpdated.rowCount, restoredUblAssignmentId: CONFIG.ublAssignment.id,
      behaviorDigest, stockBudgetPriceOrFinancialValuesChanged: false,
    })])
    await client.query("commit")
    committed = true
    let cache: JsonRecord
    try { cache = await invalidateCaches() } catch (error) { cache = { status: "WARNING", error: error instanceof Error ? error.message : String(error) } }
    const report = normalized({
      kind: "KE_LEGACY_PRODUCT_CODE_RENUMBER_ROLLBACK", status: "COMPLETED", generatedAt: new Date().toISOString(),
      runId, sourceMappingDigest: commit.mappingDigest, actor, productsUpdated: productsUpdated.rowCount,
      orderItemsUpdated: itemsUpdated.rowCount, restoredUblAssignment: restored.rows[0],
      audit: rollbackAudit.rows[0], ublAudit: ublAudit.rows[0], behaviorDigest, cache,
    })
    try { writeJsonExclusive(outputPath!, report) } catch (error) { console.error(`WARNING: rollback committed but report write failed: ${error instanceof Error ? error.message : String(error)}`) }
    console.log(JSON.stringify({ status: "COMPLETED", committed: true, runId, productsUpdated: productsUpdated.rowCount, orderItemsUpdated: itemsUpdated.rowCount, restoredUblAssignmentId: CONFIG.ublAssignment.id, behaviorDigest, cache }, null, 2))
  } catch (error) {
    if (!committed) await client.query("rollback").catch(() => undefined)
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

#!/usr/bin/env tsx
/**
 * Set K-Electric's organization price tier from the legacy platform.
 *
 * Global product prices are left exactly as they are; what K-Electric pays
 * comes from legacy. That is written to `organization_inventory.custom_price_cents`
 * for organization 10 and nowhere else — 31 of these `global_products` rows are
 * shared with K-E-Demo, UBL and EFU, so the global tier is not a safe place to
 * put a tenant's prices.
 *
 * The decision of what to write is pure and unit-tested in
 * `lib/legacy-import/ke-org-prices.ts`. This script supplies rows, gates the
 * tenant and the actor, and performs the write.
 *
 * Pricing is Super Admin only at every tier (`lib/pricing-access.ts`), so
 * `--actor-user-id` must be an active SUPER_ADMIN and its role is checked
 * through `canMutatePrices` before anything is written.
 *
 *   npx tsx scripts/set-ke-organization-prices.ts
 *   npx tsx scripts/set-ke-organization-prices.ts --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-plan-sha256=<digest> --expected-changes=<n>
 *   npx tsx scripts/set-ke-organization-prices.ts --rollback=<report>.json \
 *     --confirm-organization=10:0001:K-Electric --confirm-rollback=<printed>
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"

import {
  planProducts,
  type CurrentProductMapping,
  type LegacyCategory,
  type LegacyItem,
  type LegacyPriceHistoryRow,
} from "../lib/legacy-import/ke-products"
import {
  planOrganizationPrices,
  summarizeOrganizationPrices,
  type CurrentOrgInventory,
  type OrgPricePlan,
} from "../lib/legacy-import/ke-org-prices"
import { canMutatePrices } from "../lib/pricing-access"
import { invalidateCachePrefixes } from "../lib/cache-cli"
import { compareCodeUnits } from "../lib/code-unit-order"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
const ORGANIZATION_CONFIRMATION = "10:0001:K-Electric"
const ADVISORY_LOCK = 700012
const BASE_URL = "https://logistics.oneflowe.com"
const LEGACY_ACCOUNT_ID = 1
const FETCH_ATTEMPTS = 4

type JsonRow = Record<string, any>

interface CommitReport {
  kind: "KE_ORGANIZATION_PRICE_SET"
  mode: "COMMITTED"
  organization: typeof ORGANIZATION
  planSha256: string
  auditLogId: number
  changes: OrgPricePlan["changes"]
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((v) => v.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonRow).sort(compareCodeUnits)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as JsonRow)[k])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

const planDigest = (plan: OrgPricePlan) => sha256(canonical(plan.changes))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

async function rows<T extends JsonRow = JsonRow>(
  client: PoolClient, text: string, params: unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init, headers: { Accept: "application/json", ...(init?.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000 * attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function readCurrent(client: PoolClient): Promise<CurrentOrgInventory[]> {
  return (await rows(client, `
    select oi.id, oi.global_product_id, gp.name, oi.custom_price_cents,
           gp.base_price_cents, oi.is_active
      from organization_inventory oi
      join global_products gp on gp.id = oi.global_product_id
     where oi.organization_id = $1 and oi.deleted_at is null
     order by oi.id
  `, [ORGANIZATION.id])).map((row): CurrentOrgInventory => ({
    organizationInventoryId: Number(row.id),
    globalProductId: Number(row.global_product_id),
    productName: String(row.name),
    customPriceCents: row.custom_price_cents == null ? null : Number(row.custom_price_cents),
    globalBasePriceCents: Number(row.base_price_cents),
    isActive: Boolean(row.is_active),
  }))
}

async function readMappings(client: PoolClient): Promise<CurrentProductMapping[]> {
  return (await rows(client, `
    select m.normalized_name, m.global_product_id, m.organization_inventory_id, gp.base_price_cents
      from legacy_product_mappings m
      join global_products gp on gp.id = m.global_product_id
     where m.organization_id = $1 and m.source_system = 'KE_LOGISTICS'
     order by m.id
  `, [ORGANIZATION.id])).map((row): CurrentProductMapping => ({
    normalizedName: String(row.normalized_name),
    globalProductId: Number(row.global_product_id),
    organizationInventoryId: Number(row.organization_inventory_id),
    basePriceCents: Number(row.base_price_cents),
  }))
}

/**
 * The global tier and every other tenant, before and after. This script's whole
 * safety claim is "K-Electric only", and this is how it is proved rather than
 * asserted.
 */
async function fingerprints(client: PoolClient): Promise<JsonRow> {
  const [value] = await rows(client, `
    select
      (select coalesce(sum(base_price_cents), 0)::text from global_products) as global_base_price_total,
      (select count(*)::int from global_products) as global_products,
      (select coalesce(md5(string_agg(id::text || ':' || base_price_cents::text, ',' order by id)), '')
         from global_products) as global_price_fingerprint,
      (select coalesce(md5(string_agg(id::text || ':' || coalesce(custom_price_cents::text, 'null'), ',' order by id)), '')
         from organization_inventory where organization_id <> $1) as other_tenant_org_prices,
      (select count(*)::int from group_inventory_prices) as group_price_rows,
      (select coalesce(sum(total_cents), 0)::text from orders) as all_order_totals,
      (select coalesce(sum(price_cents), 0)::text from order_items) as all_order_item_prices
  `, [ORGANIZATION.id])
  return value
}

/**
 * Prove the write path exists before claiming a dry run means anything.
 *
 * A preflight never executes its own UPDATE, so a column that does not exist
 * survives every dry run and fails only at commit — which is exactly what
 * happened with `updated_by_user_id`, a column that lives on
 * `organization_products`, not on this table. Checking the columns here makes
 * the dry run tell the truth about whether the commit can work.
 */
async function assertWritableColumns(client: PoolClient): Promise<void> {
  const required = ["id", "organization_id", "global_product_id", "custom_price_cents",
    "updated_at", "deleted_at"] as const
  const present = new Set((await rows(client, `
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'organization_inventory'
  `)).map((row) => String(row.column_name)))
  const missing = required.filter((column) => !present.has(column))
  assert(missing.length === 0,
    `organization_inventory is missing column(s) this script writes or filters on: ${missing.join(", ")}`)
}

async function assertTenantAndActor(client: PoolClient, requireActor: boolean): Promise<string | null> {
  const [org] = await rows(client,
    "select id, code, name from organizations where id = $1", [ORGANIZATION.id])
  assert(org && org.code === ORGANIZATION.code && org.name === ORGANIZATION.name,
    `Organization ${ORGANIZATION.id} is not ${ORGANIZATION_CONFIRMATION}; refusing to run`)
  if (!requireActor) return null

  const actorId = arg("actor-user-id")
  assert(actorId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
  const [actor] = await rows(client, `
    select u.id, r.name as role from users u join roles r on r.id = u.role_id
     where u.id = $1 and u.is_active = true and u.deleted_at is null
  `, [actorId])
  assert(actor, "--actor-user-id must be an active, non-deleted user")
  // Pricing is Super Admin only at every tier — the same rule the API enforces.
  assert(canMutatePrices(actor.role),
    `Role ${actor.role} may not change prices; pricing is restricted to SUPER_ADMIN`)
  return String(actor.id)
}

function buildReport(plan: OrgPricePlan, digest: string) {
  return {
    kind: "KE_ORGANIZATION_PRICE_SET" as const,
    mode: "DRY_RUN" as const,
    generatedAt: new Date().toISOString(),
    organization: ORGANIZATION,
    policy: {
      target: "organization_inventory.custom_price_cents, organization 10 only",
      source: "legacy modal price per product, the same rule new products are created with",
      neverWritten: [
        "global_products.base_price_cents",
        "any organization_inventory row of another tenant",
        "group_inventory_prices",
        "order_items.price_cents (a snapshot of what was charged)",
      ],
      zeroPrices: "a product legacy never priced is reported, never written as zero",
    },
    summary: summarizeOrganizationPrices(plan),
    planSha256: digest,
    requiredCommitArguments: {
      confirmOrganization: ORGANIZATION_CONFIRMATION,
      confirmPlanSha256: digest,
      expectedChanges: plan.changes.length,
    },
    changes: plan.changes,
    skipped: plan.skipped,
  }
}

async function main(): Promise<void> {
  const { closePool, pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const rollbackPath = arg("rollback")
    if (rollbackPath) { await rollback(client, resolve(process.cwd(), rollbackPath)); return }

    const committing = flag("commit")
    await assertWritableColumns(client)
    const actorId = await assertTenantAndActor(client, committing)
    const output = resolve(process.cwd(),
      arg("output") ?? `deliverables/ke-organization-prices-${new Date().toISOString().slice(0, 10)}.json`)

    const [items, categories, priceHistory] = await Promise.all([
      fetchJson<LegacyItem[]>(`/api/Item/0/null/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacyCategory[]>(`/api/Category/0/${LEGACY_ACCOUNT_ID}`),
      fetchJson<LegacyPriceHistoryRow[]>(`/api/ProductSummary/GetSummaryItemHistory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          UserID: LEGACY_ACCOUNT_ID, LocationIDs: null,
          StartDate: "2020-01-01", EndDate: new Date().toISOString().slice(0, 10),
        }),
      }),
    ])

    const mappings = await readMappings(client)
    const current = await readCurrent(client)
    const products = planProducts(items, categories, mappings, priceHistory)
    const plan = planOrganizationPrices(current, products)
    const digest = planDigest(plan)
    const report = buildReport(plan, digest)

    if (!committing) {
      saveJson(output, report)
      console.log(JSON.stringify({
        mode: "DRY_RUN", output, planSha256: digest, summary: report.summary,
      }, null, 2))
      if (plan.changes.length === 0) {
        console.log("\nNothing to set: the organization tier already matches legacy.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npx tsx scripts/set-ke-organization-prices.ts --commit \\
    --actor-user-id=<active-super-admin-uuid> \\
    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\
    --confirm-plan-sha256=${digest} \\
    --expected-changes=${plan.changes.length}`)
      }
      return
    }

    assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)
    assert(arg("expected-changes") === String(plan.changes.length),
      `Commit requires --expected-changes=${plan.changes.length}`)
    assert(plan.changes.length > 0, "Nothing to set")

    const before = await fingerprints(client)
    const prechangePath = output.replace(/\.json$/, "") + "-prechange.json"
    saveJson(prechangePath, {
      generatedAt: new Date().toISOString(), organization: ORGANIZATION,
      planSha256: digest, fingerprints: before, organizationInventory: current,
    })
    const prechangeSha256 = sha256(readFileSync(prechangePath, "utf8"))

    let auditLogId = 0
    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      await client.query(
        `select id from organization_inventory where organization_id = $1 order by id for update`,
        [ORGANIZATION.id])

      const locked = await readCurrent(client)
      const lockedPlan = planOrganizationPrices(locked, products)
      assert(planDigest(lockedPlan) === digest,
        "K-Electric organization inventory changed after the preflight; aborting")

      for (const change of lockedPlan.changes) {
        // `organization_inventory` has no "updated by" column, and
        // `assigned_by_user_id` records who put the product in this tenant's
        // catalogue — not who priced it. Overwriting that would destroy
        // information, so the actor is recorded on the audit row instead.
        const updated = await rows(client, `
          update organization_inventory
             set custom_price_cents = $1, updated_at = now()
           where id = $2 and organization_id = $3 and global_product_id = $4
             and custom_price_cents is not distinct from $5
             and deleted_at is null
          returning id
        `, [change.toCents, change.organizationInventoryId, ORGANIZATION.id,
          change.globalProductId, change.fromCents])
        assert(updated.length === 1,
          `Concurrent change detected for organization_inventory ${change.organizationInventoryId}`)
      }

      const audit = await rows(client, `
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values ($1, $2, null, 'KE_ORGANIZATION_PRICE_SET', 'organization_inventory', $3, $4::jsonb)
        returning id
      `, [actorId, ORGANIZATION.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest, prechangePath, prechangeSha256,
        changedRows: lockedPlan.changes.length,
        skippedRows: lockedPlan.skipped.length,
        summary: summarizeOrganizationPrices(lockedPlan),
      })])
      auditLogId = Number(audit[0]?.id)
      assert(Number.isSafeInteger(auditLogId), "Failed to write the price-set audit row")

      await client.query("commit")
    } catch (error) {
      await client.query("rollback")
      throw error
    }

    const after = await fingerprints(client)
    for (const key of Object.keys(before)) {
      assert(canonical(before[key]) === canonical(after[key]),
        `Protected state changed during the price set: ${key}`)
    }

    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      actorUserId: actorId,
      auditLogId,
      prechange: { path: prechangePath, sha256: prechangeSha256 },
      protectedFingerprints: { before, after },
      rollbackConfirmation: `ROLLBACK:${auditLogId}:KE-ORG-PRICES`,
    })

    // The write is already committed. A cache that cannot be cleared is a
    // staleness problem to report, never a reason to fail the run.
    const cache = await invalidateCachePrefixes(["inventory", "products", "shop", "analytics"])

    console.log(JSON.stringify({
      mode: "COMMITTED", output, auditLogId, planSha256: digest,
      changed: plan.changes.length,
      cacheInvalidation: cache,
      rollbackConfirmation: `ROLLBACK:${auditLogId}:KE-ORG-PRICES`,
    }, null, 2))
    const failed = cache.filter((entry) => entry.error)
    if (failed.length > 0) {
      console.warn(`\nWARNING: ${failed.length} cache prefix(es) were not cleared — prices are`)
      console.warn("written but readers may serve stale values until their TTL expires.")
      for (const entry of failed) console.warn(`  ${entry.prefix}: ${entry.error}`)
    }
  } finally {
    client.release()
    await closePool()
  }
}

async function rollback(client: PoolClient, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === "KE_ORGANIZATION_PRICE_SET" && report.mode === "COMMITTED",
    "Not a committed organization-price report")
  assert(report.organization?.id === ORGANIZATION.id && report.organization.code === ORGANIZATION.code,
    "Commit report tenant mismatch")
  assert(arg("confirm-organization") === ORGANIZATION_CONFIRMATION,
    `--confirm-organization must equal ${ORGANIZATION_CONFIRMATION}`)
  assert(arg("confirm-rollback") === `ROLLBACK:${report.auditLogId}:KE-ORG-PRICES`,
    `--confirm-rollback must equal ROLLBACK:${report.auditLogId}:KE-ORG-PRICES`)
  const actorId = await assertTenantAndActor(client, true)

  await client.query("begin")
  try {
    await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
    for (const change of report.changes) {
      const restored = await rows(client, `
        update organization_inventory
           set custom_price_cents = $1, updated_at = now()
         where id = $2 and organization_id = $3 and custom_price_cents is not distinct from $4
           and deleted_at is null
        returning id
      `, [change.fromCents, change.organizationInventoryId, ORGANIZATION.id, change.toCents])
      assert(restored.length === 1,
        `organization_inventory ${change.organizationInventoryId} changed after the price set; rollback refused`)
    }
    await client.query(`
      insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
      values ($1, $2, null, 'KE_ORGANIZATION_PRICE_SET_ROLLBACK', 'organization_inventory', $3, $4::jsonb)
    `, [actorId, ORGANIZATION.id, String(report.auditLogId), JSON.stringify({
      revertedRows: report.changes.length, planSha256: report.planSha256,
    })])
    await client.query("commit")
  } catch (error) {
    await client.query("rollback")
    throw error
  }
  console.log(JSON.stringify({ mode: "ROLLED_BACK", reverted: report.changes.length }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

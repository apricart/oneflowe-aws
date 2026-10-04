#!/usr/bin/env tsx
/**
 * Clears the stale legacy sales-tax markers from the K-Electric legacy products.
 *
 * The importer stamped `historicalOnly: true` on every product it created on
 * the premise that legacy prices excluded sales tax. That premise is wrong:
 * K-Electric confirmed the legacy export was already tax-inclusive.
 *
 * Three keys carry that false premise, and all are removed here:
 *
 *   historicalOnly            the marker itself
 *   historicalNetPriceCents   a gross price recorded as if it were net
 *   historicalPriceRestatedAt the timestamp of a restatement that never happened
 *
 * The markers are not inert. `getHistoricalProductActivationError` in
 * app/api/v1/admin/global-inventory/route.ts refuses to activate a flagged
 * product until an admin confirms a tax restatement that is not needed here,
 * and `clearHistoricalOnlyFlag` writes the latter two keys from the current
 * price. Product 238 showed the result: an admin confirmed a price that was
 * already correct, the price was left untouched, and the code still recorded
 * it as a net figure — its stamp equalled its price exactly.
 *
 * That equality is the safety property this script relies on. A stamp equal to
 * the current price proves no restatement occurred and the key is a pure
 * artifact. A stamp that differs would mean someone genuinely repriced the row,
 * so the run aborts rather than discarding real history.
 *
 * Scope is every K-Electric legacy product, active or dormant. Clearing the
 * marker does not activate anything — dormant rows stay inactive with zero
 * stock until they are promoted with the category, unit, stock, and image data
 * the legacy export never carried. No replacement fields are written; prices,
 * status, and every other value are left untouched.
 *
 * Tenancy is pinned two ways: a KE_LOGISTICS `legacySource` on the product and
 * an organization-10 row in legacy_product_mappings. No product outside that
 * intersection can be reached.
 *
 * Default mode is a read-only dry run.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"

import { compareCodeUnits } from "../lib/code-unit-order"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE.id}:${KE.code}:${KE.name}`
const LEGACY_SOURCE = "KE_LOGISTICS"

/** Keys removed from `metadata`, all artifacts of the false net-price premise. */
const STALE_KEYS = ["historicalOnly", "historicalNetPriceCents", "historicalPriceRestatedAt"] as const

interface TargetRow {
  id: number
  productCode: string
  name: string
  status: string
  basePriceCents: number
  taxRateBp: number | null
  importTimePriceCents: number | null
  metadata: Record<string, unknown>
}

/**
 * Every K-Electric legacy product still carrying a stale key. Products already
 * cleared drop out, so the script is safe to re-run.
 *
 * Tenancy is asserted with `exists` rather than a join: several legacy source
 * names can collapse onto one product (id 212 carries two), and a join would
 * emit that product once per mapping row.
 */
const TARGET_QUERY = `
  select
    gp.id,
    gp.product_code as "productCode",
    gp.name,
    gp.status,
    gp.base_price_cents as "basePriceCents",
    gp.tax_rate_bp as "taxRateBp",
    oi.custom_price_cents as "importTimePriceCents",
    gp.metadata
  from global_products gp
  left join organization_inventory oi
    on oi.global_product_id = gp.id
   and oi.organization_id = $1
  where gp.deleted_at is null
    and gp.metadata->>'legacySource' = $2
    and (gp.metadata ?| $3::text[])
    and exists (
      select 1 from legacy_product_mappings lpm
      where lpm.global_product_id = gp.id
        and lpm.organization_id = $1
        and lpm.source_system = $2
    )
  order by gp.id
`

/**
 * Marked products outside K-Electric tenancy. Expected to be empty; a non-zero
 * count means another tenant carries the same marker and needs its own decision
 * rather than being swept up by this run.
 */
const OUT_OF_SCOPE_QUERY = `
  select gp.status, count(*)::int as count
  from global_products gp
  where gp.deleted_at is null
    and (gp.metadata ?| $3::text[])
    and not (
      gp.metadata->>'legacySource' = $2
      and exists (
        select 1 from legacy_product_mappings lpm
        where lpm.global_product_id = gp.id
          and lpm.organization_id = $1
          and lpm.source_system = $2
      )
    )
  group by gp.status
  order by gp.status
`

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Covers price, status, and full metadata so that any edit landing between the
 * preflight and the commit invalidates the confirmation rather than being
 * silently overwritten.
 */
function planDigest(rows: TargetRow[]): string {
  return sha256(rows.map((row) => [
    row.id,
    row.productCode,
    row.status,
    row.basePriceCents,
    row.taxRateBp ?? "null",
    JSON.stringify(row.metadata),
  ].join(":")).join("\n"))
}

function buildPlan(rows: TargetRow[]) {
  return rows.map((row) => {
    const retained: Record<string, unknown> = { ...row.metadata }
    const removed = STALE_KEYS.filter((key) => key in retained)
    for (const key of STALE_KEYS) delete retained[key]

    assert(removed.length > 0, `Product ${row.id} carries no stale marker`)
    assert(Number.isSafeInteger(row.basePriceCents), `Unsafe price for product ${row.id}`)

    // A stamp equal to the current price proves the "restatement" left the price
    // alone, making the key an artifact. A differing stamp is real history.
    const netStamp = row.metadata.historicalNetPriceCents
    if (netStamp !== undefined) {
      assert(
        netStamp === row.basePriceCents,
        `Product ${row.id} was genuinely repriced (stamp ${netStamp} vs price ${row.basePriceCents}); refusing to discard restatement history`,
      )
    }

    return {
      id: row.id,
      productCode: row.productCode,
      name: row.name,
      status: row.status,
      basePriceCents: row.basePriceCents,
      importTimePriceCents: row.importTimePriceCents,
      priceUnchangedSinceImport: row.importTimePriceCents === null
        ? null
        : row.importTimePriceCents === row.basePriceCents,
      removedKeys: removed,
      oldMetadata: row.metadata,
      newMetadata: retained,
    }
  })
}

function reportPath(commit: boolean): string {
  const requested = arg("--output")
  if (requested) return resolve(requested)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve(commit
    ? `backups/ke-historical-only-flag-repair-commit-${stamp}.json`
    : "deliverables/ke-historical-only-flag-repair-preflight.json")
}

function saveReport(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function main() {
  const commit = process.argv.includes("--commit")
  const output = reportPath(commit)
  const staleKeys = [...STALE_KEYS]
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [organizationResult, targetResult, outOfScopeResult] = await Promise.all([
      client.query("select id, code, name from organizations where id = $1", [KE.id]),
      client.query<TargetRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE, staleKeys]),
      client.query(OUT_OF_SCOPE_QUERY, [KE.id, LEGACY_SOURCE, staleKeys]),
    ])
    const organization = organizationResult.rows[0]
    assert(
      organization?.id === KE.id && organization.code === KE.code && organization.name === KE.name,
      "K-Electric organization identity mismatch",
    )

    const plan = buildPlan(targetResult.rows)
    const digest = planDigest(targetResult.rows)

    const summary = {
      organizationId: KE.id,
      matchedProducts: plan.length,
      byStatus: Object.fromEntries(
        [...new Set(plan.map((row) => row.status))].sort(compareCodeUnits)
          .map((status) => [status, plan.filter((row) => row.status === status).length]),
      ),
      removedKeyCounts: Object.fromEntries(STALE_KEYS.map((key) => [
        key,
        plan.filter((row) => row.removedKeys.includes(key)).length,
      ])),
      pricesUnchangedSinceImport: plan.filter((row) => row.priceUnchangedSinceImport === true).length,
      pricesWithoutImportBaseline: plan.filter((row) => row.priceUnchangedSinceImport === null).length,
      markedOutsideKeTenancy: outOfScopeResult.rows,
    }

    const baseReport: Record<string, unknown> = {
      kind: "KE_LEGACY_TAX_MARKER_REPAIR",
      mode: commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      repairPolicy: {
        scope: "every K-Electric legacy product (organization 10 + KE_LOGISTICS) carrying a stale marker, active or dormant",
        change: `remove the metadata keys ${STALE_KEYS.join(", ")}`,
        preserved: "base_price_cents, tax_rate_bp, status, category, unit, stock, and all other metadata keys",
        notAnActivation: "dormant products stay inactive with zero stock; only the false tax premise is removed",
        deliberatelyNotWritten: "no replacement fields — the price is already gross, so recording it as a net figure would be false",
        rationale: "K-Electric confirmed legacy export prices are tax-inclusive; the importer net-price premise was wrong",
        repricingGuard: "a historicalNetPriceCents differing from base_price_cents aborts the run as genuine restatement history",
        outOfScope: "any marked product outside K-Electric tenancy is reported but never modified",
      },
      summary,
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: digest,
        expectedProducts: plan.length,
      },
      products: plan,
    }

    if (!commit) {
      saveReport(output, baseReport)
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output,
        summary,
        planSha256: digest,
        requiredCommitArguments: baseReport.requiredCommitArguments,
      }, null, 2))
      return
    }

    // Targets carrying no stale marker are already repaired and drop out of the
    // plan; that is the expected steady state on a re-run, not an error. Scope
    // stays pinned by the digest and --expected-products below.
    assert(plan.length > 0, "No K-Electric product carries a stale marker; nothing to repair")
    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match")
    const expectedProducts = Number(arg("--expected-products"))
    assert(
      Number.isSafeInteger(expectedProducts) && expectedProducts === plan.length,
      `--expected-products must equal ${plan.length}`,
    )

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [700011])
      const lockedOrganization = await client.query(
        "select id, code, name from organizations where id = $1 for share",
        [KE.id],
      )
      assert(
        lockedOrganization.rows[0]?.code === KE.code && lockedOrganization.rows[0]?.name === KE.name,
        "Locked organization identity mismatch",
      )
      const lockedRows = (await client.query<TargetRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE, staleKeys])).rows
      assert(planDigest(lockedRows) === digest, "Product state changed after preflight; aborting")
      const lockedPlan = buildPlan(lockedRows)

      for (const row of lockedPlan) {
        // The price and status guards make the update a no-op if anyone changed
        // the row between the digest check and here, which the assert catches.
        const updated = await client.query(`
          update global_products
          set metadata = metadata - $4::text[], updated_at = now()
          where id = $1
            and status = $5
            and base_price_cents = $2
            and metadata->>'legacySource' = $3
            and (metadata ?| $4::text[])
          returning id, base_price_cents as "basePriceCents", status, metadata
        `, [row.id, row.basePriceCents, LEGACY_SOURCE, staleKeys, row.status])
        assert(updated.rows.length === 1, `Concurrent change detected for product ${row.id}`)
        assert(
          updated.rows[0].basePriceCents === row.basePriceCents,
          `Price moved while clearing markers on product ${row.id}`,
        )
        assert(updated.rows[0].status === row.status, `Status moved on product ${row.id}`)
        const after = updated.rows[0].metadata as Record<string, unknown>
        for (const key of STALE_KEYS) {
          assert(after[key] === undefined, `Marker ${key} still present on product ${row.id}`)
        }
      }

      const audit = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_LEGACY_TAX_MARKER_REPAIR', 'global_products', $2, $3::jsonb)
        returning id
      `, [KE.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest,
        productIds: lockedPlan.map((row) => row.id),
        clearedProducts: lockedPlan.length,
        removedKeys: Object.fromEntries(STALE_KEYS.map((key) => [
          key,
          lockedPlan.filter((row) => row.removedKeys.includes(key)).length,
        ])),
        pricesModified: 0,
        statusesModified: 0,
      })])
      await client.query("commit")

      const remaining = await client.query<TargetRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE, staleKeys])
      assert(remaining.rows.length === 0, `${remaining.rows.length} K-Electric products remain marked`)
      const afterCheck = await client.query(`
        select gp.id, gp.base_price_cents as "basePriceCents", gp.status
        from global_products gp where gp.id = any($1::int[]) order by gp.id
      `, [lockedPlan.map((row) => row.id)])
      for (const row of lockedPlan) {
        const after = afterCheck.rows.find((candidate) => candidate.id === row.id)
        assert(after?.basePriceCents === row.basePriceCents, `Price changed for product ${row.id}`)
        assert(after?.status === row.status, `Status changed for product ${row.id}`)
      }

      const commitReport = {
        ...baseReport,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        auditLogId: audit.rows[0].id,
        validation: {
          remainingMarkedInScope: remaining.rows.length,
          pricesVerifiedUnchanged: lockedPlan.length,
          statusesVerifiedUnchanged: lockedPlan.length,
        },
      }
      saveReport(output, commitReport)
      console.log(JSON.stringify({
        mode: "COMMITTED",
        output,
        summary,
        auditLogId: audit.rows[0].id,
        validation: commitReport.validation,
      }, null, 2))
    } catch (error) {
      await client.query("rollback")
      throw error
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

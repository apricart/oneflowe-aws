#!/usr/bin/env tsx
/**
 * Restrict K-Electric's catalogue to one hand-over item list: every listed
 * product active, every other product deactivated.
 *
 *   npm run restrict:ke-catalogue -- --sheet=<xls>                       # dry run
 *   npm run restrict:ke-catalogue -- --sheet=<xls> --keep="<name>,<name>" # also keep these
 *   npm run restrict:ke-catalogue -- --sheet=<xls> --rollback-test ...
 *   npm run restrict:ke-catalogue -- --sheet=<xls> --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=<id:code:name> \
 *     --confirm-plan=<digest printed by the dry run>
 *
 *   npm run restrict:ke-catalogue -- --reverse=<commit report>            # undo, dry run
 *   npm run restrict:ke-catalogue -- --reverse=<commit report> --commit ... # undo, gated the same way
 *
 * "Deactivated" is exactly what the Organization Inventory page does when a
 * Super Admin turns a product off: the organization entry goes inactive and
 * every non-deleted branch row of it goes inactive and hidden, with the same
 * audit rows. Nothing is deleted; prices, stock and order history are
 * untouched; an order already placed can still be approved and delivered.
 * `--keep` names products to treat as if they were on the list, resolved the
 * same way. See `lib/legacy-import/ke-catalogue-restriction.ts` for the rules.
 *
 * Every write is scoped to the confirmed organization's own rows and pinned
 * to what the plan saw; the plan is rebuilt under the sync's advisory lock
 * and its digest must match; the run is recorded in `legacy_import_batches`;
 * fingerprints prove that no other tenant's rows, no global product, and none
 * of the listed products' own rows moved.
 */

import { existsSync, readFileSync } from "node:fs"
import * as dotenv from "dotenv"
import { z } from "zod"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import {
  catalogueRestrictionPlanLines,
  catalogueRestrictionReversalLines,
  planCatalogueRestriction,
  planCatalogueRestrictionReversal,
  summarizeCatalogueRestriction,
  type CatalogueRestrictionPlan,
  type CatalogueRestrictionReversal,
  type OrganizationEntry,
} from "../lib/legacy-import/ke-catalogue-restriction"
import type { WantedProduct } from "../lib/legacy-import/ke-group-catalogue"
import { KE_SYNC_SOURCE as SOURCE_SYSTEM } from "../lib/legacy-import/ke-sync"
import {
  argument,
  assert,
  assertActor,
  assertOrganization,
  flag,
  loadList,
  organizationConfirmation,
  readBranchAssignments,
  readMappedProducts,
  resolveOrganization,
  rows,
  sha256,
  writeReport,
  type QueryClient,
  type Row,
  type TargetOrganization,
} from "./lib/ke-item-list-io"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const IMPORTER = "restrict-ke-catalogue"
const DEFAULT_ORGANIZATION = { code: "0001", name: "K-Electric" } as const

interface Options {
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  organizationCode: string
  organizationName: string
  sheetPath?: string
  keepNames: string[]
  reversePath?: string
  outputPath: string
}

function parseOptions(): Options {
  const reverse = argument("reverse")
  const sheet = argument("sheet")
  const date = new Date().toISOString().slice(0, 10)
  return {
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    organizationCode: argument("organization-code") ?? DEFAULT_ORGANIZATION.code,
    organizationName: argument("organization-name") ?? DEFAULT_ORGANIZATION.name,
    sheetPath: sheet ? resolveWorkspacePath(sheet) : undefined,
    keepNames: (argument("keep") ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    reversePath: reverse ? resolveWorkspacePath(reverse) : undefined,
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-catalogue-restrict-${reverse ? "reverse" : "apply"}-${date}.json`,
    ),
  }
}

// ============================================================
// Reads
// ============================================================

/** Every non-deleted catalogue entry of the organization. */
async function readEntries(client: QueryClient, organizationId: number): Promise<OrganizationEntry[]> {
  return (await rows(client,
    `select oi.id, oi.global_product_id, gp.name, oi.is_active
       from organization_inventory oi join global_products gp on gp.id = oi.global_product_id
      where oi.organization_id = $1 and oi.deleted_at is null
      order by oi.id`, [organizationId]))
    .map((row): OrganizationEntry => ({
      organizationInventoryId: Number(row.id),
      globalProductId: Number(row.global_product_id),
      productName: String(row.name),
      isActive: Boolean(row.is_active),
    }))
}

/**
 * Proof that nothing outside the plan moved: every other tenant's catalogue
 * and branch rows, every global product, and the listed products' own rows
 * (the plan never touches a kept product).
 */
async function fingerprints(client: QueryClient, organizationId: number, keptIds: readonly number[]): Promise<Row> {
  const [row] = await rows(client, `
    select
      (select count(*) from organization_inventory where organization_id <> $1)::bigint                              as other_catalogue_rows,
      (select count(*) from organization_inventory where organization_id <> $1 and is_active and deleted_at is null)::bigint
                                                                                                                       as other_catalogue_active,
      (select count(*) from branch_inventory where organization_id <> $1)::bigint                                    as other_branch_rows,
      (select count(*) from branch_inventory where organization_id <> $1
         and is_visible and is_active and deleted_at is null)::bigint                                                 as other_branch_live,
      (select count(*) from global_products where status = 'active' and deleted_at is null)::bigint                  as global_active,
      (select coalesce(sum(stock_quantity), 0) from global_products)::numeric                                         as global_stock,
      (select coalesce(sum(custom_price_cents), 0) from organization_inventory where organization_id = $1)::bigint    as own_prices,
      (select count(*) from organization_inventory where organization_id = $1 and deleted_at is null)::bigint         as own_catalogue_rows,
      (select count(*) from organization_inventory where organization_id = $1 and id = any($2::int[]) and is_active and deleted_at is null)::bigint
                                                                                                                       as kept_active,
      (select count(*) from branch_inventory where organization_id = $1 and organization_inventory_id = any($2::int[])
         and is_visible and is_active and deleted_at is null)::bigint                                                 as kept_branch_live
  `, [organizationId, keptIds])
  return row
}

// ============================================================
// Forward run
// ============================================================

interface ForwardContext {
  organization: TargetOrganization
  list: { path: string; lines: WantedProduct[]; sha256: string }
  keepNames: string[]
}

async function buildPlan(client: QueryClient, context: ForwardContext): Promise<CatalogueRestrictionPlan> {
  const wanted = [...context.list.lines, ...context.keepNames.map((sourceName): WantedProduct => ({ sourceName }))]
  return planCatalogueRestriction(
    wanted,
    await readMappedProducts(client, context.organization.id),
    await readEntries(client, context.organization.id),
    await readBranchAssignments(client, context.organization.id),
  )
}

function printPlan(context: ForwardContext, plan: CatalogueRestrictionPlan): void {
  const counts = summarizeCatalogueRestriction(plan, context.list.lines.length)
  console.log(`List ................. ${context.list.path}`)
  console.log(`  lines .............. ${counts.listLines}${context.keepNames.length ? ` + ${context.keepNames.length} kept by flag` : ""}, resolving to ${counts.kept} product(s)`)
  console.log(`  organization ....... ${organizationConfirmation(context.organization)}`)
  console.log("")
  console.log("CATALOGUE")
  console.log(`  kept ............... ${counts.kept} listed product(s), untouched`)
  console.log(`  activate ........... ${counts.activations} listed product(s) currently off`)
  console.log(`  deactivate ......... ${counts.deactivations} product(s) not on the list`)
  console.log(`    branch rows ...... ${counts.branchRowsHidden} hidden, ${counts.branchRowsAlreadyHidden} already hidden`)
  console.log(`  already off ........ ${counts.alreadyInactive} product(s) not on the list, left alone`)
  console.log(`  list names skipped . ${counts.skipped}`)
  console.log(`  warnings ........... ${counts.warnings}`)

  for (const entry of plan.activations) {
    console.log(`    ACTIVATE    oi#${entry.organizationInventoryId} #${entry.globalProductId} "${entry.productName}"`)
  }
  for (const entry of plan.deactivations) {
    const live = entry.branchRows.filter((row) => row.isVisible && row.isActive).length
    console.log(`    DEACTIVATE  oi#${entry.organizationInventoryId} #${entry.globalProductId} "${entry.productName}": ${entry.branchRows.length} branch row(s), ${live} live`)
  }
  for (const entry of plan.alreadyInactive) {
    console.log(`    already off oi#${entry.organizationInventoryId} #${entry.globalProductId} "${entry.productName}"`)
  }
  for (const entry of plan.skipped) {
    console.log(`    SKIP        ${entry.reason} "${entry.sourceNames.join('" / "')}": ${entry.detail}`)
  }
  for (const entry of plan.warnings) {
    console.log(`    WARN        ${entry.reason} product ${entry.globalProductId} ("${entry.normalizedName}"): ${entry.detail}`)
  }
}

/** The page's own writes, in its order, with its audit rows; every statement pinned and counted. */
async function applyPlan(
  client: QueryClient,
  organizationId: number,
  plan: CatalogueRestrictionPlan,
  actorUserId: string,
): Promise<{ activated: number; deactivated: number; branchRowsHidden: number }> {
  const counts = { activated: 0, deactivated: 0, branchRowsHidden: 0 }

  for (const entry of plan.activations) {
    const result = await client.query(
      `update organization_inventory set is_active = true, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = false and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1, `entry ${entry.organizationInventoryId} ("${entry.productName}") moved since the plan was built; re-run the dry run`)
    await client.query(
      `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
       values ($1, $2, 'UPDATE', 'OrganizationAssignment', $3, $4::jsonb)`,
      [actorUserId, organizationId, String(entry.organizationInventoryId),
        JSON.stringify({ updateData: { isActive: true }, performedByRole: "SUPER_ADMIN", importer: IMPORTER })])
    counts.activated += 1
  }

  for (const entry of plan.deactivations) {
    const result = await client.query(
      `update organization_inventory set is_active = false, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = true and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1, `entry ${entry.organizationInventoryId} ("${entry.productName}") moved since the plan was built; re-run the dry run`)

    const cascade = await client.query(
      `update branch_inventory set is_active = false, is_visible = false, updated_at = now()
        where organization_inventory_id = $1 and organization_id = $2 and deleted_at is null
        returning id, branch_id`,
      [entry.organizationInventoryId, organizationId])
    assert(cascade.rowCount === entry.branchRows.length,
      `entry ${entry.organizationInventoryId} ("${entry.productName}") has ${String(cascade.rowCount)} branch row(s), the plan saw ${entry.branchRows.length}; re-run the dry run`)

    if (cascade.rows.length > 0) {
      // Keyed by the organization entry, not the joined row ids as the page's
      // cascade does: `entity_id` is varchar(128) and a product stocked at
      // eighty branches overflows it. The row ids go in the metadata instead.
      await client.query(
        `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
         values ($1, $2, 'CASCADE_UPDATE', 'BranchInventory', $3, $4::jsonb)`,
        [actorUserId, organizationId, String(entry.organizationInventoryId),
          JSON.stringify({
            triggeredBy: "organization_inventory_status_change",
            organizationInventoryId: entry.organizationInventoryId,
            isActive: false,
            updatedCount: cascade.rows.length,
            branchInventoryIds: cascade.rows.map((row) => Number(row.id)),
            affectedBranches: cascade.rows.map((row) => Number(row.branch_id)),
            performedByRole: "SUPER_ADMIN",
            importer: IMPORTER,
          })])
    }
    await client.query(
      `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
       values ($1, $2, 'UPDATE', 'OrganizationAssignment', $3, $4::jsonb)`,
      [actorUserId, organizationId, String(entry.organizationInventoryId),
        JSON.stringify({ updateData: { isActive: false }, performedByRole: "SUPER_ADMIN", importer: IMPORTER })])
    counts.deactivated += 1
    counts.branchRowsHidden += cascade.rows.length
  }

  return counts
}

async function runForward(options: Options): Promise<void> {
  assert(options.sheetPath, "A dry run or commit needs --sheet=<xls>")
  const list = loadList(options.sheetPath)
  const { pool } = await import("../lib/db-cli")

  try {
    const organization = await resolveOrganization(pool, options)
    const context: ForwardContext = {
      organization,
      list: { path: options.sheetPath, lines: list.lines, sha256: list.sha256 },
      keepNames: options.keepNames,
    }
    const plan = await buildPlan(pool, context)
    const digest = sha256(catalogueRestrictionPlanLines(plan).join("\n"))
    const counts = summarizeCatalogueRestriction(plan, list.lines.length)
    const nothingToDo = plan.activations.length + plan.deactivations.length === 0

    printPlan(context, plan)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: IMPORTER,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization,
      source: { list: options.sheetPath, sha256: list.sha256, keep: options.keepNames },
      planDigest: digest,
      counts,
      plan,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to do: every listed product is active and every other product is already off.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        const keep = options.keepNames.length ? ` --keep="${options.keepNames.join(",")}"` : ""
        console.log(`  npm run restrict:ke-catalogue -- --sheet="${options.sheetPath}"${keep} --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    // A rollback test is gated exactly like a commit, as the sync's is.
    assert(!nothingToDo, "Nothing to do")
    assert(options.confirmOrganization === organizationConfirmation(organization),
      `Commit requires --confirm-organization=${organizationConfirmation(organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const keptIds = plan.kept.map((product) => product.organizationInventoryId)
    const before = await fingerprints(pool, organization.id, keptIds)
    const client = await pool.connect()
    try {
      await client.query("begin")
      // The same lock the sync takes, so the two can never interleave.
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // Rebuilt under the lock from rows read there. Anything that moved
      // between the dry run and now changes the digest, and nothing is written.
      const lockedPlan = await buildPlan(client, context)
      assert(sha256(catalogueRestrictionPlanLines(lockedPlan).join("\n")) === digest,
        "Plan changed between confirmation and commit; re-run the dry run")

      let batchId: string | null = null
      if (options.commit) {
        const [batch] = await rows(client,
          `insert into legacy_import_batches
             (organization_id, source_system, source_manifest, status, imported_by_user_id)
           values ($1, $2, $3::jsonb, 'RUNNING', $4)
           returning id`,
          [
            organization.id,
            SOURCE_SYSTEM,
            JSON.stringify({
              importer: IMPORTER,
              planDigest: digest,
              list: { path: options.sheetPath, sha256: list.sha256, keep: options.keepNames },
              generatedAt: new Date().toISOString(),
            }),
            actorUserId,
          ])
        batchId = String(batch.id)
      }

      const applied = await applyPlan(client, organization.id, lockedPlan, actorUserId)

      if (batchId) {
        await client.query(
          `update legacy_import_batches set status = 'COMPLETED', counts = $1::jsonb, completed_at = now() where id = $2`,
          [JSON.stringify(applied), batchId])
      }

      if (options.rollbackTest) {
        await client.query("rollback")
        console.log(`\nRollback test: applied and rolled back. Counts: ${JSON.stringify(applied)}`)
        return
      }

      await client.query("commit")
      console.log(`\nCommitted batch ${batchId}. Counts: ${JSON.stringify(applied)}`)
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }

    // Committed. Prove nothing else moved and nothing remains, then clear the
    // caches the shop and the inventory pages read through — a cache that
    // will not clear is reported, not thrown, because the write already happened.
    const after = await fingerprints(pool, organization.id, keptIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildPlan(pool, context)
    assert(remaining.activations.length + remaining.deactivations.length === 0,
      `${remaining.activations.length + remaining.deactivations.length} change(s) still pending after commit; investigate immediately`)
    console.log("Verified: other tenants, global products and the listed products untouched; a further run plans nothing.")

    writeReport(options.outputPath, { ...payload, committedAt: new Date().toISOString(), applied: counts })
    for (const entry of await invalidateCachePrefixes(["org-inv", "branch-inv", "analytics"])) {
      if (entry.error) console.warn(`WARNING: cache prefix "${entry.prefix}" was not cleared: ${entry.error}`)
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

// ============================================================
// Reversal
// ============================================================

const positiveId = z.number().int().positive()

/** The commit report a run writes, validated before a reversal plans anything from it. */
const commitReportSchema = z.object({
  importer: z.literal(IMPORTER, { error: `the report must be from ${IMPORTER}` }),
  mode: z.literal("COMMIT", { error: "the report must be from a committed run, not a dry run" }),
  generatedAt: z.string(),
  planDigest: z.string().min(1),
  organization: z.object({ id: positiveId, code: z.string().min(1), name: z.string().min(1) }),
  plan: z.object({
    activations: z.array(z.object({ organizationInventoryId: positiveId, globalProductId: positiveId, productName: z.string() })),
    deactivations: z.array(z.object({
      organizationInventoryId: positiveId,
      globalProductId: positiveId,
      productName: z.string(),
      branchRows: z.array(z.object({ branchId: positiveId, isVisible: z.boolean(), isActive: z.boolean() })),
    })),
  }),
})

type CommitReport = z.infer<typeof commitReportSchema>

function loadCommitReport(path: string): { report: CommitReport; sha256: string } {
  assert(existsSync(path), `Report not found: ${path}`)
  const buffer = readFileSync(path)
  const result = commitReportSchema.safeParse(JSON.parse(buffer.toString("utf8")))
  if (!result.success) throw new Error(`Not a committed catalogue-restriction report:\n${z.prettifyError(result.error)}`)
  return { report: result.data, sha256: sha256(buffer) }
}

async function buildReversal(client: QueryClient, report: CommitReport): Promise<CatalogueRestrictionReversal> {
  return planCatalogueRestrictionReversal(
    report.plan,
    await readEntries(client, report.organization.id),
    await readBranchAssignments(client, report.organization.id),
  )
}

function printReversal(reportPath: string, report: CommitReport, reversal: CatalogueRestrictionReversal): void {
  console.log(`Report ............... ${reportPath}`)
  console.log(`  written ............ ${report.generatedAt}`)
  console.log(`  organization ....... ${organizationConfirmation(report.organization)}`)
  console.log(`  recorded ........... ${report.plan.deactivations.length} deactivated, ${report.plan.activations.length} activated`)
  console.log("")
  console.log("REVERSE")
  console.log(`  reactivate ......... ${reversal.reactivations.length} product(s), putting back ${reversal.reactivations.reduce((sum, entry) => sum + entry.branchRows.length, 0)} branch row(s)`)
  console.log(`  deactivate again ... ${reversal.deactivations.length} product(s) the run switched on`)
  console.log(`  skipped ............ ${reversal.skipped.length}`)
  for (const entry of reversal.skipped) {
    console.log(`    SKIP  ${entry.reason} oi#${entry.organizationInventoryId} "${entry.productName}"${entry.branchId ? ` branch ${entry.branchId}` : ""}: ${entry.detail}`)
  }
}

/** Every statement pinned to what the run left, and must hit exactly one row. */
async function applyReversal(
  client: QueryClient,
  organizationId: number,
  reversal: CatalogueRestrictionReversal,
  actorUserId: string,
): Promise<{ reactivated: number; branchRowsPutBack: number; deactivated: number }> {
  const counts = { reactivated: 0, branchRowsPutBack: 0, deactivated: 0 }
  for (const entry of reversal.reactivations) {
    const result = await client.query(
      `update organization_inventory set is_active = true, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = false and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1, `entry ${entry.organizationInventoryId} ("${entry.productName}") moved since the plan was built; re-run the dry run`)
    for (const row of entry.branchRows) {
      const putBack = await client.query(
        `update branch_inventory set is_visible = $4, is_active = $5, updated_at = now()
          where organization_inventory_id = $1 and branch_id = $2 and organization_id = $3
            and is_visible = false and is_active = false and deleted_at is null`,
        [entry.organizationInventoryId, row.branchId, organizationId, row.isVisible, row.isActive])
      assert(putBack.rowCount === 1, `branch row ${row.branchId}/${entry.organizationInventoryId} moved since the plan was built; re-run the dry run`)
      counts.branchRowsPutBack += 1
    }
    await client.query(
      `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
       values ($1, $2, 'UPDATE', 'OrganizationAssignment', $3, $4::jsonb)`,
      [actorUserId, organizationId, String(entry.organizationInventoryId),
        JSON.stringify({ updateData: { isActive: true }, performedByRole: "SUPER_ADMIN", importer: `${IMPORTER}:reverse`, branchRowsPutBack: entry.branchRows.length })])
    counts.reactivated += 1
  }
  for (const entry of reversal.deactivations) {
    const result = await client.query(
      `update organization_inventory set is_active = false, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = true and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1, `entry ${entry.organizationInventoryId} ("${entry.productName}") moved since the plan was built; re-run the dry run`)
    counts.deactivated += 1
  }
  return counts
}

async function runReverse(options: Options): Promise<void> {
  assert(options.reversePath, "--reverse needs the commit report path")
  const { report, sha256: reportSha256 } = loadCommitReport(options.reversePath)
  const { pool } = await import("../lib/db-cli")

  try {
    await assertOrganization(pool, report.organization)
    const reversal = await buildReversal(pool, report)
    const digest = sha256(catalogueRestrictionReversalLines(reversal).join("\n"))
    const nothingToDo = reversal.reactivations.length + reversal.deactivations.length === 0

    printReversal(options.reversePath, report, reversal)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: `${IMPORTER}:reverse`,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: report.organization,
      source: { report: options.reversePath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
      planDigest: digest,
      counts: { reactivations: reversal.reactivations.length, deactivations: reversal.deactivations.length, skipped: reversal.skipped.length },
      reversal,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to reverse: every product the run touched is already back, or has been changed since (see SKIP lines).")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run restrict:ke-catalogue -- --reverse="${options.reversePath}" --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(report.organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    assert(!nothingToDo, "Nothing to reverse")
    assert(options.confirmOrganization === organizationConfirmation(report.organization),
      `Commit requires --confirm-organization=${organizationConfirmation(report.organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const untouchedIds = (await readEntries(pool, report.organization.id))
      .map((entry) => entry.organizationInventoryId)
      .filter((id) => !report.plan.deactivations.some((entry) => entry.organizationInventoryId === id)
        && !report.plan.activations.some((entry) => entry.organizationInventoryId === id))
    const before = await fingerprints(pool, report.organization.id, untouchedIds)
    const client = await pool.connect()
    try {
      await client.query("begin")
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      const lockedReversal = await buildReversal(client, report)
      assert(sha256(catalogueRestrictionReversalLines(lockedReversal).join("\n")) === digest,
        "Plan changed between confirmation and commit; re-run the dry run")

      let batchId: string | null = null
      if (options.commit) {
        const [batch] = await rows(client,
          `insert into legacy_import_batches
             (organization_id, source_system, source_manifest, status, imported_by_user_id)
           values ($1, $2, $3::jsonb, 'RUNNING', $4)
           returning id`,
          [
            report.organization.id,
            SOURCE_SYSTEM,
            JSON.stringify({
              importer: `${IMPORTER}:reverse`,
              planDigest: digest,
              reverses: { report: options.reversePath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
              generatedAt: new Date().toISOString(),
            }),
            actorUserId,
          ])
        batchId = String(batch.id)
      }

      const applied = await applyReversal(client, report.organization.id, lockedReversal, actorUserId)

      if (batchId) {
        await client.query(
          `update legacy_import_batches set status = 'COMPLETED', counts = $1::jsonb, completed_at = now() where id = $2`,
          [JSON.stringify(applied), batchId])
      }

      if (options.rollbackTest) {
        await client.query("rollback")
        console.log(`\nRollback test: applied and rolled back. Counts: ${JSON.stringify(applied)}`)
        return
      }

      await client.query("commit")
      console.log(`\nCommitted batch ${batchId}. Counts: ${JSON.stringify(applied)}`)
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }

    const after = await fingerprints(pool, report.organization.id, untouchedIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildReversal(pool, report)
    assert(remaining.reactivations.length + remaining.deactivations.length === 0,
      `${remaining.reactivations.length + remaining.deactivations.length} change(s) still pending after commit; investigate immediately`)
    console.log("Verified: other tenants, global products and untouched products unchanged; a further reversal plans nothing.")

    writeReport(options.outputPath, { ...payload, committedAt: new Date().toISOString() })
    for (const entry of await invalidateCachePrefixes(["org-inv", "branch-inv", "analytics"])) {
      if (entry.error) console.warn(`WARNING: cache prefix "${entry.prefix}" was not cleared: ${entry.error}`)
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  if (options.reversePath) await runReverse(options)
  else await runForward(options)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

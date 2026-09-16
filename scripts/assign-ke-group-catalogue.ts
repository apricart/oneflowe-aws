#!/usr/bin/env tsx
/**
 * Make one hand-over item list orderable at every branch of chosen K-Electric
 * groups.
 *
 *   npm run assign:ke-group-catalogue -- --sheet=<xls> --groups="<name>,<name>"   # dry run
 *   npm run assign:ke-group-catalogue -- --sheet=<xls> --groups=... --hide-others  # also hide what is not listed
 *   npm run assign:ke-group-catalogue -- --sheet=<xls> --groups=... --rollback-test
 *   npm run assign:ke-group-catalogue -- --sheet=<xls> --groups=... --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=<id:code:name> \
 *     --confirm-plan=<digest printed by the dry run>
 *
 *   npm run assign:ke-group-catalogue -- --reverse=<commit report>               # undo, dry run
 *   npm run assign:ke-group-catalogue -- --reverse=<commit report> --commit ...   # undo, gated the same way
 *
 * The sync (`sync:ke`) mirrors the legacy per-location item list and by design
 * assigns a product to a branch only where legacy lists it. This goes past
 * that on purpose: every product on the list is to be orderable at every
 * active branch of the named groups: a missing branch row is created, a
 * hidden, inactive or soft-deleted one is restored, and a listed product whose
 * organization entry is off is switched back on (that entry only). With
 * `--hide-others`, every product live at those branches but not on the list
 * is hidden there, row by row, so the branches see the list and nothing else
 * while every other branch keeps what it has. Each row's before-state is
 * recorded so the run can be reversed. It never creates a product or an
 * organization entry, never deletes, never changes a price or stock, and
 * never touches a branch outside the named groups. See
 * `lib/legacy-import/ke-group-catalogue.ts` for the rules.
 *
 * `--groups` is required and matched by exact name inside the organization: a
 * run is never allowed to default onto the Distribution group, whose locations
 * legacy stocks with a shorter list by design. The organization is resolved by
 * `--organization-code` and refused if that code belongs to a differently-named
 * tenant, as the sync does. Every write is pinned to what the plan saw, the
 * plan is rebuilt under the sync's advisory lock and its digest must match the
 * confirmed one, the run is recorded in `legacy_import_batches`, and
 * fingerprints prove that no other tenant's rows and none of the
 * organization's rows outside the named groups moved.
 */

import { existsSync, readFileSync } from "node:fs"
import * as dotenv from "dotenv"

import { invalidateCachePrefixes } from "../lib/cache-cli"
import {
  groupCataloguePlanLines,
  groupCatalogueReversalLines,
  parseGroupCatalogueCommitReport,
  planGroupCatalogue,
  planGroupCatalogueReversal,
  summarizeGroupCatalogue,
  type CurrentOrganizationEntry,
  type GroupBranch,
  type GroupCatalogueCommitReport,
  type GroupCataloguePlan,
  type GroupCatalogueReversal,
  type WantedProduct,
} from "../lib/legacy-import/ke-group-catalogue"
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

const IMPORTER = "assign-ke-group-catalogue"
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
  groupNames: string[]
  hideOthers: boolean
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
    groupNames: (argument("groups") ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    hideOthers: flag("hide-others"),
    reversePath: reverse ? resolveWorkspacePath(reverse) : undefined,
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-group-catalogue-${reverse ? "reverse" : "assign"}-${date}.json`,
    ),
  }
}

// ============================================================
// Reads
// ============================================================

/** Every branch of the named groups, whatever its status; every name must match exactly one group. */
async function readGroupBranches(client: QueryClient, organizationId: number, names: readonly string[]): Promise<GroupBranch[]> {
  const groups = await rows(client,
    `select id, name, status from groups where organization_id = $1 and name = any($2::text[]) order by id`,
    [organizationId, names])
  for (const name of names) {
    const matches = groups.filter((group) => String(group.name) === name)
    assert(matches.length === 1,
      matches.length === 0
        ? `No group named "${name}" in organization ${organizationId} (names are matched exactly)`
        : `Group name "${name}" matches ${matches.length} groups in organization ${organizationId}; refusing`)
  }
  const groupIds = groups.map((group) => Number(group.id))
  return (await rows(client,
    `select b.id, b.name, b.status, b.group_id, g.name as group_name
       from branches b join groups g on g.id = b.group_id
      where b.organization_id = $1 and b.group_id = any($2::int[])
      order by b.group_id, b.id`, [organizationId, groupIds]))
    .map((row): GroupBranch => ({
      groupId: Number(row.group_id),
      groupName: String(row.group_name),
      branchId: Number(row.id),
      branchName: String(row.name),
      active: String(row.status) === "active",
    }))
}

/** Every non-deleted catalogue entry of the organization, with its switch. */
async function readOrganizationEntries(client: QueryClient, organizationId: number): Promise<CurrentOrganizationEntry[]> {
  return (await rows(client,
    `select id, is_active from organization_inventory where organization_id = $1 and deleted_at is null order by id`,
    [organizationId]))
    .map((row): CurrentOrganizationEntry => ({ organizationInventoryId: Number(row.id), isActive: Boolean(row.is_active) }))
}

/**
 * Proof that nothing outside the target moved: every other tenant's branch
 * rows, and the organization's own rows at every branch outside the named
 * groups — by count and by live count.
 */
async function fingerprints(client: QueryClient, organizationId: number, branchIds: readonly number[]): Promise<Row> {
  const [row] = await rows(client, `
    select
      (select count(*) from branch_inventory where organization_id <> $1)::bigint                                   as other_rows,
      (select count(*) from branch_inventory where organization_id <> $1
         and is_visible and is_active and deleted_at is null)::bigint                                                as other_live_rows,
      (select count(*) from branch_inventory where organization_id = $1 and branch_id <> all($2::int[]))::bigint     as own_other_branch_rows,
      (select count(*) from branch_inventory where organization_id = $1 and branch_id <> all($2::int[])
         and is_visible and is_active and deleted_at is null)::bigint                                                as own_other_branch_live_rows,
      (select count(*) from organization_inventory where organization_id = $1 and deleted_at is null)::bigint        as own_catalogue_rows,
      (select coalesce(sum(custom_price_cents), 0) from organization_inventory where organization_id = $1)::bigint   as own_catalogue_prices,
      (select coalesce(sum(stock_quantity), 0) from global_products)::numeric                                        as global_stock
  `, [organizationId, branchIds])
  return row
}

// ============================================================
// Forward run
// ============================================================

interface ForwardContext {
  organization: TargetOrganization
  list: { path: string; lines: WantedProduct[]; sha256: string }
  groupNames: string[]
  hideOthers: boolean
}

async function buildPlan(
  client: QueryClient,
  context: ForwardContext,
): Promise<{ plan: GroupCataloguePlan; branchIds: number[] }> {
  const branches = await readGroupBranches(client, context.organization.id, context.groupNames)
  const plan = planGroupCatalogue(
    context.list.lines,
    await readMappedProducts(client, context.organization.id),
    branches,
    await readBranchAssignments(client, context.organization.id),
    { hideOthers: context.hideOthers },
  )
  return { plan, branchIds: branches.map((branch) => branch.branchId) }
}

function printPlan(context: ForwardContext, plan: GroupCataloguePlan): void {
  const counts = summarizeGroupCatalogue(plan, context.list.lines.length)
  console.log(`List ................. ${context.list.path}`)
  console.log(`  lines .............. ${counts.listLines}, resolving to ${counts.products} product(s)`)
  console.log(`  organization ....... ${organizationConfirmation(context.organization)}`)
  for (const group of plan.groups) {
    console.log(`  group .............. ${group.groupName} (${group.groupId}): ${group.activeBranches} active branch(es)`)
  }
  console.log("")
  console.log("CATALOGUE")
  console.log(`  activate ........... ${counts.activations} listed product(s) whose organization entry is off`)
  for (const entry of plan.activations) {
    console.log(`    ACTIVATE  oi#${entry.organizationInventoryId} #${entry.globalProductId} "${entry.normalizedName}"`)
  }
  console.log("")
  console.log("BRANCH ROWS")
  console.log(`  create ............. ${counts.toCreate} (no row today)`)
  console.log(`  restore ............ ${counts.toRestore} (hidden, inactive or soft-deleted today)`)
  console.log(`  hide ............... ${counts.toHide}${context.hideOthers ? " (live at these branches, not on the list)" : " (--hide-others not given)"}`)
  console.log(`  unchanged .......... ${counts.unchanged} already visible and active`)
  console.log(`  branches touched ... ${counts.branchesTouched} of ${counts.activeBranches}`)
  console.log(`  inactive branches .. ${counts.inactiveBranches} skipped`)
  console.log(`  list names skipped . ${counts.skipped}`)
  console.log(`  warnings ........... ${counts.warnings}`)

  const byBranch = new Map<string, { create: number; restore: number; hide: number }>()
  const tallyFor = (entry: { groupName: string; branchName: string; branchId: number }) => {
    const key = `${entry.groupName} / ${entry.branchName} (${entry.branchId})`
    const tally = byBranch.get(key) ?? { create: 0, restore: 0, hide: 0 }
    byBranch.set(key, tally)
    return tally
  }
  for (const entry of plan.assignments) {
    if (entry.action === "CREATE") tallyFor(entry).create += 1
    else tallyFor(entry).restore += 1
  }
  for (const entry of plan.hides) tallyFor(entry).hide += 1
  for (const [branch, tally] of [...byBranch.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`    ${branch}: +${tally.create} created, ${tally.restore} restored, ${tally.hide} hidden`)
  }
  const hiddenByProduct = new Map<string, number>()
  for (const entry of plan.hides) {
    const key = `oi#${entry.organizationInventoryId} "${entry.normalizedName ?? "(unmapped)"}"`
    hiddenByProduct.set(key, (hiddenByProduct.get(key) ?? 0) + 1)
  }
  for (const [product, n] of [...hiddenByProduct.entries()].sort(([, a], [, b]) => b - a)) {
    console.log(`    HIDE      ${product}: at ${n} branch(es)`)
  }
  for (const branch of plan.inactiveBranches) {
    console.log(`    INACTIVE  ${branch.groupName} / ${branch.branchName} (${branch.branchId}): skipped`)
  }
  for (const entry of plan.skipped) {
    console.log(`    SKIP      ${entry.reason} "${entry.sourceNames.join('" / "')}": ${entry.detail}`)
  }
  for (const entry of plan.warnings) {
    console.log(`    WARN      ${entry.reason} product ${entry.globalProductId} ("${entry.normalizedName}"): ${entry.detail}`)
  }
}

/**
 * Three writes, in the order the shop listing checks them: the organization
 * entry is switched on, the branch rows are upserted (the sync's own
 * statement, one per chunk, covering a missing row and a dormant one alike),
 * then the rows for everything else are hidden — each pinned to the live row
 * the plan saw, so a row someone changed meanwhile refuses the whole commit.
 */
async function applyPlan(
  client: QueryClient,
  organizationId: number,
  plan: GroupCataloguePlan,
  actorUserId: string,
): Promise<{ activated: number; created: number; restored: number; hidden: number }> {
  const counts = { activated: 0, created: 0, restored: 0, hidden: 0 }
  const chunkSize = 500

  for (const entry of plan.activations) {
    const result = await client.query(
      `update organization_inventory set is_active = true, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = false and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1,
      `entry ${entry.organizationInventoryId} ("${entry.normalizedName}") moved since the plan was built; re-run the dry run`)
    await client.query(
      `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
       values ($1, $2, 'UPDATE', 'OrganizationAssignment', $3, $4::jsonb)`,
      [actorUserId, organizationId, String(entry.organizationInventoryId),
        JSON.stringify({ updateData: { isActive: true }, performedByRole: "SUPER_ADMIN", importer: IMPORTER })])
    counts.activated += 1
  }

  for (let offset = 0; offset < plan.assignments.length; offset += chunkSize) {
    const chunk = plan.assignments.slice(offset, offset + chunkSize)
    const result = await client.query(
      `insert into branch_inventory
         (branch_id, organization_id, organization_inventory_id, assigned_by_user_id, is_visible, is_active)
       select pair.branch_id, $1, pair.organization_inventory_id, $2, true, true
         from unnest($3::int[], $4::int[]) as pair(branch_id, organization_inventory_id)
       on conflict (branch_id, organization_inventory_id) do update
         set is_visible = true, is_active = true, deleted_at = null,
             assigned_by_user_id = excluded.assigned_by_user_id, updated_at = now()`,
      [
        organizationId,
        actorUserId,
        chunk.map((entry) => entry.branchId),
        chunk.map((entry) => entry.organizationInventoryId),
      ])
    assert(result.rowCount === chunk.length,
      `upsert wrote ${String(result.rowCount)} row(s) for a chunk of ${chunk.length}; investigate immediately`)
    for (const entry of chunk) {
      if (entry.action === "CREATE") counts.created += 1
      else counts.restored += 1
    }
  }

  for (let offset = 0; offset < plan.hides.length; offset += chunkSize) {
    const chunk = plan.hides.slice(offset, offset + chunkSize)
    const result = await client.query(
      `update branch_inventory bi
          set is_visible = false, is_active = false, updated_at = now()
         from unnest($2::int[], $3::int[]) as pair(branch_id, organization_inventory_id)
        where bi.organization_id = $1 and bi.branch_id = pair.branch_id
          and bi.organization_inventory_id = pair.organization_inventory_id
          and bi.is_visible and bi.is_active and bi.deleted_at is null`,
      [
        organizationId,
        chunk.map((entry) => entry.branchId),
        chunk.map((entry) => entry.organizationInventoryId),
      ])
    assert(result.rowCount === chunk.length,
      `hid ${String(result.rowCount)} row(s) of a chunk of ${chunk.length}: a row moved since the plan was built; re-run the dry run`)
    counts.hidden += chunk.length
  }
  return counts
}

async function runForward(options: Options): Promise<void> {
  assert(options.sheetPath, "A dry run or commit needs --sheet=<xls>")
  assert(options.groupNames.length > 0, "--groups=<name,name,...> is required; the run never defaults onto a group")
  const list = loadList(options.sheetPath)
  const { pool } = await import("../lib/db-cli")

  try {
    const organization = await resolveOrganization(pool, options)
    const context: ForwardContext = {
      organization,
      list: { path: options.sheetPath, lines: list.lines, sha256: list.sha256 },
      groupNames: options.groupNames,
      hideOthers: options.hideOthers,
    }
    const { plan, branchIds } = await buildPlan(pool, context)
    const digest = sha256(groupCataloguePlanLines(plan).join("\n"))
    const counts = summarizeGroupCatalogue(plan, list.lines.length)
    const nothingToDo = plan.activations.length + plan.assignments.length + plan.hides.length === 0

    printPlan(context, plan)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: IMPORTER,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization,
      source: { list: options.sheetPath, sha256: list.sha256, groups: options.groupNames, hideOthers: options.hideOthers },
      planDigest: digest,
      counts,
      plan,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log(options.hideOthers
          ? "\nNothing to do: the named groups' branches already list every listed product and nothing else."
          : "\nNothing to do: every listed product is already visible and active at every active branch of the named groups.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        const hide = options.hideOthers ? " --hide-others" : ""
        console.log(`  npm run assign:ke-group-catalogue -- --sheet="${options.sheetPath}" --groups="${options.groupNames.join(",")}"${hide} --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    // A rollback test is gated exactly like a commit, as the sync's is: the
    // same person, the same tenant and the same plan are named either way.
    assert(!nothingToDo, "Nothing to do")
    assert(options.confirmOrganization === organizationConfirmation(organization),
      `Commit requires --confirm-organization=${organizationConfirmation(organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const before = await fingerprints(pool, organization.id, branchIds)
    const client = await pool.connect()
    try {
      await client.query("begin")
      // The same lock the sync takes, so the two can never interleave.
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // Rebuilt under the lock from rows read there. Anything that moved
      // between the dry run and now changes the digest, and nothing is written.
      const { plan: lockedPlan } = await buildPlan(client, context)
      assert(sha256(groupCataloguePlanLines(lockedPlan).join("\n")) === digest,
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
              list: { path: options.sheetPath, sha256: list.sha256 },
              groups: plan.groups,
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
    // shop's cache — a cache that will not clear is reported, not thrown,
    // because the write already happened.
    const after = await fingerprints(pool, organization.id, branchIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const { plan: remaining } = await buildPlan(pool, context)
    const pending = remaining.activations.length + remaining.assignments.length + remaining.hides.length
    assert(pending === 0, `${pending} change(s) still pending after commit; investigate immediately`)
    console.log("Verified: other tenants and other branches untouched; a further run plans nothing.")

    writeReport(options.outputPath, { ...payload, committedAt: new Date().toISOString(), applied: counts })
    for (const entry of await invalidateCachePrefixes(["branch-inv", "analytics"])) {
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

function loadCommitReport(path: string): { report: GroupCatalogueCommitReport; sha256: string } {
  assert(existsSync(path), `Report not found: ${path}`)
  const buffer = readFileSync(path)
  return { report: parseGroupCatalogueCommitReport(JSON.parse(buffer.toString("utf8"))), sha256: sha256(buffer) }
}

async function buildReversal(client: QueryClient, report: GroupCatalogueCommitReport): Promise<GroupCatalogueReversal> {
  return planGroupCatalogueReversal(
    report.plan,
    await readBranchAssignments(client, report.organization.id),
    await readOrganizationEntries(client, report.organization.id),
  )
}

function printReversal(reportPath: string, report: GroupCatalogueCommitReport, reversal: GroupCatalogueReversal): void {
  console.log(`Report ............... ${reportPath}`)
  console.log(`  written ............ ${report.generatedAt}`)
  console.log(`  organization ....... ${organizationConfirmation(report.organization)}`)
  console.log(`  recorded ........... ${report.plan.assignments.length} row(s) written, ${report.plan.hides.length} hidden, ${report.plan.activations.length} entr(ies) switched on`)
  console.log("")
  console.log("REVERSE")
  console.log(`  delete ............. ${reversal.deletes.length} row(s) the run created`)
  console.log(`  put back ........... ${reversal.restores.length} row(s) to the state the run found them in`)
  console.log(`  show again ......... ${reversal.unhides.length} row(s) the run hid`)
  console.log(`  switch off again ... ${reversal.deactivations.length} organization entr(ies) the run switched on`)
  console.log(`  skipped ............ ${reversal.skipped.length}`)
  for (const entry of reversal.skipped) {
    const where = entry.branchId === null ? `oi#${entry.organizationInventoryId}` : `${entry.branchName} (${entry.branchId}) oi#${entry.organizationInventoryId}`
    console.log(`    SKIP  ${entry.reason} ${where} "${entry.normalizedName ?? "(unmapped)"}": ${entry.detail}`)
  }
}

/** Every statement pinned to the visible, active row the run left, and must hit exactly one. */
async function applyReversal(
  client: QueryClient,
  organizationId: number,
  reversal: GroupCatalogueReversal,
  actorUserId: string,
): Promise<{ deleted: number; putBack: number; shownAgain: number; switchedOff: number }> {
  const counts = { deleted: 0, putBack: 0, shownAgain: 0, switchedOff: 0 }
  for (const entry of reversal.deletes) {
    const result = await client.query(
      `delete from branch_inventory
        where organization_id = $1 and branch_id = $2 and organization_inventory_id = $3
          and is_visible and is_active and deleted_at is null`,
      [organizationId, entry.branchId, entry.organizationInventoryId])
    assert(result.rowCount === 1,
      `row ${entry.branchName} / "${entry.normalizedName}" moved since the plan was built; re-run the dry run`)
    counts.deleted += 1
  }
  for (const entry of reversal.restores) {
    const result = await client.query(
      `update branch_inventory
          set is_visible = $4, is_active = $5, deleted_at = case when $6 then now() else null end, updated_at = now()
        where organization_id = $1 and branch_id = $2 and organization_inventory_id = $3
          and is_visible and is_active and deleted_at is null`,
      [organizationId, entry.branchId, entry.organizationInventoryId, entry.to.isVisible, entry.to.isActive, entry.to.deleted])
    assert(result.rowCount === 1,
      `row ${entry.branchName} / "${entry.normalizedName}" moved since the plan was built; re-run the dry run`)
    counts.putBack += 1
  }
  for (const entry of reversal.unhides) {
    const result = await client.query(
      `update branch_inventory set is_visible = true, is_active = true, updated_at = now()
        where organization_id = $1 and branch_id = $2 and organization_inventory_id = $3
          and is_visible = false and is_active = false and deleted_at is null`,
      [organizationId, entry.branchId, entry.organizationInventoryId])
    assert(result.rowCount === 1,
      `row ${entry.branchName} / oi#${entry.organizationInventoryId} moved since the plan was built; re-run the dry run`)
    counts.shownAgain += 1
  }
  for (const entry of reversal.deactivations) {
    const result = await client.query(
      `update organization_inventory set is_active = false, updated_at = now()
        where id = $1 and organization_id = $2 and is_active = true and deleted_at is null`,
      [entry.organizationInventoryId, organizationId])
    assert(result.rowCount === 1,
      `entry ${entry.organizationInventoryId} ("${entry.normalizedName}") moved since the plan was built; re-run the dry run`)
    await client.query(
      `insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
       values ($1, $2, 'UPDATE', 'OrganizationAssignment', $3, $4::jsonb)`,
      [actorUserId, organizationId, String(entry.organizationInventoryId),
        JSON.stringify({ updateData: { isActive: false }, performedByRole: "SUPER_ADMIN", importer: `${IMPORTER}:reverse` })])
    counts.switchedOff += 1
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
    const digest = sha256(groupCatalogueReversalLines(reversal).join("\n"))
    const nothingToDo = reversal.deletes.length + reversal.restores.length + reversal.unhides.length + reversal.deactivations.length === 0

    printReversal(options.reversePath, report, reversal)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: `${IMPORTER}:reverse`,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: report.organization,
      source: { report: options.reversePath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
      planDigest: digest,
      counts: {
        deletes: reversal.deletes.length,
        restores: reversal.restores.length,
        unhides: reversal.unhides.length,
        deactivations: reversal.deactivations.length,
        skipped: reversal.skipped.length,
      },
      reversal,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to reverse: every row the run wrote is already back, or has been changed since (see SKIP lines).")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run assign:ke-group-catalogue -- --reverse="${options.reversePath}" --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(report.organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    assert(!nothingToDo, "Nothing to reverse")
    assert(options.confirmOrganization === organizationConfirmation(report.organization),
      `Commit requires --confirm-organization=${organizationConfirmation(report.organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const branchIds = [...new Set([...report.plan.assignments, ...report.plan.hides].map((entry) => entry.branchId))]
    const before = await fingerprints(pool, report.organization.id, branchIds)
    const client = await pool.connect()
    try {
      await client.query("begin")
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      const lockedReversal = await buildReversal(client, report)
      assert(sha256(groupCatalogueReversalLines(lockedReversal).join("\n")) === digest,
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

    const after = await fingerprints(pool, report.organization.id, branchIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildReversal(pool, report)
    const pending = remaining.deletes.length + remaining.restores.length + remaining.unhides.length + remaining.deactivations.length
    assert(pending === 0, `${pending} change(s) still pending after commit; investigate immediately`)
    console.log("Verified: other tenants and other branches untouched; a further reversal plans nothing.")

    writeReport(options.outputPath, { ...payload, committedAt: new Date().toISOString() })
    for (const entry of await invalidateCachePrefixes(["branch-inv", "analytics"])) {
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

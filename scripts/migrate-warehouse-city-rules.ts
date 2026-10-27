#!/usr/bin/env tsx
/**
 * Move warehouse accounts onto Apricart warehouses without changing what any
 * of them sees. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
 *
 * Super Admin names a warehouse for each account (`--map=<username>=<CODE>`).
 * For each mapped account, every (city, organization) pair it holds becomes an
 * organization-and-city rule on that warehouse, every single-branch assignment
 * a manual route, and the account an operator of the warehouse with all its
 * branches. The planning is pure and unit-tested (`planCityRuleMigration` in
 * `lib/apricart-warehouses.ts`); it refuses rather than guesses.
 *
 * Nothing this writes changes what anyone sees while `WAREHOUSE_ORDER_OWNERSHIP`
 * is "branch": rules and membership are read only in the membership modes. And
 * the commit proves it would not change anything in those modes either: inside
 * the writing transaction, after the rows are in, it runs the application's own
 * ownership check (`runWarehouseOwnershipCheck`, the reach loader itself in each
 * mode) and rolls back unless no account would lose or gain a single branch.
 *
 *   npm run migrate:warehouse-city-rules -- --map=sheikh.murtaza=KARACHI-001 --map=sohail=LAHORE-001
 *   npm run migrate:warehouse-city-rules -- --map=... --commit --confirm-plan-sha256=<digest> --operator=<you>
 *   npm run migrate:warehouse-city-rules -- --rollback=<committed report>.json --confirm-rollback=<printed>
 *
 * Writes only `warehouse_route_rules`, `branch_fulfillment_routes`,
 * `apricart_warehouse_memberships` and one `audit_logs` row. Never touches an
 * order, a branch, an account, or an account's own assignments, which stay in
 * force until phase 2d retires them.
 *
 * Reads DATABASE_URL (the shell's, else .env.local's). The host is printed first.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"

import {
  apricartWarehouseMemberBranches,
  apricartWarehouseMemberships,
  apricartWarehouses,
  auditLogs,
  branchFulfillmentRoutes,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
  warehouseRouteRules,
} from "../db/schema"
import {
  planCityRuleMigration,
  type CityRuleMigrationInput,
  type CityRuleMigrationPlan,
} from "../lib/apricart-warehouses"
import { compareCodeUnits } from "../lib/code-unit-order"
import { WAREHOUSE_ROLE } from "../lib/warehouse-access"

/** Serializes this script with itself; unique among the repository's script locks. */
const ADVISORY_LOCK = 700031
const AUDIT_ACTION = "WAREHOUSE_CITY_RULES_MIGRATION"
const ROLLBACK_AUDIT_ACTION = "WAREHOUSE_CITY_RULES_MIGRATION_ROLLBACK"
const REPORT_KIND = "WAREHOUSE_CITY_RULES_MIGRATION"

type DbCli = typeof import("../lib/db-cli")
type Db = DbCli["db"]
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
type Client = Db | Tx

type Mapping = Array<{ username: string; code: string }>

interface CommitReport {
  kind: typeof REPORT_KIND
  mode: "COMMITTED"
  planSha256: string
  auditLogId: number
  inserted: {
    rules: Array<{ id: number; warehouseId: number; organizationId: number; cityKey: string }>
    routes: Array<{ branchId: number; warehouseId: number }>
    memberships: Array<{ id: number; warehouseId: number; userId: string }>
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function arg(name: string): string | undefined {
  const flag = `--${name}=`
  return process.argv.find((value) => value.startsWith(flag))?.slice(flag.length)
}

const flag = (name: string) => process.argv.includes(`--${name}`)
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

const planDigest = (plan: CityRuleMigrationPlan) =>
  sha256(canonical({ rules: plan.rules, routes: plan.routes, memberships: plan.memberships }))

function saveJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 })
}

function parseMapping(): Mapping {
  const entries = process.argv
    .filter((value) => value.startsWith("--map="))
    .map((value) => value.slice("--map=".length))
  return entries.map((entry) => {
    const separator = entry.lastIndexOf("=")
    assert(separator > 0 && separator < entry.length - 1, `--map must be <username>=<WAREHOUSE-CODE>, not ${entry}`)
    return { username: entry.slice(0, separator).trim(), code: entry.slice(separator + 1).trim().toUpperCase() }
  })
}

/** Every warehouse account and warehouse, and what already exists — read through `client`. */
async function readState(client: Client, mapping: Mapping): Promise<{ input: CityRuleMigrationInput; codes: Map<number, string> }> {
  const warehouses = await client
    .select({ id: apricartWarehouses.id, code: apricartWarehouses.code, status: apricartWarehouses.status })
    .from(apricartWarehouses)
    .orderBy(asc(apricartWarehouses.id))
  const idByCode = new Map(warehouses.map((warehouse) => [warehouse.code, warehouse.id]))
  for (const entry of mapping) assert(idByCode.has(entry.code), `No warehouse has the code ${entry.code}`)

  const accounts = await client
    .select({ id: users.id, username: users.username, isActive: users.isActive })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.name, WAREHOUSE_ROLE), isNull(users.deletedAt)))
    .orderBy(asc(users.id))
  // One query at a time: inside the commit this runs on a single transaction client.
  const accountIds = accounts.map((account) => account.id)
  const cities = accountIds.length === 0 ? [] : await client
    .select({ userId: warehouseCityAssignments.userId, cityKey: warehouseCityAssignments.cityKey })
    .from(warehouseCityAssignments).where(inArray(warehouseCityAssignments.userId, accountIds))
  const organizations = accountIds.length === 0 ? [] : await client
    .select({ userId: warehouseCityOrganizations.userId, organizationId: warehouseCityOrganizations.organizationId })
    .from(warehouseCityOrganizations).where(inArray(warehouseCityOrganizations.userId, accountIds))
  const branches = accountIds.length === 0 ? [] : await client
    .select({ userId: warehouseAssignments.userId, branchId: warehouseAssignments.branchId })
    .from(warehouseAssignments).where(inArray(warehouseAssignments.userId, accountIds))

  const existingRules = await client
    .select({ warehouseId: warehouseRouteRules.warehouseId, organizationId: warehouseRouteRules.organizationId, cityKey: warehouseRouteRules.cityKey })
    .from(warehouseRouteRules)
  const existingRoutes = await client
    .select({ branchId: branchFulfillmentRoutes.branchId, warehouseId: branchFulfillmentRoutes.warehouseId })
    .from(branchFulfillmentRoutes)
  const existingMemberships = await client.select({
    warehouseId: apricartWarehouseMemberships.warehouseId,
    userId: apricartWarehouseMemberships.userId,
    responsibility: apricartWarehouseMemberships.responsibility,
    branchScope: apricartWarehouseMemberships.branchScope,
  }).from(apricartWarehouseMemberships)

  return {
    codes: new Map(warehouses.map((warehouse) => [warehouse.id, warehouse.code])),
    input: {
      accounts: accounts.map((account) => ({
        userId: account.id,
        username: account.username ?? account.id,
        isActive: account.isActive,
        cityKeys: cities.filter((row) => row.userId === account.id).map((row) => row.cityKey),
        organizationIds: organizations.filter((row) => row.userId === account.id).map((row) => row.organizationId),
        branchIds: branches.filter((row) => row.userId === account.id).map((row) => row.branchId),
      })),
      mapping: mapping.map((entry) => ({ username: entry.username, warehouseId: idByCode.get(entry.code) as number })),
      warehouses,
      existingRules,
      existingRoutes,
      existingMemberships,
    },
  }
}

function describe(plan: CityRuleMigrationPlan, codes: Map<number, string>, input: CityRuleMigrationInput) {
  const username = new Map(input.accounts.map((account) => [account.userId, account.username]))
  const code = (id: number) => codes.get(id) ?? `#${id}`
  const rulesByWarehouse = new Map<string, number>()
  for (const rule of plan.rules) rulesByWarehouse.set(code(rule.warehouseId), (rulesByWarehouse.get(code(rule.warehouseId)) ?? 0) + 1)
  return {
    rules: Object.fromEntries(rulesByWarehouse),
    routes: plan.routes.map((route) => `branch ${route.branchId} -> ${code(route.warehouseId)}`),
    memberships: plan.memberships.map((membership) => `${username.get(membership.userId) ?? membership.userId} -> ${code(membership.warehouseId)} (all branches)`),
  }
}

async function main(): Promise<void> {
  const { db, closePool } = await import("../lib/db-cli")
  const { databaseToolEnv } = await import("../lib/server/database-tool-env")
  console.log(`[migrate-warehouse-city-rules] database: ${new URL(databaseToolEnv.DATABASE_URL).host}`)
  try {
    const rollbackPath = arg("rollback")
    if (rollbackPath) {
      await rollback(db, resolve(process.cwd(), rollbackPath))
      return
    }

    const mapping = parseMapping()
    assert(mapping.length > 0, "Name at least one --map=<username>=<WAREHOUSE-CODE>")
    const output = resolve(process.cwd(),
      arg("output") ?? `updatedReports/warehouse-city-rules-${new Date().toISOString().slice(0, 10)}.json`)

    const { input, codes } = await readState(db, mapping)
    const plan = planCityRuleMigration(input)
    const digest = planDigest(plan)
    const summary = describe(plan, codes, input)
    const report = {
      kind: REPORT_KIND,
      mode: "DRY_RUN" as const,
      generatedAt: new Date().toISOString(),
      mapping,
      planSha256: digest,
      summary,
      plan,
    }

    if (plan.refusals.length > 0) {
      saveJson(output, report)
      console.log(JSON.stringify({ refusals: plan.refusals, output }, null, 2))
      console.log("\nRefused: nothing can be written until every refusal above is resolved.")
      process.exitCode = 1
      return
    }
    if (plan.rules.length + plan.routes.length + plan.memberships.length === 0) {
      console.log("Nothing to do: every mapped account's reach is already configured on its warehouse.")
      return
    }

    if (!flag("commit")) {
      saveJson(output, report)
      console.log(JSON.stringify({ mode: "DRY_RUN", output, planSha256: digest, summary }, null, 2))
      console.log("\nDry run: nothing was written. To apply exactly this plan:")
      console.log(`  npm run migrate:warehouse-city-rules -- ${mapping.map((entry) => `--map=${entry.username}=${entry.code}`).join(" ")} \\`)
      console.log(`    --commit --confirm-plan-sha256=${digest} --operator=<you@example.com>`)
      return
    }

    const operator = arg("operator")
    assert(operator, "Commit requires --operator=<who is running this>")
    assert(arg("confirm-plan-sha256") === digest, `Commit requires --confirm-plan-sha256=${digest}`)

    const { runWarehouseOwnershipCheck } = await import("../lib/server/warehouse-ownership-check")
    const committed = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`)
      // Super Admin's rule, route and member writes take these FOR UPDATE too.
      await tx.select({ id: apricartWarehouses.id }).from(apricartWarehouses).orderBy(asc(apricartWarehouses.id)).for("update")

      // Rebuild from rows read under the locks; anything that moved since the
      // dry run changes the digest and nothing is written.
      const locked = await readState(tx, mapping)
      const lockedPlan = planCityRuleMigration(locked.input)
      assert(lockedPlan.refusals.length === 0, `Refused under the lock: ${lockedPlan.refusals.join("; ")}`)
      assert(planDigest(lockedPlan) === digest, "Warehouse accounts or configuration changed after the dry run; aborting")

      const rules = lockedPlan.rules.length === 0 ? [] : await tx.insert(warehouseRouteRules)
        .values(lockedPlan.rules.map((rule) => ({ ...rule, createdByUserId: null })))
        .returning({ id: warehouseRouteRules.id, warehouseId: warehouseRouteRules.warehouseId, organizationId: warehouseRouteRules.organizationId, cityKey: warehouseRouteRules.cityKey })
      const routes = lockedPlan.routes.length === 0 ? [] : await tx.insert(branchFulfillmentRoutes)
        .values(lockedPlan.routes.map((route) => ({ ...route, createdByUserId: null, updatedByUserId: null })))
        .returning({ branchId: branchFulfillmentRoutes.branchId, warehouseId: branchFulfillmentRoutes.warehouseId })
      const memberships = lockedPlan.memberships.length === 0 ? [] : await tx.insert(apricartWarehouseMemberships)
        .values(lockedPlan.memberships.map((membership) => ({
          ...membership,
          responsibility: "WAREHOUSE_OPERATOR",
          branchScope: "ALL",
          createdByUserId: null,
        })))
        .returning({ id: apricartWarehouseMemberships.id, warehouseId: apricartWarehouseMemberships.warehouseId, userId: apricartWarehouseMemberships.userId })

      // The proof: with these rows in place, the application's reach loader
      // gives every warehouse account exactly the branches it has today, in
      // both membership modes. Otherwise the transaction rolls back.
      const check = await runWarehouseOwnershipCheck(tx)
      const changed = [...check.differences["membership-fallback"], ...check.differences.membership]
      assert(changed.length === 0, `Would change what an account sees, so nothing was written: ${JSON.stringify(changed).slice(0, 2000)}`)
      assert(check.strandedBranches.length === 0, `Would leave branches no operator works: ${JSON.stringify(check.strandedBranches)}`)

      const [audit] = await tx.insert(auditLogs).values({
        userId: null,
        organizationId: null,
        branchId: null,
        action: AUDIT_ACTION,
        entity: "apricart_warehouse",
        entityId: digest.slice(0, 128),
        metadata: {
          planSha256: digest,
          operator,
          mapping,
          summary,
          inserted: { rules: rules.length, routes: routes.length, memberships: memberships.length },
          parity: { accounts: check.accounts, unroutedOpenOrders: check.unroutedOpenOrders },
        },
      }).returning({ id: auditLogs.id })
      assert(audit?.id, "Failed to write the audit row")
      return {
        auditLogId: audit.id,
        inserted: {
          rules: rules.map((rule) => ({ ...rule, cityKey: rule.cityKey as string })),
          routes,
          memberships,
        },
        check,
      }
    })

    const rollbackConfirmation = `ROLLBACK:${committed.auditLogId}:${REPORT_KIND}`
    saveJson(output, {
      ...report,
      mode: "COMMITTED",
      committedAt: new Date().toISOString(),
      operator,
      auditLogId: committed.auditLogId,
      inserted: committed.inserted,
      check: committed.check,
      rollbackConfirmation,
    })
    console.log(JSON.stringify({
      mode: "COMMITTED",
      output,
      auditLogId: committed.auditLogId,
      inserted: {
        rules: committed.inserted.rules.length,
        routes: committed.inserted.routes.length,
        memberships: committed.inserted.memberships.length,
      },
      parity: "no warehouse account's branches change in either membership mode",
      unroutedOpenOrders: committed.check.unroutedOpenOrders,
      rollbackConfirmation,
    }, null, 2))
  } finally {
    await closePool()
  }
}

/**
 * Remove exactly the rows a committed run inserted, if they are still as it
 * left them. A rule moved to another warehouse, a route changed, or a
 * membership whose scope Super Admin has since narrowed is refused, not
 * overwritten.
 */
async function rollback(db: Db, reportPath: string): Promise<void> {
  assert(existsSync(reportPath), `Commit report not found: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as CommitReport
  assert(report.kind === REPORT_KIND && report.mode === "COMMITTED", "Not a committed warehouse-city-rules report")
  const expected = `ROLLBACK:${report.auditLogId}:${REPORT_KIND}`
  assert(arg("confirm-rollback") === expected, `--confirm-rollback must equal ${expected}`)

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`)
    await tx.select({ id: apricartWarehouses.id }).from(apricartWarehouses).orderBy(asc(apricartWarehouses.id)).for("update")

    for (const membership of report.inserted.memberships) {
      const [row] = await tx
        .select({ branchScope: apricartWarehouseMemberships.branchScope })
        .from(apricartWarehouseMemberships)
        .where(and(
          eq(apricartWarehouseMemberships.id, membership.id),
          eq(apricartWarehouseMemberships.warehouseId, membership.warehouseId),
          eq(apricartWarehouseMemberships.userId, membership.userId),
        ))
      if (!row) continue
      const selections = await tx.select({ id: apricartWarehouseMemberBranches.id })
        .from(apricartWarehouseMemberBranches)
        .where(eq(apricartWarehouseMemberBranches.membershipId, membership.id))
      assert(row.branchScope === "ALL" && selections.length === 0,
        `Membership ${membership.id} was narrowed after the migration; rollback refused`)
      await tx.delete(apricartWarehouseMemberships).where(eq(apricartWarehouseMemberships.id, membership.id))
    }
    for (const rule of report.inserted.rules) {
      const removed = await tx.delete(warehouseRouteRules).where(and(
        eq(warehouseRouteRules.id, rule.id),
        eq(warehouseRouteRules.warehouseId, rule.warehouseId),
        eq(warehouseRouteRules.organizationId, rule.organizationId),
        eq(warehouseRouteRules.cityKey, rule.cityKey),
      )).returning({ id: warehouseRouteRules.id })
      assert(removed.length === 1, `Rule ${rule.id} changed after the migration; rollback refused`)
    }
    for (const route of report.inserted.routes) {
      const removed = await tx.delete(branchFulfillmentRoutes).where(and(
        eq(branchFulfillmentRoutes.branchId, route.branchId),
        eq(branchFulfillmentRoutes.warehouseId, route.warehouseId),
      )).returning({ branchId: branchFulfillmentRoutes.branchId })
      assert(removed.length === 1, `The route of branch ${route.branchId} changed after the migration; rollback refused`)
    }
    await tx.insert(auditLogs).values({
      userId: null,
      organizationId: null,
      branchId: null,
      action: ROLLBACK_AUDIT_ACTION,
      entity: "apricart_warehouse",
      entityId: String(report.auditLogId),
      metadata: {
        planSha256: report.planSha256,
        removed: {
          rules: report.inserted.rules.length,
          routes: report.inserted.routes.length,
          memberships: report.inserted.memberships.length,
        },
      },
    })
  })
  console.log(JSON.stringify({
    mode: "ROLLED_BACK",
    rules: report.inserted.rules.length,
    routes: report.inserted.routes.length,
    memberships: report.inserted.memberships.length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

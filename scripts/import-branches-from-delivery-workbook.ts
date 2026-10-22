#!/usr/bin/env tsx
/**
 * Create the branches proposed in the reviewed delivery-address workbook
 * (outputs/delivery-address-branch-audit/Delivery_Address_Branches_Final_2026-10-22.xlsx,
 * sheet "Proposed Branches", rows with Status "Ready").
 *
 * Safety properties:
 * - production only, loaded from `.env.prod.local` and checked by the
 *   migration target guard;
 * - default mode is read-only and prints a digest-bound plan;
 * - only organizations created by the 2026-10-21 Customer List import (their
 *   CREATE_ORGANIZATION audit row says so) may receive a branch; any other
 *   organization in the workbook refuses the whole plan, and the tenants that
 *   existed before (K-Electric, UBL, EFU, International Packaging, …) can never
 *   qualify;
 * - every field is held to the rules POST /api/v1/branches applies, and the
 *   phone to lib/branch-contact-phone.ts; a name already used in the
 *   organization refuses the plan;
 * - the commit takes the application's own per-organization branch-creation
 *   advisory lock, rebuilds the plan under it, and must reproduce the dry run's
 *   digest; one serializable transaction, so any failure creates nothing;
 * - each branch gets the `{ORG_CODE}-NN` code the application would give it and
 *   a CREATE_BRANCH audit row; hierarchy and region are left to their defaults;
 * - `--rehearse` runs the whole commit and rolls it back;
 * - `--rollback=<report>` deactivates (never deletes: audit rows reference the
 *   branch) only branches created by that report that nothing has touched since.
 *
 *   npx tsx scripts/import-branches-from-delivery-workbook.ts
 *   npx tsx scripts/import-branches-from-delivery-workbook.ts --rehearse
 *   npx tsx scripts/import-branches-from-delivery-workbook.ts --commit --confirm-plan=<digest> --operator=<name>
 *   npx tsx scripts/import-branches-from-delivery-workbook.ts --rollback=<report.json> [--commit --confirm-rollback=<digest> --operator=<name>]
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, resolve } from "node:path"

import { Client } from "pg"
import * as XLSX from "xlsx"

import { isValidBranchContactPhone, normalizeBranchContactPhone } from "../lib/branch-contact-phone"
import { invalidateCachePrefixes } from "../lib/cache-cli"
import {
  assertTargetMatchesEnvironment,
  describeMigrationTarget,
  migrationSslFor,
  selectMigrationUrl,
} from "../lib/migration-target"
import { readMigrationEnvFor } from "../lib/server/migration-env"

const DEFAULT_WORKBOOK = "outputs/delivery-address-branch-audit/Delivery_Address_Branches_Final_2026-10-22.xlsx"
const SHEET = "Proposed Branches"
const ORGANIZATION_SOURCE = "Customer List.xlsx"
// Tenants that existed before the Customer List import. Belt and braces: the
// audit-row rule below already excludes them.
const NEVER_TOUCH = new Set([2, 5, 6, 7, 8, 9, 10, 11])

type SheetRow = {
  sourceRows: string; orgId: number; orgCode: string; name: string
  province: string | null; city: string | null; address: string; contactPhone: string | null
}
type PlannedBranch = SheetRow & { code: string }
type Plan = { target: string; workbook: string; workbookSha256: string; branches: PlannedBranch[] }
type Db = Client

const argument = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const flag = (name: string) => process.argv.includes(`--${name}`)
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const digestOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
const nameKey = (name: string) => name.trim().toLowerCase()

function readSheet(path: string): { rows: SheetRow[]; sha256: string } {
  const buffer = readFileSync(path)
  const workbook = XLSX.read(buffer)
  const sheet = workbook.Sheets[SHEET]
  assert(sheet, `sheet '${SHEET}' not found in ${path}`)
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false, defval: "" })
  const text = (value: unknown) => String(value ?? "").trim()
  const rows = raw.filter((row) => text(row.Status) === "Ready").map((row): SheetRow => {
    const city = text(row.City)
    const province = text(row.Province)
    const phone = normalizeBranchContactPhone(text(row.Phone))
    return {
      sourceRows: text(row["Source Rows"]),
      orgId: Number(text(row["Org ID"])),
      orgCode: text(row["Org Code"]),
      name: text(row["Proposed Branch Name"]),
      province: province || null,
      city: city || null,
      address: text(row["Proposed Address"]),
      contactPhone: phone || null,
    }
  })
  const notReady = raw.length - rows.length
  assert(notReady === 0, `${notReady} row(s) are not Ready; the workbook must be fully reviewed`)
  return { rows, sha256: createHash("sha256").update(buffer).digest("hex") }
}

function fieldErrors(row: SheetRow): string[] {
  const errors: string[] = []
  const at = `row ${row.sourceRows} '${row.name}'`
  if (!Number.isSafeInteger(row.orgId) || row.orgId <= 0) errors.push(`${at}: bad organization id`)
  if (row.name.length < 2 || row.name.length > 100) errors.push(`${at}: name must be 2-100 characters`)
  if (row.address.length < 5 || row.address.length > 500) errors.push(`${at}: address must be 5-500 characters`)
  if ((row.city === null) !== (row.province === null)) errors.push(`${at}: city and province must be both set or both empty`)
  for (const [label, value] of [["city", row.city], ["province", row.province]] as const) {
    if (value !== null && (value.length < 2 || value.length > 100)) errors.push(`${at}: ${label} must be 2-100 characters`)
  }
  if (row.contactPhone !== null && !isValidBranchContactPhone(row.contactPhone)) errors.push(`${at}: invalid phone '${row.contactPhone}'`)
  return errors
}

/** The plan, built from the workbook and the database as it is now. */
async function buildPlan(db: Db, target: string, workbookPath: string): Promise<Plan> {
  const { rows, sha256 } = readSheet(workbookPath)
  assert(rows.length > 0, "no Ready rows in the workbook")
  const errors = rows.flatMap(fieldErrors)

  const orgIds = [...new Set(rows.map((row) => row.orgId))].sort((a, b) => a - b)
  const organizations = new Map((await db.query(
    `SELECT o.id, o.name, o.code, o.status,
            EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'CREATE_ORGANIZATION' AND a.organization_id = o.id
                      AND a.metadata->>'source' = $2) AS from_customer_list
     FROM organizations o WHERE o.id = ANY($1::int[])`,
    [orgIds, ORGANIZATION_SOURCE],
  )).rows.map((row) => [Number(row.id), row]))

  for (const orgId of orgIds) {
    const org = organizations.get(orgId)
    if (!org) { errors.push(`organization ${orgId} does not exist`); continue }
    if (NEVER_TOUCH.has(orgId)) errors.push(`organization ${orgId} '${org.name}' existed before the import: never touched`)
    if (!org.from_customer_list) errors.push(`organization ${orgId} '${org.name}' was not created by the ${ORGANIZATION_SOURCE} import`)
    if (org.status !== "active") errors.push(`organization ${orgId} '${org.name}' is ${org.status}`)
    for (const row of rows.filter((r) => r.orgId === orgId)) {
      if (row.orgCode !== org.code) errors.push(`row ${row.sourceRows}: org code ${row.orgCode} is not ${orgId}'s code ${org.code}`)
    }
  }

  const existing = (await db.query(
    "SELECT organization_id, lower(btrim(name)) AS key, code FROM branches WHERE organization_id = ANY($1::int[])",
    [orgIds],
  )).rows
  const taken = new Set(existing.map((row) => `${row.organization_id}|${row.key}`))
  const takenCodes = new Set(existing.map((row) => `${row.organization_id}|${row.code}`))
  const seen = new Set<string>()
  for (const row of rows) {
    const key = `${row.orgId}|${nameKey(row.name)}`
    if (taken.has(key)) errors.push(`row ${row.sourceRows}: '${row.name}' already exists in organization ${row.orgId}`)
    if (seen.has(key)) errors.push(`row ${row.sourceRows}: '${row.name}' appears twice for organization ${row.orgId}`)
    seen.add(key)
  }
  assert(errors.length === 0, `plan refused:\n  ${errors.join("\n  ")}`)

  // The code createBranchInTx gives: {ORG_CODE}-{count+1}, two digits minimum.
  const counts = new Map<number, number>()
  for (const row of existing) counts.set(row.organization_id, (counts.get(row.organization_id) ?? 0) + 1)
  const branches = rows.map((row): PlannedBranch => {
    const next = (counts.get(row.orgId) ?? 0) + 1
    counts.set(row.orgId, next)
    const code = `${row.orgCode}-${String(next).padStart(2, "0")}`
    assert(!takenCodes.has(`${row.orgId}|${code}`), `code ${code} is already used in organization ${row.orgId}`)
    return { ...row, code }
  })
  return { target, workbook: basename(workbookPath), workbookSha256: sha256, branches }
}

function summarize(plan: Plan): void {
  const byOrg = new Map<string, number>()
  for (const b of plan.branches) byOrg.set(`${b.orgId} ${b.orgCode}`, (byOrg.get(`${b.orgId} ${b.orgCode}`) ?? 0) + 1)
  console.log(`target   ${plan.target}`)
  console.log(`workbook ${plan.workbook} sha256 ${plan.workbookSha256.slice(0, 16)}…`)
  console.log(`branches ${plan.branches.length}, by organization: ${[...byOrg].map(([k, n]) => `${k}=${n}`).join(", ")}`)
  console.log(`with phone ${plan.branches.filter((b) => b.contactPhone).length}, without city ${plan.branches.filter((b) => !b.city).length}`)
  console.log(`first/last codes: ${plan.branches[0].code} … ${plan.branches[plan.branches.length - 1].code}`)
}

/** Inserts the plan inside the caller's transaction; returns the created rows. */
async function applyPlan(db: Db, plan: Plan, planDigest: string, operator: string) {
  const created: Array<{ id: number; orgId: number; code: string; name: string; sourceRows: string }> = []
  for (const b of plan.branches) {
    const inserted = (await db.query(
      `INSERT INTO branches (organization_id, name, province, city, address, cost_center_id, code, status, region, head_count, contact_phone)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, 'active', NULL, NULL, $7)
       RETURNING id, created_at`,
      [b.orgId, b.name, b.province, b.city, b.address, b.code, b.contactPhone],
    )).rows[0]
    await db.query(
      `INSERT INTO audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata, created_at)
       VALUES (NULL, $1, $2, 'CREATE_BRANCH', 'BRANCH', $3, $4::jsonb, now())`,
      [b.orgId, inserted.id, String(inserted.id), JSON.stringify({
        performedByRole: "SCRIPT", source: "Delivery Addresses (1).xlsx", workbook: plan.workbook,
        workbookSha256: plan.workbookSha256, sourceRows: b.sourceRows, planSha256: planDigest, operator,
        name: b.name, code: b.code, status: "active", contactPhone: b.contactPhone, hierarchyRole: "STANDALONE",
      })],
    )
    created.push({ id: Number(inserted.id), orgId: b.orgId, code: b.code, name: b.name, sourceRows: b.sourceRows })
  }
  // Verify inside the transaction: exactly the planned rows, nothing else.
  const counted = (await db.query(
    "SELECT organization_id, count(*)::int AS n FROM branches WHERE id = ANY($1::int[]) GROUP BY 1",
    [created.map((c) => c.id)],
  )).rows
  assert(counted.reduce((sum, row) => sum + row.n, 0) === plan.branches.length, "post-insert count does not match the plan")
  return created
}

async function lockOrganizations(db: Db, orgIds: number[]): Promise<void> {
  // The application's own key (lib/server/branch-creation.ts), in id order.
  for (const orgId of [...orgIds].sort((a, b) => a - b)) {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('oneflowe:branch-creation'), $1::integer)", [orgId])
  }
}

async function runImport(db: Db, target: string): Promise<void> {
  const workbookPath = resolve(argument("file") ?? DEFAULT_WORKBOOK)
  assert(existsSync(workbookPath), `workbook not found: ${workbookPath}`)

  await db.query("BEGIN READ ONLY")
  const dryPlan = await buildPlan(db, target, workbookPath)
  await db.query("ROLLBACK")
  const digest = digestOf(dryPlan)
  summarize(dryPlan)

  const rehearse = flag("rehearse")
  if (!flag("commit") && !rehearse) {
    console.log(`\nDRY RUN — nothing written. Rehearse (writes then rolls back):\n  npx tsx scripts/import-branches-from-delivery-workbook.ts --rehearse`)
    console.log(`Commit:\n  npx tsx scripts/import-branches-from-delivery-workbook.ts --commit --confirm-plan=${digest} --operator=<name>`)
    return
  }
  const operator = rehearse ? "rehearsal" : argument("operator")
  assert(operator, "--operator=<name> is required")
  if (!rehearse) assert(argument("confirm-plan") === digest, `--confirm-plan must equal the current plan digest ${digest}`)

  await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
  try {
    await db.query("SET LOCAL lock_timeout = '10s'")
    await lockOrganizations(db, [...new Set(dryPlan.branches.map((b) => b.orgId))])
    const plan = await buildPlan(db, target, workbookPath)
    assert(digestOf(plan) === digest, "the plan changed between the dry run and the lock; nothing written")
    const created = await applyPlan(db, plan, digest, operator)
    if (rehearse) {
      await db.query("ROLLBACK")
      console.log(`\nREHEARSAL OK: ${created.length} branches inserted, audited and verified, then rolled back.`)
      console.log(`Commit:\n  npx tsx scripts/import-branches-from-delivery-workbook.ts --commit --confirm-plan=${digest} --operator=<name>`)
      return
    }
    await db.query("COMMIT")
    const rollbackDigest = digestOf({ kind: "rollback", planSha256: digest, ids: created.map((c) => c.id) })
    mkdirSync("updatedReports", { recursive: true })
    const reportPath = `updatedReports/delivery-branches-commit-${digest}.json`
    writeFileSync(reportPath, `${JSON.stringify({
      kind: "delivery-branch-import", committedAt: new Date().toISOString(), target, operator,
      workbook: plan.workbook, workbookSha256: plan.workbookSha256, planSha256: digest, rollbackDigest, created,
    }, null, 2)}\n`, { flag: "wx" })
    console.log(`\nCOMMITTED ${created.length} branches. Report: ${reportPath}`)
    console.log(JSON.stringify(await invalidateCachePrefixes(["branches"])))
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function runRollback(db: Db, reportPath: string): Promise<void> {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    kind: string; planSha256: string; rollbackDigest: string; created: Array<{ id: number; orgId: number; code: string }>
  }
  assert(report.kind === "delivery-branch-import", "not a delivery-branch-import report")
  const ids = report.created.map((c) => c.id)
  const plan = async () => (await db.query(
    `SELECT b.id, b.organization_id, b.code, b.status, b.updated_at = b.created_at AS untouched,
            EXISTS (SELECT 1 FROM users u WHERE u.branch_id = b.id) AS has_users,
            EXISTS (SELECT 1 FROM orders o WHERE o.branch_id = b.id) AS has_orders
     FROM branches b WHERE b.id = ANY($1::int[]) ORDER BY b.id`,
    [ids],
  )).rows
  await db.query("BEGIN READ ONLY")
  const rows = await plan()
  await db.query("ROLLBACK")
  const deactivate = rows.filter((r) => r.status === "active" && r.untouched && !r.has_users && !r.has_orders)
  const leave = rows.filter((r) => !deactivate.includes(r))
  const digest = digestOf({ kind: "rollback-run", rollbackDigest: report.rollbackDigest, ids: deactivate.map((r) => r.id) })
  console.log(`report ${reportPath}: ${ids.length} created, ${deactivate.length} would be deactivated, ${leave.length} left alone (touched, in use, or already inactive)`)
  if (!flag("commit")) {
    console.log(`DRY RUN. Apply: --rollback=${reportPath} --commit --confirm-rollback=${digest} --operator=<name>`)
    return
  }
  assert(argument("confirm-rollback") === digest, `--confirm-rollback must equal ${digest}`)
  const operator = argument("operator")
  assert(operator, "--operator=<name> is required")
  await db.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
  try {
    const now = await plan()
    const again = now.filter((r) => r.status === "active" && r.untouched && !r.has_users && !r.has_orders)
    assert(digestOf({ kind: "rollback-run", rollbackDigest: report.rollbackDigest, ids: again.map((r) => r.id) }) === digest, "rollback plan changed; nothing written")
    for (const r of again) {
      await db.query("UPDATE branches SET status = 'inactive', updated_at = now() WHERE id = $1", [r.id])
      await db.query(
        `INSERT INTO audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata, created_at)
         VALUES (NULL, $1, $2, 'DEACTIVATE_BRANCH', 'BRANCH', $3, $4::jsonb, now())`,
        [r.organization_id, r.id, String(r.id), JSON.stringify({ source: "delivery-branch-import rollback", planSha256: report.planSha256, operator })],
      )
    }
    await db.query("COMMIT")
    console.log(`deactivated ${again.length} branches`)
    console.log(JSON.stringify(await invalidateCachePrefixes(["branches"])))
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

async function main(): Promise<void> {
  const { env } = readMigrationEnvFor("production")
  const selected = selectMigrationUrl("production", env)
  assertTargetMatchesEnvironment("production", selected.url)
  const db = new Client({ connectionString: selected.url, ssl: migrationSslFor("production", selected.url) })
  await db.connect()
  try {
    const target = describeMigrationTarget(selected.url)
    const columns = (await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'branches' AND column_name = 'contact_phone'",
    )).rows
    assert(columns.length === 1, "branches.contact_phone is missing: apply migration 20261030120000 first")
    const rollback = argument("rollback")
    if (rollback) await runRollback(db, rollback)
    else await runImport(db, target)
  } finally {
    await db.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

#!/usr/bin/env tsx
/**
 * Force a tenant's mirrored accounts to set a new password on next sign-in.
 *
 *   npm run rotate:passwords                                          # dry run, K-Electric -ba/-op
 *   npm run rotate:passwords -- --usernames=<a>,<b>                   # pilot: only these accounts
 *   npm run rotate:passwords -- --roles=BRANCH_ADMIN,ORDER_PORTAL     # (the default population)
 *   npm run rotate:passwords -- --include-unroutable                  # flag accounts with no reachable email too
 *   npm run rotate:passwords -- --status                              # read-only: where the rotation stands
 *   npm run rotate:passwords -- --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=<id:code:name> \
 *     --confirm-plan=<digest printed by the dry run>
 *
 *   npm run rotate:passwords -- --reverse=<commit report>             # undo, dry run
 *   npm run rotate:passwords -- --reverse=<commit report> --commit ... # undo, gated the same way
 *
 * Flagging an account sets `must_change_password` and bumps `session_version`
 * — the flag alone never reaches a session that is already open. The person
 * then signs in with the old password, proves the mailbox on the account with
 * an emailed code, and sets a new password (`lib/server/password-change.ts`).
 * Passwords are never written here.
 *
 * The population is `--roles` × `--external-sources`, active, non-deleted, in
 * the organization `--organization-code` names — never retired holders, never
 * synthetic authors, never a portal-created account. An account whose address
 * cannot receive mail is listed and skipped unless told otherwise, because a
 * flagged account with no reachable address is a lockout. Every write is
 * pinned to the row as the plan saw it; the plan is rebuilt under the sync's
 * advisory lock and its digest must match; the run is recorded in
 * `legacy_import_batches` and one `system_logs` row per account; fingerprints
 * prove no row outside the plan moved. See
 * `lib/forced-password-rotation.ts` for the rules and
 * `plans/OF-KE-forced-password-rotation.md` for the whole change.
 */

import { existsSync, readFileSync } from "node:fs"
import * as dotenv from "dotenv"
import { z } from "zod"

import { deleteCacheKeys } from "../lib/cache-cli"
import { compareCodeUnits } from "../lib/code-unit-order"
import {
  forcedPasswordRotationPlanLines,
  forcedPasswordRotationReversalLines,
  planForcedPasswordRotation,
  planForcedPasswordRotationReversal,
  summarizeForcedPasswordRotation,
  summarizeRotationStatus,
  type ForcedPasswordRotationPlan,
  type ForcedPasswordRotationReversal,
  type RotationAccount,
} from "../lib/forced-password-rotation"
import {
  argument,
  assert,
  assertActor,
  assertOrganization,
  flag,
  organizationConfirmation,
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

const IMPORTER = "force-password-rotation"
const AUDIT_ACTION = "AUTH_PASSWORD_ROTATION_FORCED"
const AUDIT_REVERSE_ACTION = "AUTH_PASSWORD_ROTATION_REVERSED"
const DEFAULT_ORGANIZATION = { code: "0001", name: "K-Electric" } as const
const DEFAULT_ROLES = ["BRANCH_ADMIN", "ORDER_PORTAL"] as const
const DEFAULT_EXTERNAL_SOURCES = ["KE_LOGISTICS"] as const

interface Options {
  commit: boolean
  rollbackTest: boolean
  status: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  organizationCode: string
  organizationName: string
  roles: string[]
  externalSources: string[]
  usernames: string[]
  includeUnroutable: boolean
  since?: string
  reversePath?: string
  outputPath: string
}

/** The selection flags a commit must repeat so it plans the same rows the dry run did. */
function selectionArguments(options: Options): string {
  const parts: string[] = []
  if (options.organizationCode !== DEFAULT_ORGANIZATION.code) parts.push(`--organization-code=${options.organizationCode}`)
  if (options.organizationName !== DEFAULT_ORGANIZATION.name) parts.push(`--organization-name="${options.organizationName}"`)
  if (options.roles.join(",") !== DEFAULT_ROLES.join(",")) parts.push(`--roles=${options.roles.join(",")}`)
  if (options.externalSources.join(",") !== DEFAULT_EXTERNAL_SOURCES.join(",")) parts.push(`--external-sources=${options.externalSources.join(",")}`)
  if (options.usernames.length) parts.push(`--usernames="${options.usernames.join(",")}"`)
  if (options.includeUnroutable) parts.push("--include-unroutable")
  return parts.length ? ` ${parts.join(" ")}` : ""
}

function list(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  return parsed.length ? parsed : [...fallback]
}

function parseOptions(): Options {
  const reverse = argument("reverse")
  const date = new Date().toISOString().slice(0, 10)
  return {
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    status: flag("status"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    organizationCode: argument("organization-code") ?? DEFAULT_ORGANIZATION.code,
    organizationName: argument("organization-name") ?? DEFAULT_ORGANIZATION.name,
    roles: list(argument("roles"), DEFAULT_ROLES),
    externalSources: list(argument("external-sources"), DEFAULT_EXTERNAL_SOURCES),
    usernames: list(argument("usernames"), []),
    includeUnroutable: flag("include-unroutable"),
    since: argument("since"),
    reversePath: reverse ? resolveWorkspacePath(reverse) : undefined,
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/password-rotation-${reverse ? "reverse" : "apply"}-${date}.json`,
    ),
  }
}

// ============================================================
// Reads
// ============================================================

/** Every non-deleted account of the organization, whatever its role or source. */
async function readAccounts(client: QueryClient, organizationId: number): Promise<RotationAccount[]> {
  return (await rows(client,
    `select u.id, u.username, u.email, r.name as role, u.external_source, u.external_id,
            u.is_active, u.must_change_password, u.session_version, u.password_changed_at
       from users u join roles r on r.id = u.role_id
      where u.organization_id = $1 and u.deleted_at is null
      order by u.username, u.id`, [organizationId]))
    .map((row): RotationAccount => ({
      id: String(row.id),
      username: row.username === null ? null : String(row.username),
      email: String(row.email),
      role: String(row.role),
      externalSource: row.external_source === null ? null : String(row.external_source),
      externalId: row.external_id === null ? null : String(row.external_id),
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
      sessionVersion: Number(row.session_version),
      passwordChangedAt: row.password_changed_at === null ? null : new Date(String(row.password_changed_at)),
    }))
}

/**
 * Proof that nothing outside the plan moved: every other tenant's flags and
 * versions, and the organization's own rows the plan does not name.
 */
async function fingerprints(client: QueryClient, organizationId: number, plannedIds: readonly string[]): Promise<Row> {
  const [row] = await rows(client, `
    select
      (select count(*) from users where organization_id is distinct from $1)::bigint                                   as other_rows,
      (select count(*) from users where organization_id is distinct from $1 and must_change_password)::bigint          as other_flagged,
      (select coalesce(sum(session_version), 0) from users where organization_id is distinct from $1)::bigint          as other_versions,
      (select count(*) from users where organization_id = $1 and id <> all($2::uuid[]))::bigint                        as own_other_rows,
      (select count(*) from users where organization_id = $1 and id <> all($2::uuid[]) and must_change_password)::bigint
                                                                                                                       as own_other_flagged,
      (select coalesce(sum(session_version), 0) from users where organization_id = $1 and id <> all($2::uuid[]))::bigint
                                                                                                                       as own_other_versions,
      (select count(*) from users where organization_id = $1 and password_hash is not null)::bigint                    as own_hashes,
      (select md5(string_agg(password_hash, ',' order by id)) from users where organization_id = $1)                  as own_hash_digest
  `, [organizationId, plannedIds])
  return row
}

// ============================================================
// Forward run
// ============================================================

interface ForwardContext {
  organization: TargetOrganization
  options: Options
}

async function buildPlan(client: QueryClient, context: ForwardContext): Promise<ForcedPasswordRotationPlan> {
  return planForcedPasswordRotation(await readAccounts(client, context.organization.id), {
    roles: context.options.roles,
    externalSources: context.options.externalSources,
    usernames: context.options.usernames,
    includeUnroutable: context.options.includeUnroutable,
  })
}

/**
 * Said out loud on every run: `.env.local` is hand-switched between a local
 * copy and the live database, and a dry run against the wrong one reads as
 * plausible.
 */
function printDatabase(): void {
  try {
    console.log(`Database ............. ${new URL(String(process.env.DATABASE_URL)).host}`)
  } catch {
    console.log("Database ............. (DATABASE_URL is not a URL)")
  }
}

function printPlan(context: ForwardContext, plan: ForcedPasswordRotationPlan): void {
  const counts = summarizeForcedPasswordRotation(plan)
  printDatabase()
  console.log(`Organization ......... ${organizationConfirmation(context.organization)}`)
  console.log(`  roles .............. ${context.options.roles.join(", ")}`)
  console.log(`  external sources ... ${context.options.externalSources.join(", ")}`)
  if (context.options.usernames.length) console.log(`  pinned to .......... ${context.options.usernames.join(", ")}`)
  console.log("")
  console.log("ROTATION")
  console.log(`  flag ............... ${counts.targets} account(s)`)
  for (const [role, count] of Object.entries(counts.targetsByRole).sort(([left], [right]) => compareCodeUnits(left, right))) {
    console.log(`    ${role.padEnd(18, ".")} ${count}`)
  }
  console.log(`  shared email ....... ${counts.targetsWithSharedEmail} of them on an address another person also uses`)
  console.log(`  skipped ............ ${counts.skipped}`)
  for (const [reason, count] of Object.entries(counts.skippedByReason)) {
    if (count) console.log(`    ${reason.padEnd(18, ".")} ${count}`)
  }

  for (const target of plan.targets) {
    console.log(`    FLAG  ${target.username ?? target.id} (${target.role}, sv ${target.sessionVersion})${target.emailShared ? " [shared email]" : ""}${target.emailUnroutable ? " [UNROUTABLE EMAIL — will be locked out]" : ""}`)
  }
  for (const skip of plan.skipped) {
    console.log(`    SKIP  ${skip.reason} ${skip.username ?? skip.id ?? "?"}: ${skip.detail}`)
  }
  if (plan.sharedEmails.length) {
    console.log("")
    console.log(`SHARED ADDRESSES (${plan.sharedEmails.length}) — a code sent to one of these can be read by every person on it; send this list to the tenant`)
    for (const entry of plan.sharedEmails) {
      console.log(`    ${entry.email}: ${entry.people} people — ${entry.usernames.join(", ")}`)
    }
  }
}

/** Every statement pinned to what the plan saw, and must hit exactly one row. */
async function applyPlan(
  client: QueryClient,
  organizationId: number,
  plan: ForcedPasswordRotationPlan,
  actorUserId: string,
  batchId: string | null,
): Promise<{ flagged: number }> {
  let flagged = 0
  for (const target of plan.targets) {
    const result = await client.query(
      `update users
          set must_change_password = true,
              session_version = session_version + 1,
              updated_at = now()
        where id = $1 and organization_id = $2 and deleted_at is null and is_active
          and must_change_password = false and session_version = $3`,
      [target.id, organizationId, target.sessionVersion])
    assert(result.rowCount === 1, `account ${target.username ?? target.id} moved since the plan was built; re-run the dry run`)
    await client.query(
      `insert into system_logs (user_id, user_role, user_email, organization_id, action, resource_type, resource_id, details, success)
       values ($1, $2, $3, $4, $5, 'auth', $6, $7::jsonb, true)`,
      [target.id, target.role, target.email, organizationId, AUDIT_ACTION, target.username,
        JSON.stringify({
          importer: IMPORTER,
          batchId,
          actorUserId,
          sessionVersionBefore: target.sessionVersion,
          emailShared: target.emailShared,
          emailUnroutable: target.emailUnroutable,
        })])
    flagged += 1
  }
  return { flagged }
}

async function clearSessionCaches(userIds: readonly string[]): Promise<void> {
  // The session callback caches a positive validation per user for one TTL
  // window; without this the bumped version is not seen until it lapses.
  const result = await deleteCacheKeys(userIds.map((id) => `session-ok:${id}`))
  if (result.error) {
    console.warn(`WARNING: ${result.keysRequested} session cache entries were not cleared (${result.error}); open sessions end within the cache TTL instead of at once`)
  } else {
    console.log(`Cleared ${result.keysDeleted} cached session validation(s).`)
  }
}

async function runForward(options: Options): Promise<void> {
  const { pool } = await import("../lib/db-cli")

  try {
    const organization = await resolveOrganization(pool, options)
    const context: ForwardContext = { organization, options }
    const plan = await buildPlan(pool, context)
    const digest = sha256(forcedPasswordRotationPlanLines(plan).join("\n"))
    const counts = summarizeForcedPasswordRotation(plan)
    const nothingToDo = plan.targets.length === 0

    printPlan(context, plan)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: IMPORTER,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization,
      source: {
        roles: options.roles,
        externalSources: options.externalSources,
        usernames: options.usernames,
        includeUnroutable: options.includeUnroutable,
      },
      planDigest: digest,
      counts,
      plan,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to do: every selected account is already flagged, or was skipped (see SKIP lines).")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run rotate:passwords --${selectionArguments(options)} --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    assert(!nothingToDo, "Nothing to do")
    assert(options.confirmOrganization === organizationConfirmation(organization),
      `Commit requires --confirm-organization=${organizationConfirmation(organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const plannedIds = plan.targets.map((target) => target.id)
    const before = await fingerprints(pool, organization.id, plannedIds)
    const client = await pool.connect()
    let batchId: string | null = null
    try {
      await client.query("begin")
      // The same lock the sync takes, so the two can never interleave.
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // Rebuilt under the lock from rows read there. Anything that moved
      // between the dry run and now changes the digest, and nothing is written.
      const lockedPlan = await buildPlan(client, context)
      assert(sha256(forcedPasswordRotationPlanLines(lockedPlan).join("\n")) === digest,
        "Plan changed between confirmation and commit; re-run the dry run")

      if (options.commit) {
        const [batch] = await rows(client,
          `insert into legacy_import_batches
             (organization_id, source_system, source_manifest, status, imported_by_user_id)
           values ($1, $2, $3::jsonb, 'RUNNING', $4)
           returning id`,
          [
            organization.id,
            options.externalSources[0],
            JSON.stringify({
              importer: IMPORTER,
              planDigest: digest,
              source: payload.source,
              generatedAt: new Date().toISOString(),
            }),
            actorUserId,
          ])
        batchId = String(batch.id)
      }

      const applied = await applyPlan(client, organization.id, lockedPlan, actorUserId, batchId)

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

    // Committed. Prove nothing else moved and nothing remains, then drop the
    // cached session validations so the version bump bites at once.
    const after = await fingerprints(pool, organization.id, plannedIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildPlan(pool, context)
    assert(remaining.targets.length === 0,
      `${remaining.targets.length} account(s) still unflagged after commit; investigate immediately`)
    console.log("Verified: other tenants, other accounts and every password hash untouched; a further run plans nothing.")

    writeReport(options.outputPath, { ...payload, batchId, committedAt: new Date().toISOString() })
    await clearSessionCaches(plannedIds)
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

// ============================================================
// Reversal
// ============================================================

/** The commit report a run writes, validated before a reversal plans anything from it. */
const commitReportSchema = z.object({
  importer: z.literal(IMPORTER, { error: `the report must be from ${IMPORTER}` }),
  mode: z.literal("COMMIT", { error: "the report must be from a committed run, not a dry run" }),
  generatedAt: z.string(),
  planDigest: z.string().min(1),
  organization: z.object({ id: z.number().int().positive(), code: z.string().min(1), name: z.string().min(1) }),
  plan: z.object({
    targets: z.array(z.object({
      id: z.uuid(),
      username: z.string().nullable(),
      sessionVersion: z.number().int().nonnegative(),
    })),
  }),
})

type CommitReport = z.infer<typeof commitReportSchema>

function loadCommitReport(path: string): { report: CommitReport; sha256: string } {
  assert(existsSync(path), `Report not found: ${path}`)
  const buffer = readFileSync(path)
  const result = commitReportSchema.safeParse(JSON.parse(buffer.toString("utf8")))
  if (!result.success) throw new Error(`Not a committed password-rotation report:\n${z.prettifyError(result.error)}`)
  return { report: result.data, sha256: sha256(buffer) }
}

async function buildReversal(client: QueryClient, report: CommitReport): Promise<ForcedPasswordRotationReversal> {
  return planForcedPasswordRotationReversal(report.plan.targets, await readAccounts(client, report.organization.id))
}

function printReversal(reportPath: string, report: CommitReport, reversal: ForcedPasswordRotationReversal): void {
  printDatabase()
  console.log(`Report ............... ${reportPath}`)
  console.log(`  written ............ ${report.generatedAt}`)
  console.log(`  organization ....... ${organizationConfirmation(report.organization)}`)
  console.log(`  recorded ........... ${report.plan.targets.length} account(s) flagged`)
  console.log("")
  console.log("REVERSE")
  console.log(`  clear .............. ${reversal.clears.length} account(s) still exactly as the run left them`)
  console.log(`  skipped ............ ${reversal.skipped.length}`)
  for (const entry of reversal.clears) {
    console.log(`    CLEAR ${entry.username ?? entry.id}`)
  }
  for (const entry of reversal.skipped) {
    console.log(`    SKIP  ${entry.reason} ${entry.username ?? entry.id}: ${entry.detail}`)
  }
}

/** Pinned to what the run left; never lowers session_version. */
async function applyReversal(
  client: QueryClient,
  organizationId: number,
  reversal: ForcedPasswordRotationReversal,
  actorUserId: string,
  batchId: string | null,
): Promise<{ cleared: number }> {
  let cleared = 0
  for (const entry of reversal.clears) {
    const result = await client.query(
      `update users set must_change_password = false, updated_at = now()
        where id = $1 and organization_id = $2 and deleted_at is null
          and must_change_password = true and session_version = $3 and password_changed_at is null`,
      [entry.id, organizationId, entry.sessionVersion])
    assert(result.rowCount === 1, `account ${entry.username ?? entry.id} moved since the plan was built; re-run the dry run`)
    await client.query(
      `insert into system_logs (user_id, organization_id, action, resource_type, resource_id, details, success)
       values ($1, $2, $3, 'auth', $4, $5::jsonb, true)`,
      [entry.id, organizationId, AUDIT_REVERSE_ACTION, entry.username,
        JSON.stringify({ importer: `${IMPORTER}:reverse`, batchId, actorUserId })])
    cleared += 1
  }
  return { cleared }
}

async function runReverse(options: Options): Promise<void> {
  assert(options.reversePath, "--reverse needs the commit report path")
  const { report, sha256: reportSha256 } = loadCommitReport(options.reversePath)
  const { pool } = await import("../lib/db-cli")

  try {
    await assertOrganization(pool, report.organization)
    const reversal = await buildReversal(pool, report)
    const digest = sha256(forcedPasswordRotationReversalLines(reversal).join("\n"))
    const nothingToDo = reversal.clears.length === 0

    printReversal(options.reversePath, report, reversal)
    console.log(`\nPlan digest: ${digest}`)

    const payload: Record<string, unknown> = {
      importer: `${IMPORTER}:reverse`,
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: report.organization,
      source: { report: options.reversePath, sha256: reportSha256, planDigest: report.planDigest, generatedAt: report.generatedAt },
      planDigest: digest,
      counts: { clears: reversal.clears.length, skipped: reversal.skipped.length },
      reversal,
    }
    writeReport(options.outputPath, payload)
    console.log(`Report written to ${options.outputPath}`)

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to reverse: every account the run flagged has rotated, been cleared, or been changed since (see SKIP lines).")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run rotate:passwords -- --reverse="${options.reversePath}" --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${organizationConfirmation(report.organization)} \\\n    --confirm-plan=${digest}`)
      }
      return
    }

    assert(!nothingToDo, "Nothing to reverse")
    assert(options.confirmOrganization === organizationConfirmation(report.organization),
      `Commit requires --confirm-organization=${organizationConfirmation(report.organization)}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)
    const actorUserId = await assertActor(pool, options.actorUserId)

    const plannedIds = reversal.clears.map((entry) => entry.id)
    const before = await fingerprints(pool, report.organization.id, plannedIds)
    const client = await pool.connect()
    let batchId: string | null = null
    try {
      await client.query("begin")
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      const lockedReversal = await buildReversal(client, report)
      assert(sha256(forcedPasswordRotationReversalLines(lockedReversal).join("\n")) === digest,
        "Plan changed between confirmation and commit; re-run the dry run")

      if (options.commit) {
        const [batch] = await rows(client,
          `insert into legacy_import_batches
             (organization_id, source_system, source_manifest, status, imported_by_user_id)
           values ($1, $2, $3::jsonb, 'RUNNING', $4)
           returning id`,
          [
            report.organization.id,
            options.externalSources[0],
            JSON.stringify({
              importer: `${IMPORTER}:reverse`,
              planDigest: digest,
              reverses: payload.source,
              generatedAt: new Date().toISOString(),
            }),
            actorUserId,
          ])
        batchId = String(batch.id)
      }

      const applied = await applyReversal(client, report.organization.id, lockedReversal, actorUserId, batchId)

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

    const after = await fingerprints(pool, report.organization.id, plannedIds)
    assert(JSON.stringify(after) === JSON.stringify(before),
      `Fingerprints changed outside the plan; investigate immediately:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`)
    const remaining = await buildReversal(pool, report)
    assert(remaining.clears.length === 0,
      `${remaining.clears.length} account(s) still flagged after reversal; investigate immediately`)
    console.log("Verified: other tenants, other accounts and every password hash untouched; a further reversal plans nothing.")

    writeReport(options.outputPath, { ...payload, batchId, committedAt: new Date().toISOString() })
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

// ============================================================
// Status (read-only)
// ============================================================

async function runStatus(options: Options): Promise<void> {
  const { pool } = await import("../lib/db-cli")
  try {
    const organization = await resolveOrganization(pool, options)
    let since: Date
    if (options.since) {
      since = new Date(options.since)
      assert(!Number.isNaN(since.getTime()), `--since must be an ISO date, got "${options.since}"`)
    } else {
      const [batch] = await rows(pool,
        `select created_at from legacy_import_batches
          where organization_id = $1 and status = 'COMPLETED' and source_manifest->>'importer' = $2
          order by created_at desc limit 1`, [organization.id, IMPORTER])
      assert(batch, `No committed ${IMPORTER} run recorded for ${organizationConfirmation(organization)}; pass --since=<ISO date>`)
      since = new Date(String(batch.created_at))
    }

    const status = summarizeRotationStatus(await readAccounts(pool, organization.id), options, since)
    printDatabase()
    console.log(`Organization ......... ${organizationConfirmation(organization)}`)
    console.log(`  since .............. ${since.toISOString()}`)
    console.log(`  roles .............. ${options.roles.join(", ")}`)
    console.log("")
    console.log("STATUS                pending  completed  unroutable")
    for (const row of status.byRole) {
      console.log(`  ${row.role.padEnd(18)} ${String(row.pending).padStart(7)}  ${String(row.completed).padStart(9)}  ${String(row.unroutable).padStart(10)}`)
    }
    if (status.pendingUsernames.length) {
      console.log("")
      console.log(`PENDING (${status.pendingUsernames.length}): ${status.pendingUsernames.join(", ")}`)
    }
    if (status.unroutableUsernames.length) {
      console.log("")
      console.log(`PENDING WITH NO REACHABLE EMAIL (${status.unroutableUsernames.length}) — cannot complete until an administrator corrects the address: ${status.unroutableUsernames.join(", ")}`)
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  if (options.status) await runStatus(options)
  else if (options.reversePath) await runReverse(options)
  else await runForward(options)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

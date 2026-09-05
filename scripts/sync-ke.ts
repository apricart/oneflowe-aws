#!/usr/bin/env tsx
/**
 * Bring K-Electric reference data across from the legacy logistics platform.
 *
 * `import-ke-orders.ts` already imports the orders themselves, but it can only
 * place an order whose branch, ordering user and products already exist. This
 * command syncs those, so run it first and the order import second:
 *
 *     npm run sync:ke                      # dry run — prints the plan, writes nothing
 *     npm run sync:ke -- --commit ...      # applies it, with the confirmations it printed
 *     npm run import:ke-orders -- ...      # then the orders
 *
 * Read-only unless `--commit` is given, and `--commit` requires every value the
 * dry run printed back. A plan that has moved since the dry run is refused
 * rather than silently applied.
 *
 * What it will not do, deliberately:
 *   - touch any organization but K-Electric (10). Organization 2, "K-E-Demo",
 *     shares many of the same email addresses and must stay untouched.
 *   - create groups or catalogue entries. Both carry pricing scope, and pricing
 *     is `SUPER_ADMIN`-only (`lib/pricing-access.ts`); the plan reports what is
 *     missing so a person can decide.
 *   - delete or deactivate anything. A branch or account that legacy no longer
 *     has is reported, never removed.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as dotenv from "dotenv"

import {
  KE_SYNC_ORGANIZATION as ORGANIZATION,
  KE_SYNC_SOURCE as SOURCE_SYSTEM,
  ROLE_BRANCH_ADMIN,
  ROLE_ORDER_PORTAL,
  planBranches,
  planDigest,
  planGroups,
  planUsernameMigration,
  planUsers,
  summarize,
  type CurrentBranch,
  type CurrentGroup,
  type CurrentUser,
  type LegacyLocation,
  type LegacyLocationGroup,
  type LegacySubUser,
  type SyncPlan,
} from "../lib/legacy-import/ke-sync"
import { hashMirroredLegacyPassword } from "../lib/password-cli"
import { resolveWorkspacePath } from "./lib/resolve-workspace-path"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const BASE_URL = "https://logistics.oneflowe.com"
/** The K-Electric account id on the legacy platform; every read is scoped by it. */
const LEGACY_ACCOUNT_ID = 1
const FETCH_ATTEMPTS = 4
const ORGANIZATION_CONFIRMATION = `${ORGANIZATION.id}:${ORGANIZATION.code}:${ORGANIZATION.name}`

type Row = Record<string, any>
interface QueryClient { query(text: string, params?: unknown[]): Promise<{ rows: Row[] }> }

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

interface Options {
  commit: boolean
  rollbackTest: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmPlan?: string
  outputPath: string
}

function parseOptions(): Options {
  return {
    commit: flag("commit"),
    rollbackTest: flag("rollback-test"),
    actorUserId: argument("actor-user-id"),
    confirmOrganization: argument("confirm-organization"),
    confirmPlan: argument("confirm-plan"),
    outputPath: resolveWorkspacePath(
      argument("output") ?? `updatedReports/ke-sync-${new Date().toISOString().slice(0, 10)}.json`,
    ),
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${path}`
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json() as T
    } catch (error) {
      lastError = error
      if (attempt < FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
    }
  }
  throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function rows<T extends Row = Row>(client: QueryClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function readCurrent(client: QueryClient) {
  const branches = (await rows(client,
    `select id, name, external_source, external_id, group_id
       from branches where organization_id = $1 order by id`, [ORGANIZATION.id]))
    .map((row): CurrentBranch => ({
      id: Number(row.id),
      name: String(row.name),
      externalSource: row.external_source ?? null,
      externalId: row.external_id ?? null,
      groupId: row.group_id == null ? null : Number(row.group_id),
    }))

  const groups = (await rows(client,
    `select id, name from groups where organization_id = $1 order by id`, [ORGANIZATION.id]))
    .map((row): CurrentGroup => ({ id: Number(row.id), name: String(row.name) }))

  const users = (await rows(client,
    `select u.id, u.username, u.email, u.full_name, u.branch_id, u.is_active,
            u.external_source, u.external_id, r.name as role_name
       from users u join roles r on r.id = u.role_id
      where u.organization_id = $1 and u.deleted_at is null
      order by u.username`, [ORGANIZATION.id]))
    .map((row): CurrentUser => ({
      id: String(row.id),
      username: row.username ?? null,
      email: String(row.email),
      fullName: row.full_name ?? null,
      roleName: String(row.role_name),
      branchId: row.branch_id == null ? null : Number(row.branch_id),
      isActive: Boolean(row.is_active),
      externalSource: row.external_source ?? null,
      externalId: row.external_id ?? null,
    }))

  return { branches, groups, users }
}

function describe(plan: SyncPlan): string[] {
  const lines: string[] = []
  const pinsNeeded = plan.branches.pins.filter((pin) => pin.needsPin)
  const renames = plan.branches.pins.filter((pin) => pin.rename)

  lines.push("BRANCHES")
  lines.push(`  pin to legacy id ....... ${pinsNeeded.length}`)
  for (const pin of renames) {
    lines.push(`  rename ................. branch ${pin.branchId} "${pin.rename!.from}" -> "${pin.rename!.to}" (legacy ${pin.legacyLocationId})`)
  }
  for (const create of plan.branches.creates) {
    lines.push(`  create ................. "${create.name}" (legacy ${create.legacyLocationId})`)
  }
  for (const branch of plan.branches.unmatched) {
    lines.push(`  no legacy counterpart .. branch ${branch.id} "${branch.name}" (left alone)`)
  }
  for (const entry of plan.branches.ambiguous) {
    lines.push(`  AMBIGUOUS .............. legacy ${entry.legacyLocationId} "${entry.legacyName}" -> branches ${entry.candidates.join(", ")}`)
  }

  lines.push("")
  lines.push("GROUPS")
  lines.push(`  branch assignments ..... ${plan.groups.assignments.length}`)
  for (const name of plan.groups.missingGroups) lines.push(`  MISSING GROUP .......... "${name}" (create it by hand; groups carry pricing scope)`)

  lines.push("")
  lines.push("USERNAMES")
  lines.push(`  move to -ba / -op ...... ${plan.usernames.renames.length}`)
  for (const collision of plan.usernames.collisions) {
    lines.push(`  COLLISION .............. "${collision.to}" wanted by ${collision.userIds.length} account(s)`)
  }

  lines.push("")
  lines.push("USERS")
  lines.push(`  already present ........ ${plan.users.alreadyPresent}`)
  lines.push(`  stamp external identity  ${plan.users.stamps.length}`)
  lines.push(`  new people ............. ${plan.users.people.length} (${plan.users.people.length * 2} accounts)`)
  for (const person of plan.users.people) {
    lines.push(`    ${person.accounts.map((account) => account.username).join(" + ")}  ${person.email}${person.emailIsDerived ? " (derived)" : ""}  "${person.fullName}"  @ ${person.branchName}`)
  }
  for (const conflict of plan.users.conflicts) {
    lines.push(`  EMPLOYEE CODE CLASH .... ${conflict.employeeCode} is K-Electric's code for "${conflict.legacyName}"`)
    lines.push(`                           <${conflict.legacyEmail ?? "no email"}>, but OneFlowe has it on `
      + `"${conflict.heldByName}" <${conflict.heldByEmail}>`)
    lines.push(`                           -> creating "${conflict.legacyName}" as ${conflict.assignedIdentity}; sitting account untouched`)
  }
  for (const entry of plan.users.backfill) {
    lines.push(`  backfill ............... ${entry.username} (${entry.roleName}) for ${entry.email}`)
  }
  for (const skip of plan.users.skipped) {
    lines.push(`  skipped ................ legacy ${skip.legacySubUserId} [${skip.reason}] ${skip.detail}`)
  }
  return lines
}

interface CommitResult {
  batchId: string
  counts: Record<string, number>
}

async function apply(client: QueryClient, plan: SyncPlan, options: Options): Promise<CommitResult> {
  const counts: Record<string, number> = {
    branchesPinned: 0,
    branchesRenamed: 0,
    branchesCreated: 0,
    groupAssignments: 0,
    usernamesRenamed: 0,
    accountsStamped: 0,
    peopleCreated: 0,
    accountsCreated: 0,
    accountsBackfilled: 0,
  }

  const [batch] = await rows(client,
    `insert into legacy_import_batches
       (organization_id, source_system, source_manifest, status, imported_by_user_id)
     values ($1, $2, $3::jsonb, 'RUNNING', $4)
     returning id`,
    [
      ORGANIZATION.id,
      SOURCE_SYSTEM,
      JSON.stringify({
        importer: "sync-ke",
        planDigest: planDigest(plan),
        generatedAt: new Date().toISOString(),
      }),
      options.actorUserId,
    ])
  const batchId = String(batch.id)

  // 1. Branch identity. Pinning first means every later step can address a
  //    branch by its legacy id instead of by a name that may be about to change.
  for (const pin of plan.branches.pins) {
    if (!pin.needsPin && !pin.rename) continue
    await client.query(
      `update branches
          set external_source = $1, external_id = $2,
              name = case when $3::text is null then name else $3::text end,
              updated_at = now()
        where id = $4 and organization_id = $5`,
      [SOURCE_SYSTEM, String(pin.legacyLocationId), pin.rename?.to ?? null, pin.branchId, ORGANIZATION.id])
    if (pin.needsPin) counts.branchesPinned += 1
    if (pin.rename) counts.branchesRenamed += 1
  }

  for (const create of plan.branches.creates) {
    await client.query(
      `insert into branches (organization_id, name, address, external_source, external_id, status)
       values ($1, $2, $3, $4, $5, 'active')
       on conflict do nothing`,
      [ORGANIZATION.id, create.name, create.address, SOURCE_SYSTEM, String(create.legacyLocationId)])
    counts.branchesCreated += 1
  }

  // 2. Group membership.
  for (const assignment of plan.groups.assignments) {
    await client.query(
      `update branches set group_id = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [assignment.groupId, assignment.branchId, ORGANIZATION.id])
    counts.groupAssignments += 1
  }

  // 3. Usernames. Applied in two passes through a temporary name, because
  //    `users_username_idx` is unique platform-wide and a direct rename could
  //    collide with a name another row in the same batch is about to give up.
  for (const rename of plan.usernames.renames) {
    await client.query(
      `update users set username = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [`tmp:${rename.userId}`, rename.userId, ORGANIZATION.id])
  }
  for (const rename of plan.usernames.renames) {
    await client.query(
      `update users set username = $1, updated_at = now() where id = $2 and organization_id = $3`,
      [rename.to, rename.userId, ORGANIZATION.id])
    counts.usernamesRenamed += 1
  }

  // 4. External identity. This is what stops these accounts accepting an email
  //    address at the login screen, so it must land for every mirrored account.
  for (const stamp of plan.users.stamps) {
    await client.query(
      `update users set external_source = $1, external_id = $2, updated_at = now()
        where id = $3 and organization_id = $4`,
      [SOURCE_SYSTEM, stamp.externalId, stamp.userId, ORGANIZATION.id])
    counts.accountsStamped += 1
  }

  // 5. People. Both accounts share one hash of the password they already know,
  //    and both must change it on first sign-in.
  const roleIds = new Map<string, number>()
  for (const role of await rows(client, `select id, name from roles where name = any($1)`, [[ROLE_BRANCH_ADMIN, ROLE_ORDER_PORTAL]])) {
    roleIds.set(String(role.name), Number(role.id))
  }
  assert(roleIds.has(ROLE_BRANCH_ADMIN) && roleIds.has(ROLE_ORDER_PORTAL), "BRANCH_ADMIN and ORDER_PORTAL roles must exist")

  for (const person of plan.users.people) {
    const passwordHash = await hashMirroredLegacyPassword(person.legacyPassword)
    for (const account of person.accounts) {
      await client.query(
        `insert into users
           (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
            phone, organization_id, branch_id, must_change_password, external_source, external_id)
         values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, true, $11, $12)`,
        [
          person.email, account.username, passwordHash, roleIds.get(account.roleName),
          person.fullName, person.firstName, person.lastName, person.phone,
          ORGANIZATION.id, person.branchId, SOURCE_SYSTEM, person.employeeCode,
        ])
      counts.accountsCreated += 1
    }
    counts.peopleCreated += 1
  }

  // 6. The missing half of an incomplete pair, reusing the hash the person
  //    already signs in with so the two accounts stay in step.
  for (const entry of plan.users.backfill) {
    const [source] = await rows(client,
      `select password_hash, full_name, first_name, last_name, phone, must_change_password, external_id
         from users
        where organization_id = $1 and external_source = $2
          and external_id = $3 and deleted_at is null
        limit 1`,
      [ORGANIZATION.id, SOURCE_SYSTEM, entry.username.replace(/(-ba|-op)$/i, "")])
    assert(source, `no existing account to copy credentials from for ${entry.username}`)
    await client.query(
      `insert into users
         (email, username, password_hash, role_id, is_active, full_name, first_name, last_name,
          phone, organization_id, branch_id, must_change_password, external_source, external_id)
       values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        entry.email, entry.username, source.password_hash, roleIds.get(entry.roleName),
        source.full_name, source.first_name, source.last_name, source.phone,
        ORGANIZATION.id, entry.branchId, source.must_change_password, SOURCE_SYSTEM, source.external_id,
      ])
    counts.accountsBackfilled += 1
  }

  await client.query(
    `update legacy_import_batches set status = 'COMPLETED', counts = $1::jsonb, completed_at = now() where id = $2`,
    [JSON.stringify(counts), batchId])

  return { batchId, counts }
}

async function main() {
  const options = parseOptions()

  const [legacyLocations, legacyGroups, legacySubUsers] = await Promise.all([
    fetchJson<LegacyLocation[]>(`/api/Location/GetLocation/${LEGACY_ACCOUNT_ID}`),
    fetchJson<LegacyLocationGroup[]>(`/api/LocationGroup/GetLocationGroups/${LEGACY_ACCOUNT_ID}`),
    fetchJson<LegacySubUser[]>(`/api/SubUser/0/${LEGACY_ACCOUNT_ID}`),
  ])
  assert(Array.isArray(legacyLocations) && legacyLocations.length > 0, "Legacy locations endpoint returned nothing")
  assert(Array.isArray(legacyGroups), "Legacy groups endpoint did not return an array")
  assert(Array.isArray(legacySubUsers) && legacySubUsers.length > 0, "Legacy users endpoint returned nothing")

  const { pool } = await import("../lib/db-cli")
  try {
    const current = await readCurrent(pool)
    const branches = planBranches(legacyLocations, current.branches)
    const groups = planGroups(legacyGroups, current.groups, branches.pins, current.branches)
    const usernames = planUsernameMigration(current.users)
    const users = planUsers(legacySubUsers, branches.pins, current.users, { renames: usernames.renames })
    const plan: SyncPlan = { branches, groups, usernames, users }
    const digest = planDigest(plan)
    const counts = summarize(plan)

    const report = {
      generatedAt: new Date().toISOString(),
      mode: options.commit ? "COMMIT" : options.rollbackTest ? "ROLLBACK_TEST" : "DRY_RUN",
      organization: ORGANIZATION,
      source: { system: SOURCE_SYSTEM, baseUrl: BASE_URL },
      sourceCounts: {
        locations: legacyLocations.length,
        groups: legacyGroups.length,
        subUsers: legacySubUsers.length,
      },
      planDigest: digest,
      counts,
      plan,
    }
    mkdirSync(dirname(options.outputPath), { recursive: true })
    writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")

    console.log(describe(plan).join("\n"))
    console.log("")
    console.log(JSON.stringify({ output: options.outputPath, planDigest: digest, counts }, null, 2))

    assert(branches.ambiguous.length === 0,
      `${branches.ambiguous.length} legacy location(s) match more than one branch; resolve them before syncing`)
    assert(usernames.collisions.length === 0,
      `${usernames.collisions.length} username collision(s); resolve them before syncing`)

    const nothingToDo = Object.values(counts).every((value) => value === 0)
      || (counts.branchesToPin + counts.branchesToRename + counts.branchesToCreate + counts.groupAssignments
        + counts.usernameRenames + counts.peopleToCreate + counts.accountsToBackfill + counts.accountsToStamp) === 0

    if (!options.commit && !options.rollbackTest) {
      if (nothingToDo) {
        console.log("\nNothing to sync: OneFlowe already matches the legacy platform.")
      } else {
        console.log("\nDry run: nothing was written. To apply:")
        console.log(`  npm run sync:ke -- --commit \\\n    --actor-user-id=<active-super-admin-uuid> \\\n    --confirm-organization=${ORGANIZATION_CONFIRMATION} \\\n    --confirm-plan=${digest}`)
        if (counts.branchesToCreate > 0) {
          console.log(`\nNote: ${counts.branchesToCreate} branch(es) will be created. People at those branches are`)
          console.log("skipped this run (BRANCH_NOT_PINNED) — run the sync again afterwards to pick them up.")
        }
      }
      return
    }

    assert(options.actorUserId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
    assert(options.confirmOrganization === ORGANIZATION_CONFIRMATION,
      `Commit requires --confirm-organization=${ORGANIZATION_CONFIRMATION}`)
    assert(options.confirmPlan === digest, `Commit requires --confirm-plan=${digest}`)

    const [actor] = await rows(pool,
      `select u.id from users u join roles r on r.id = u.role_id
        where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active = true and u.deleted_at is null`,
      [options.actorUserId])
    assert(actor, "--actor-user-id must be an active SUPER_ADMIN")

    const client = await (pool as any).connect()
    try {
      await client.query("begin")
      await client.query(`select pg_advisory_xact_lock(hashtext('oneflowe:ke-sync'))`)

      // The plan is rebuilt inside the transaction from rows read under the
      // lock. If anything moved between the dry run and now, the digest differs
      // and nothing is written.
      const locked = await readCurrent(client)
      const lockedBranches = planBranches(legacyLocations, locked.branches)
      const lockedUsernames = planUsernameMigration(locked.users)
      const lockedPlan: SyncPlan = {
        branches: lockedBranches,
        groups: planGroups(legacyGroups, locked.groups, lockedBranches.pins, locked.branches),
        usernames: lockedUsernames,
        users: planUsers(legacySubUsers, lockedBranches.pins, locked.users, { renames: lockedUsernames.renames }),
      }
      assert(planDigest(lockedPlan) === digest, "Plan changed between confirmation and commit; re-run the dry run")

      const result = await apply(client, lockedPlan, options)
      if (options.rollbackTest) {
        await client.query("rollback")
        console.log(`\nRollback test: applied and rolled back. Counts: ${JSON.stringify(result.counts)}`)
      } else {
        await client.query("commit")
        console.log(`\nCommitted batch ${result.batchId}. Counts: ${JSON.stringify(result.counts)}`)
        console.log("Next: npm run import:ke-orders -- --start-date=<YYYY-MM-DD> --end-date=<YYYY-MM-DD>")
      }
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  } finally {
    const { closePool } = await import("../lib/db-cli")
    await closePool()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

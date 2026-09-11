#!/usr/bin/env tsx
/**
 * Read-only. Reports every account the name-correction and username-regeneration
 * runs did not write, with its current database state, as a workbook.
 *
 * Answers "did we miss anybody?" without anyone having to read two JSON reports
 * side by side. Writes nothing to the database.
 *
 *   npm run report:skipped-users -- --organization-code=KE-TEST
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { branchKey, emailKey, splitName, text } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, unknown>

interface NameSkip {
  reason: string
  sheetIndex: number
  email: string
  role: string
  branch: string
  name: string
  detail: string
}

interface UsernameSkip {
  reason: string
  userId: string
  email: string
  role: string
  branch: string | null
  fullName: string | null
  currentUsername: string | null
  detail: string
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rows<T>(client: PoolClient, query: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(query, params)).rows as T[]
}

function readReport(path: string): JsonRow {
  assert(existsSync(path), `Report not found: ${path}`)
  return JSON.parse(readFileSync(path, "utf8")) as JsonRow
}

/** Newest committed report of a kind, so the caller need not name the timestamp. */
function newestReport(prefix: string): string {
  const dir = resolve("deliverables")
  assert(existsSync(dir), "deliverables/ does not exist — run the corrections first")
  const matches = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".json")).sort()
  assert(matches.length > 0, `No committed report found matching ${prefix}*`)
  return resolve(dir, matches[matches.length - 1]!)
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? "KE-TEST"
  const namePath = resolve(arg("--name-report") ?? newestReport("user-name-correction-committed-"))
  const usernamePath = resolve(arg("--username-report") ?? newestReport("username-regeneration-committed-"))

  const nameReport = readReport(namePath)
  const usernameReport = readReport(usernamePath)
  const nameSkips = (nameReport.skipped ?? []) as NameSkip[]
  const usernameSkips = (usernameReport.skipped ?? []) as UsernameSkip[]

  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
    assert(org, `No organization with code ${code}`)
    const organizationId = Number(org.id)

    const live = await rows<JsonRow>(client, `
      select u.id, u.email, r.name as role, b.name as branch, u.full_name, u.first_name,
             u.last_name, u.username, u.phone, u.external_id
        from users u
        join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.deleted_at is null
    `, [organizationId])

    const liveByKey = new Map(live.map((row) =>
      [`${emailKey(row.email)}|${text(row.role).toUpperCase()}|${branchKey(row.branch)}`, row]))
    const liveById = new Map(live.map((row) => [String(row.id), row]))

    const [counts] = await rows<JsonRow>(client, `
      select
        (select count(*) from users where organization_id = $1 and deleted_at is null)::int as active_in_org,
        (select count(*) from users where organization_id = $1 and deleted_at is not null)::int as soft_deleted_in_org,
        (select count(*) from users where organization_id is distinct from $1)::int as other_tenants
    `, [organizationId])

    /* ---------------------------------------------------------- skipped rows */
    const skipped: Array<Record<string, string | number>> = nameSkips.map((skip) => {
      const row = liveByKey.get(`${emailKey(skip.email)}|${text(skip.role).toUpperCase()}|${branchKey(skip.branch)}`)
      const proposed = splitName(skip.name)
      return {
        "Task": "Name correction",
        "Why it was skipped": skip.reason,
        "Excel row": skip.sheetIndex + 2,
        "Name in your Excel": skip.name,
        "Email": skip.email,
        "Role": skip.role,
        "Branch": skip.branch,
        "DB full_name (unchanged)": (row?.full_name as string | null) ?? "",
        "DB first_name (unchanged)": (row?.first_name as string | null) ?? "",
        "DB last_name (unchanged)": (row?.last_name as string | null) ?? "",
        "Would have become full_name": proposed.fullName,
        "Would have become first_name": proposed.firstName,
        "Would have become last_name": proposed.lastName ?? "",
        "Username now": (row?.username as string | null) ?? "",
        "Employee code": (row?.external_id as string | null) ?? "",
        "What to do": "The Branch Admin and Order Portal rows give this person two different names. Pick one in the spreadsheet, then re-run.",
        "Detail": skip.detail,
      }
    })

    for (const skip of usernameSkips) {
      const row = liveById.get(skip.userId)
      skipped.push({
        "Task": "Username regeneration",
        "Why it was skipped": skip.reason,
        "Excel row": 0,
        "Name in your Excel": "",
        "Email": skip.email,
        "Role": skip.role,
        "Branch": skip.branch ?? "",
        "DB full_name (unchanged)": (row?.full_name as string | null) ?? skip.fullName ?? "",
        "DB first_name (unchanged)": (row?.first_name as string | null) ?? "",
        "DB last_name (unchanged)": (row?.last_name as string | null) ?? "",
        "Would have become full_name": "",
        "Would have become first_name": "",
        "Would have become last_name": "",
        "Username now": skip.currentUsername ?? "",
        "Employee code": (row?.external_id as string | null) ?? "",
        "What to do": "Username could not be built from this account.",
        "Detail": skip.detail,
      })
    }

    /* -------------------------------------------------------------- summary */
    const nameSummary = (nameReport.summary ?? {}) as JsonRow
    const usernameSummary = (usernameReport.summary ?? {}) as JsonRow
    const summary = [
      { Item: "Organization", Value: `${org.id} / ${org.code} / ${org.name}` },
      { Item: "Active accounts in this organization", Value: Number(counts!.active_in_org) },
      { Item: "— Name correction: updated", Value: Number(nameSummary.toUpdate ?? 0) },
      { Item: "— Name correction: already correct, no change needed", Value: Number(nameSummary.alreadyCorrect ?? 0) },
      { Item: "— Name correction: SKIPPED", Value: Number(nameSummary.skipped ?? 0) },
      { Item: "— Name correction: accounts absent from your Excel", Value: Number(nameSummary.databaseAccountsNotInSheet ?? 0) },
      { Item: "— Username regeneration: renamed", Value: Number(usernameSummary.toRename ?? 0) },
      { Item: "— Username regeneration: SKIPPED", Value: Number(usernameSummary.skipped ?? 0) },
      { Item: "Soft-deleted accounts in this organization (never in scope)", Value: Number(counts!.soft_deleted_in_org) },
      { Item: "Accounts in other organizations (never in scope)", Value: Number(counts!.other_tenants) },
      { Item: "Name correction report", Value: namePath },
      { Item: "Username report", Value: usernamePath },
    ]

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(summary)), "Summary")
    XLSX.utils.book_append_sheet(workbook,
      XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(skipped.length > 0 ? skipped : [{ Result: "No accounts were skipped" }])),
      "Skipped accounts")

    const output = resolve(arg("--output") ?? "deliverables/skipped-users.xlsx")
    mkdirSync(dirname(output), { recursive: true })
    XLSX.writeFile(workbook, output)

    console.log(JSON.stringify({
      output,
      organization: `${org.id}:${org.code}:${org.name}`,
      skippedTotal: skipped.length,
      nameCorrectionSkipped: nameSkips.length,
      usernameSkipped: usernameSkips.length,
      activeAccountsInOrg: Number(counts!.active_in_org),
      softDeletedInOrg: Number(counts!.soft_deleted_in_org),
    }, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

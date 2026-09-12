#!/usr/bin/env tsx
/**
 * Read-only. Verifies a credential hand-out workbook (as produced by
 * `build-credential-handout.ts`) against the live accounts of one tenant:
 * every row must resolve to one account in that organization and its Password
 * must authenticate against the stored bcrypt hash. A row is matched by
 * Username first; failing that, by Login Code (`users.external_id`) and the
 * portal suffix of the username (`-ba` approves, `-op` orders), which is how
 * the hand-out was built. Username, Email, Branch, Portal and the two flag
 * columns are compared as well so a stale hand-out is caught.
 *
 * Prints counts only. Per-row detail (never the password) is written to a
 * gitignored workbook under `deliverables/`.
 *
 *   npm run verify:credentials -- --organization-code=0001 --file=user-logins-handout.xlsx
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { text } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, unknown>

interface HandoutRow {
  row: number
  name: string
  email: string
  branch: string
  portal: string
  username: string
  password: string
  loginCode: string
  active: string
  mustChange: string
}

interface Account {
  id: string
  email: string
  role: string
  branch: string | null
  fullName: string | null
  username: string
  externalId: string | null
  passwordHash: string
  isActive: boolean
  mustChangePassword: boolean
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

function portalOf(role: string): string {
  return role === "BRANCH_ADMIN" ? "Branch Admin (approves orders)" : "Order Portal (places orders)"
}

/** Employee codes are compared as digits-and-letters, case-insensitively. */
function codeKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** The portal suffix of a hand-out username: `-ba` approves, `-op` orders. */
function roleOfSuffix(username: string): string | null {
  const suffix = username.toLowerCase().match(/-([a-z]+)$/)?.[1]
  if (suffix === "ba") return "BRANCH_ADMIN"
  if (suffix === "op") return "ORDER_PORTAL"
  return null
}

function readHandout(path: string): HandoutRow[] {
  assert(existsSync(path), `Hand-out not found: ${path}`)
  const workbook = XLSX.readFile(path)
  const sheet = workbook.Sheets.Logins ?? workbook.Sheets[workbook.SheetNames[0]!]
  assert(sheet, "Workbook contains no sheets")
  const raw = XLSX.utils.sheet_to_json<JsonRow>(sheet, { defval: "" })
  assert(raw.length > 0, "Hand-out is empty")
  for (const column of ["Username", "Password"]) {
    assert(column in raw[0]!, `Hand-out is missing the "${column}" column`)
  }
  return raw.map((row, index) => ({
    row: index + 2,
    name: text(row.Name),
    email: text(row.Email).toLowerCase(),
    branch: text(row.Branch),
    portal: text(row.Portal),
    username: text(row.Username),
    password: String(row.Password ?? ""),
    loginCode: text(row["Login Code"]),
    active: text(row["Account active"]),
    mustChange: text(row["Must change password at next login"]),
  }))
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? "0001"
  const sourcePath = resolve(arg("--file") ?? "user-logins-handout.xlsx")
  const handout = readHandout(sourcePath)

  // Same reasoning as build-credential-handout.ts: the app hasher is
  // `server-only`, and bcrypt verification is fully specified, so bcryptjs
  // directly checks exactly what a login would.
  const bcrypt = (await import("bcryptjs")).default
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()

  try {
    const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
    assert(org, `No organization with code ${code}`)

    const accounts = (await rows<JsonRow>(client, `
      select u.id, u.email, r.name as role, b.name as branch, u.full_name, u.username,
             u.external_id, u.password_hash, u.is_active, u.must_change_password
        from users u
        join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.deleted_at is null and u.username is not null
         and coalesce(u.external_source, '') !~ '_RETIRED$'
    `, [Number(org.id)])).map((row): Account => ({
      id: String(row.id),
      email: String(row.email ?? "").toLowerCase(),
      role: String(row.role ?? ""),
      branch: (row.branch as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      username: String(row.username),
      externalId: (row.external_id as string | null) ?? null,
      passwordHash: String(row.password_hash ?? ""),
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
    }))

    const byUsername = new Map(accounts.map((a) => [a.username.toLowerCase(), a]))
    const byCodeAndRole = new Map<string, Account[]>()
    for (const account of accounts) {
      const key = `${codeKey(account.externalId)}:${account.role}`
      if (!codeKey(account.externalId)) continue
      byCodeAndRole.set(key, [...(byCodeAndRole.get(key) ?? []), account])
    }
    const results: Array<Record<string, string>> = []
    const counts = { ok: 0, passwordMismatch: 0, userNotFound: 0, ambiguous: 0, detailDrift: 0 }
    const seen = new Set<string>()

    for (const row of handout) {
      let account = byUsername.get(row.username.toLowerCase())
      if (!account) {
        const role = roleOfSuffix(row.username)
        const candidates = role ? byCodeAndRole.get(`${codeKey(row.loginCode)}:${role}`) ?? [] : []
        if (candidates.length > 1) {
          counts.ambiguous++
          results.push({ Row: String(row.row), Username: row.username, Name: row.name,
            Status: "AMBIGUOUS", Detail: `${candidates.length} accounts share this login code and role` })
          continue
        }
        account = candidates[0]
      }
      if (!account) {
        counts.userNotFound++
        results.push({ Row: String(row.row), Username: row.username, Name: row.name,
          Status: "USER_NOT_FOUND", Detail: "No account matches this username, or this login code and portal, in the organization" })
        continue
      }
      seen.add(account.id)

      const passwordOk = account.passwordHash ? await bcrypt.compare(row.password, account.passwordHash) : false
      const drift: string[] = []
      if (row.username.toLowerCase() !== account.username.toLowerCase()) drift.push("username")
      if (row.email && row.email !== account.email) drift.push("email")
      if (row.branch !== (account.branch ?? "")) drift.push("branch")
      if (row.portal && row.portal !== portalOf(account.role)) drift.push("portal")
      if (row.active && (row.active === "Yes") !== account.isActive) drift.push("active")
      if (row.mustChange && (row.mustChange === "Yes") !== account.mustChangePassword) drift.push("must-change-password")
      if (row.loginCode && row.loginCode.toLowerCase() !== (account.externalId ?? "").toLowerCase()) drift.push("login-code")

      let status: string
      if (!passwordOk) { status = "PASSWORD_MISMATCH"; counts.passwordMismatch++ }
      else if (drift.length > 0) { status = "DETAILS_DRIFTED"; counts.detailDrift++ }
      else { status = "OK"; counts.ok++ }

      results.push({ Row: String(row.row), Username: row.username, "DB username": account.username,
        Name: row.name, Role: account.role, Status: status, "Password OK": passwordOk ? "Yes" : "No",
        Detail: drift.length > 0 ? `Differs in DB: ${drift.join(", ")}` : "" })
    }

    const notInHandout = accounts.filter((a) => !seen.has(a.id))

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(results)), "Results")
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
      notInHandout.length > 0
        ? notInHandout.map((a) => ({ Username: a.username, Name: a.fullName ?? "", Role: a.role,
            Branch: a.branch ?? "", Active: a.isActive ? "Yes" : "No" }))
        : [{ Result: "Every account in the organization appears in the hand-out" }])), "Not in handout")

    const output = resolve(arg("--output") ?? "deliverables/credential-handout-verification.xlsx")
    mkdirSync(dirname(output), { recursive: true })
    XLSX.writeFile(workbook, output)

    console.log(JSON.stringify({
      output,
      organization: `${org.id}:${org.code}:${org.name}`,
      handoutRows: handout.length,
      accountsInOrganization: accounts.length,
      ...counts,
      accountsNotInHandout: notInHandout.length,
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

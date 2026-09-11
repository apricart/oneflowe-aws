#!/usr/bin/env tsx
/**
 * Read-only. Builds hand-out rows for the accounts of one tenant that the
 * credential hand-out does not cover, so `align:handout` can bring them into
 * line with everyone else.
 *
 * `build-credential-handout.ts` joins the legacy list to accounts by employee
 * code, which misses an account whose `external_id` is a placeholder rather
 * than the code. This script joins the two by email instead — only where the
 * email names exactly one legacy person and exactly one account per role — and
 * verifies the legacy password against the stored hash before writing a row.
 *
 * The username follows the rule `fix:usernames` applies:
 * `<first name>-<legacy code>-<ba|op>`. The name is the reviewed one from the
 * user-directory export where that sheet has the person, else the account's own.
 *
 * Output holds live plaintext credentials: written under `deliverables/`,
 * never committed. A merged hand-out (original rows + supplement) is written
 * beside it for distribution.
 *
 *   npm run report:credentials-supplement -- --organization-code=0001
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { codeKey, roleOfUsername } from "../lib/handout-alignment"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { emailKey, matchKey, splitName, text } from "../lib/user-name-correction"
import { buildUsername } from "../lib/username-generation"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, unknown>

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

function readSheet(path: string, sheetName?: string): JsonRow[] {
  assert(existsSync(path), `Spreadsheet not found: ${path}`)
  const workbook = XLSX.readFile(path)
  const sheet = (sheetName && workbook.Sheets[sheetName]) || workbook.Sheets[workbook.SheetNames[0]!]
  assert(sheet, `${path} contains no sheets`)
  return XLSX.utils.sheet_to_json<JsonRow>(sheet, { defval: "" })
}

/** Legacy names sometimes end in a lone dash; it is not part of the name. */
function cleanName(value: unknown): string {
  return text(value).replace(/\s*-\s*$/, "")
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? "0001"
  const handoutPath = resolve(arg("--handout") ?? "user-logins-handout.xlsx")
  const legacyPath = resolve(arg("--legacy") ?? "User List (4).xls")
  const reviewedPath = resolve(arg("--reviewed") ?? "users-export-1788975177804.xlsx")

  const handout = readSheet(handoutPath, "Logins")
  const legacy = readSheet(legacyPath)
  const reviewed = readSheet(reviewedPath)
  for (const column of ["First Name", "Password", "Login Code", "Email"]) {
    assert(column in legacy[0]!, `Legacy list is missing the "${column}" column`)
  }

  const legacyByEmail = new Map<string, JsonRow[]>()
  for (const row of legacy) {
    const key = emailKey(row.Email)
    if (key) legacyByEmail.set(key, [...(legacyByEmail.get(key) ?? []), row])
  }
  const reviewedByKey = new Map<string, JsonRow[]>()
  for (const row of reviewed) {
    const key = matchKey(row.Email, row.Role, row.Branch)
    reviewedByKey.set(key, [...(reviewedByKey.get(key) ?? []), row])
  }
  const covered = new Set<string>()
  for (const row of handout) {
    const role = roleOfUsername(row.Username)
    if (role) covered.add(`${codeKey(row["Login Code"])}|${role}`)
  }

  const bcrypt = (await import("bcryptjs")).default
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
    assert(org, `No organization with code ${code}`)

    const accounts = await rows<JsonRow>(client, `
      select u.id, u.email, r.name as role, b.name as branch, u.full_name, u.username, u.external_id,
             u.password_hash, u.is_active, u.must_change_password
        from users u
        join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1 and u.deleted_at is null and u.is_active
       order by u.email, r.name
    `, [Number(org.id)])

    const supplement: Array<Record<string, string>> = []
    const problems: Array<Record<string, string>> = []

    for (const account of accounts) {
      const role = String(account.role)
      const email = emailKey(account.email)
      if (covered.has(`${codeKey(account.external_id)}|${role}`)) continue
      const handoutRow = handout.find((row) => emailKey(row.Email) === email && roleOfUsername(row.Username) === role
        && text(row.Username).toLowerCase() === String(account.username ?? "").toLowerCase())
      if (handoutRow) continue

      const base = { Name: String(account.full_name ?? ""), Email: String(account.email), Role: role, Username: String(account.username ?? "") }
      const people = legacyByEmail.get(email) ?? []
      if (people.length !== 1) {
        problems.push({ ...base, Issue: people.length === 0 ? "NOT_IN_LEGACY_LIST" : "EMAIL_SHARED_IN_LEGACY_LIST",
          Detail: people.length === 0 ? "No legacy row carries this email, so no password is known" : `${people.length} legacy people share this email` })
        continue
      }
      const sameRole = accounts.filter((a) => emailKey(a.email) === email && String(a.role) === role)
      if (sameRole.length !== 1) {
        problems.push({ ...base, Issue: "EMAIL_SHARED_IN_ORGANIZATION", Detail: `${sameRole.length} ${role} accounts share this email` })
        continue
      }

      const person = people[0]!
      const password = String(person.Password ?? "")
      const verifies = account.password_hash ? await bcrypt.compare(password, String(account.password_hash)) : false
      if (!verifies) {
        problems.push({ ...base, Issue: "PASSWORD_DOES_NOT_MATCH_STORED_HASH", Detail: "The legacy password does not authenticate this account; it must be reset before hand-out" })
        continue
      }

      const reviewedRows = reviewedByKey.get(matchKey(account.email, role, account.branch)) ?? []
      const name = reviewedRows.length === 1
        ? cleanName(reviewedRows[0]!.Name)
        : cleanName(account.full_name) || cleanName(`${text(person["First Name"])} ${text(person["Last Name"])}`)
      const parts = splitName(name)
      const built = buildUsername(parts.firstName, person["Login Code"], role)
      if ("error" in built) {
        problems.push({ ...base, Issue: built.error, Detail: "Could not build a username under the rule" })
        continue
      }

      supplement.push({
        Name: parts.fullName,
        Email: String(account.email),
        Branch: String(account.branch ?? ""),
        Portal: role === "BRANCH_ADMIN" ? "Branch Admin (approves orders)" : "Order Portal (places orders)",
        Username: built.username,
        Password: password,
        "Login Code": text(person["Login Code"]),
        // The account's own code when it is not the legacy one, so the
        // alignment targets this account and not a previous holder's.
        "Account code": codeKey(account.external_id) === codeKey(person["Login Code"]) ? "" : String(account.external_id ?? ""),
        "Account active": account.is_active ? "Yes" : "No",
        "Must change password at next login": account.must_change_password ? "Yes" : "No",
        "Name source": reviewedRows.length === 1 ? "reviewed export" : "account",
      })
    }

    supplement.sort((a, b) => a.Name.localeCompare(b.Name) || a.Username.localeCompare(b.Username))

    const outDir = resolve(arg("--out-dir") ?? "deliverables")
    mkdirSync(outDir, { recursive: true })
    const supplementPath = resolve(outDir, "user-logins-handout-supplement.xlsx")
    const mergedPath = resolve(outDir, "user-logins-handout-complete.xlsx")

    const columns = ["Name", "Email", "Branch", "Portal", "Username", "Password", "Login Code", "Account code", "Account active", "Must change password at next login"]
    const strip = (row: Record<string, unknown>) => Object.fromEntries(columns.map((c) => [c, String(row[c] ?? "")]))

    const supplementBook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(supplementBook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(
      supplement.length > 0 ? supplement : [{ Result: "Every active account is already in the hand-out" }])), "Logins")
    XLSX.utils.book_append_sheet(supplementBook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(
      problems.length > 0 ? problems : [{ Result: "No problems" }])), "Needs attention")
    XLSX.writeFile(supplementBook, supplementPath)

    const mergedBook = XLSX.utils.book_new()
    // A supplement row supersedes an original row with the same username: the
    // original was built from a login code that has since changed hands and
    // would otherwise address the previous holder's account.
    const superseded = new Set(supplement.map((row) => row.Username!.toLowerCase()))
    const merged = [...handout.filter((row) => !superseded.has(text(row.Username).toLowerCase())).map(strip), ...supplement.map(strip)]
      .sort((a, b) => a.Name!.localeCompare(b.Name!) || a.Username!.localeCompare(b.Username!))
    XLSX.utils.book_append_sheet(mergedBook, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(merged)), "Logins")
    XLSX.writeFile(mergedBook, mergedPath)

    console.log(JSON.stringify({
      organization: `${org.id}:${org.code}:${org.name}`,
      activeAccounts: accounts.length,
      alreadyInHandout: accounts.length - supplement.length - problems.length,
      supplementRows: supplement.length,
      needsAttention: problems.length,
      supplement: supplementPath,
      merged: mergedPath,
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

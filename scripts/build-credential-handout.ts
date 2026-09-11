#!/usr/bin/env tsx
/**
 * Read-only. Builds the credential hand-out for a tenant: each person's two
 * portal usernames beside the password from the source list they were created
 * from.
 *
 * Every password is verified against the stored bcrypt hash before it is
 * written out, using the application's own `bcryptCompare`. A password that
 * does not authenticate is reported rather than handed to somebody who would
 * then fail to log in — that check is the whole point of this script.
 *
 * Joins on the employee code: the source list's `Login Code` against
 * `users.external_id`, which is what the K-Electric sync keyed accounts by.
 *
 * The output contains live plaintext credentials. It is written under
 * `deliverables/`, which is gitignored, and must never be committed, emailed
 * unencrypted, or kept after distribution.
 *
 *   npm run report:credentials -- --organization-code=KE-TEST --file="User List (4).xls"
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

interface SourcePerson {
  row: number
  firstName: string
  lastName: string
  location: string
  password: string
  loginCode: string
  email: string
}

interface Account {
  id: string
  email: string
  role: string
  branch: string | null
  fullName: string | null
  username: string | null
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

/** Employee codes are compared as digits-and-letters, case-insensitively. */
function codeKey(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]/g, "")
}

function readSource(path: string): SourcePerson[] {
  assert(existsSync(path), `Source list not found: ${path}`)
  const workbook = XLSX.readFile(path)
  const sheetName = workbook.SheetNames[0]
  assert(sheetName, "Workbook contains no sheets")
  const raw = XLSX.utils.sheet_to_json<JsonRow>(workbook.Sheets[sheetName]!, { defval: "" })
  assert(raw.length > 0, "Source list is empty")

  for (const column of ["First Name", "Password", "Login Code", "Email"]) {
    assert(column in raw[0]!, `Source list is missing the "${column}" column`)
  }

  return raw.map((row, index) => ({
    row: index + 2,
    firstName: text(row["First Name"]),
    lastName: text(row["Last Name"]),
    location: text(row.Location),
    password: String(row.Password ?? ""),
    loginCode: text(row["Login Code"]),
    email: text(row.Email),
  }))
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? "KE-TEST"
  const sourcePath = resolve(arg("--file") ?? "User List (4).xls")
  const source = readSource(sourcePath)

  // `lib/server/password-hasher` is `server-only` and throws outside a server
  // component, so CLI scripts here use bcryptjs directly, as
  // `reset-user-password.ts` and `create-super-admin.ts` do. Bcrypt is fully
  // specified — a given (password, salt, cost) has one correct digest — so this
  // verifies exactly what the application's hasher would.
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
       where u.organization_id = $1 and u.deleted_at is null
       order by u.username
    `, [Number(org.id)])).map((row): Account => ({
      id: String(row.id),
      email: String(row.email ?? ""),
      role: String(row.role ?? ""),
      branch: (row.branch as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      username: (row.username as string | null) ?? null,
      externalId: (row.external_id as string | null) ?? null,
      passwordHash: String(row.password_hash ?? ""),
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
    }))

    const byCode = new Map<string, Account[]>()
    for (const account of accounts) {
      const key = codeKey(account.externalId)
      if (!key) continue
      byCode.set(key, [...(byCode.get(key) ?? []), account])
    }

    const handout: Array<Record<string, string>> = []
    const problems: Array<Record<string, string>> = []
    const matchedAccountIds = new Set<string>()
    let verified = 0

    for (const person of source) {
      const matches = byCode.get(codeKey(person.loginCode)) ?? []

      if (matches.length === 0) {
        problems.push({
          Issue: "NO_ACCOUNT_FOR_LOGIN_CODE",
          "Source row": String(person.row),
          Name: person.firstName,
          Email: person.email,
          "Login Code": person.loginCode,
          Detail: "No account in this organization carries this employee code",
        })
        continue
      }

      for (const account of matches) {
        matchedAccountIds.add(account.id)
        const ok = account.passwordHash ? await bcrypt.compare(person.password, account.passwordHash) : false
        if (ok) verified++

        const record: Record<string, string> = {
          Name: account.fullName ?? person.firstName,
          Email: account.email,
          Branch: account.branch ?? "",
          Portal: account.role === "BRANCH_ADMIN" ? "Branch Admin (approves orders)" : "Order Portal (places orders)",
          Username: account.username ?? "",
          Password: person.password,
          "Login Code": person.loginCode,
          "Account active": account.isActive ? "Yes" : "No",
          "Must change password at next login": account.mustChangePassword ? "Yes" : "No",
        }

        if (ok) handout.push(record)
        else {
          problems.push({
            Issue: "PASSWORD_DOES_NOT_MATCH_STORED_HASH",
            "Source row": String(person.row),
            Name: account.fullName ?? person.firstName,
            Email: account.email,
            Role: account.role,
            Username: account.username ?? "",
            "Login Code": person.loginCode,
            Detail: "The password in the source list does not authenticate this account; it must be reset before hand-out",
          })
        }
      }
    }

    for (const account of accounts) {
      if (matchedAccountIds.has(account.id)) continue
      problems.push({
        Issue: "ACCOUNT_NOT_IN_SOURCE_LIST",
        "Source row": "",
        Name: account.fullName ?? "",
        Email: account.email,
        Role: account.role,
        Username: account.username ?? "",
        "Login Code": account.externalId ?? "",
        Detail: "This account has no row in the source list, so no password is known for it",
      })
    }

    handout.sort((a, b) => a.Name.localeCompare(b.Name) || a.Username.localeCompare(b.Username))

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook,
      XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(handout)), "Logins")
    XLSX.utils.book_append_sheet(workbook,
      XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(
        problems.length > 0 ? problems : [{ Result: "Every account verified" }])), "Needs attention")

    const output = resolve(arg("--output") ?? "deliverables/user-logins-handout.xlsx")
    mkdirSync(dirname(output), { recursive: true })
    XLSX.writeFile(workbook, output)

    console.log(JSON.stringify({
      output,
      organization: `${org.id}:${org.code}:${org.name}`,
      sourcePeople: source.length,
      accountsInOrganization: accounts.length,
      passwordsVerifiedAgainstHash: verified,
      rowsInHandout: handout.length,
      needsAttention: problems.length,
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

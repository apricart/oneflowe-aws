#!/usr/bin/env tsx
/**
 * Read-only. For every row of a credential hand-out, answers "can this person
 * sign in with this row today?" against one tenant, the way the login form
 * would: exact username, bcrypt password, active account — and, beyond what
 * the login form checks, that the account the username lands on belongs to
 * the person on the row (same email), because a username can be sitting on
 * somebody else's account.
 *
 * Writes an Excel report of the rows that cannot sign in, each with the
 * reason and the action that clears it, plus the tenant's active accounts
 * that no hand-out row covers. Never prints or writes a password.
 *
 *   npm run report:login-status -- --organization-code=0001 --file=deliverables/user-logins-handout-complete.xlsx
 */

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import type { PoolClient } from "pg"
import * as XLSX from "xlsx"

import { codeKey, roleOfUsername } from "../lib/handout-alignment"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { emailKey, text } from "../lib/user-name-correction"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type JsonRow = Record<string, unknown>

interface Account {
  id: string
  email: string
  role: string
  branch: string | null
  username: string | null
  externalId: string | null
  fullName: string | null
  isActive: boolean
  mustChangePassword: boolean
  deleted: boolean
  updatedAt: Date | null
  passwordHash: string
}

type Status =
  | "OK"
  | "PASSWORD_MISMATCH"
  | "ACCOUNT_INACTIVE"
  | "USERNAME_ON_ANOTHER_PERSONS_ACCOUNT"
  | "USERNAME_NOT_SET_YET"
  | "ACCOUNT_DELETED"
  | "NOT_IN_DATABASE"

const ACTION: Record<Status, string> = {
  OK: "",
  PASSWORD_MISMATCH: "If the person has set their own password, nothing; otherwise reset it and reissue this row",
  ACCOUNT_INACTIVE: "Activate the account",
  USERNAME_ON_ANOTHER_PERSONS_ACCOUNT: "Run the person-changed revert, then the supplement alignment (plans/OF-KE-align-accounts-to-handout.md, Correction)",
  USERNAME_NOT_SET_YET: "Run the pending alignment for this row (supplement alignment or head-office conversion)",
  ACCOUNT_DELETED: "The account is soft-deleted; restore it or create a new one if the person still needs access, and reissue",
  NOT_IN_DATABASE: "No account for this person and role; create one if access is needed, and reissue",
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

/** The role a hand-out row addresses: the portal suffix, else the Portal column. */
function roleOfRow(row: JsonRow): string | null {
  const bySuffix = roleOfUsername(row.Username)
  if (bySuffix) return bySuffix
  const portal = text(row.Portal).toLowerCase()
  if (portal.startsWith("head office")) return "HEAD_OFFICE"
  if (portal.startsWith("branch admin")) return "BRANCH_ADMIN"
  if (portal.startsWith("order portal")) return "ORDER_PORTAL"
  return null
}

async function main(): Promise<void> {
  const code = arg("--organization-code") ?? "0001"
  const handoutPath = resolve(arg("--file") ?? "deliverables/user-logins-handout-complete.xlsx")
  assert(existsSync(handoutPath), `Hand-out not found: ${handoutPath}`)
  const workbook = XLSX.readFile(handoutPath)
  const sheet = workbook.Sheets.Logins ?? workbook.Sheets[workbook.SheetNames[0]!]
  assert(sheet, "Workbook contains no sheets")
  const handout = XLSX.utils.sheet_to_json<JsonRow>(sheet, { defval: "" })
  for (const column of ["Name", "Email", "Username", "Password"]) {
    assert(column in handout[0]!, `Hand-out is missing the "${column}" column`)
  }

  const bcrypt = (await import("bcryptjs")).default
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  try {
    const [org] = await rows<JsonRow>(client, "select id, code, name from organizations where code = $1", [code])
    assert(org, `No organization with code ${code}`)

    const accounts = (await rows<JsonRow>(client, `
      select u.id, u.email, r.name as role, b.name as branch, u.username, u.external_id, u.full_name,
             u.is_active, u.must_change_password, u.deleted_at is not null as deleted, u.updated_at, u.password_hash
        from users u
        join roles r on r.id = u.role_id
        left join branches b on b.id = u.branch_id
       where u.organization_id = $1
    `, [Number(org.id)])).map((row): Account => ({
      id: String(row.id),
      email: String(row.email ?? ""),
      role: String(row.role ?? ""),
      branch: (row.branch as string | null) ?? null,
      username: (row.username as string | null) ?? null,
      externalId: (row.external_id as string | null) ?? null,
      fullName: (row.full_name as string | null) ?? null,
      isActive: Boolean(row.is_active),
      mustChangePassword: Boolean(row.must_change_password),
      deleted: Boolean(row.deleted),
      updatedAt: row.updated_at ? new Date(String(row.updated_at)) : null,
      passwordHash: String(row.password_hash ?? ""),
    }))
    const live = accounts.filter((a) => !a.deleted)
    const byUsername = new Map(live.filter((a) => a.username).map((a) => [a.username!.toLowerCase(), a]))

    /**
     * The live account a row is meant for, whatever username it carries today:
     * the one carrying the row's code (account code first, then login code),
     * preferring the row's role; a head-office row whose person still holds a
     * portal pair addresses the Branch Admin account awaiting conversion; else
     * the only live account with the row's email and role.
     */
    const intended = (row: JsonRow, role: string | null): Account | undefined => {
      const codes = [codeKey(row["Account code"]), codeKey(row["Login Code"])].filter(Boolean)
      for (const code of codes) {
        const holders = live.filter((a) => codeKey(a.externalId) === code)
        const preferred = holders.find((a) => a.role === role)
          ?? (role === "HEAD_OFFICE" ? holders.find((a) => a.role === "BRANCH_ADMIN") : undefined)
        if (preferred) return preferred
        if (holders.length === 1) return holders[0]
      }
      const byEmail = live.filter((a) => (!role || a.role === role) && emailKey(a.email) === emailKey(row.Email))
      return byEmail.length === 1 ? byEmail[0] : undefined
    }
    const deletedByCode = (row: JsonRow, role: string | null): Account | undefined =>
      accounts.find((a) => a.deleted && (!role || a.role === role) && codeKey(a.externalId) !== "" && codeKey(a.externalId) === codeKey(row["Login Code"]))

    const problems: Array<Record<string, string | number>> = []
    const counts: Record<Status, number> = { OK: 0, PASSWORD_MISMATCH: 0, ACCOUNT_INACTIVE: 0,
      USERNAME_ON_ANOTHER_PERSONS_ACCOUNT: 0, USERNAME_NOT_SET_YET: 0, ACCOUNT_DELETED: 0, NOT_IN_DATABASE: 0 }
    const coveredIds = new Set<string>()

    /** Evidence the person has taken the account over themselves. */
    const changedSince = (account: Account): string =>
      !account.mustChangePassword && account.updatedAt
        ? ` — account updated ${account.updatedAt.toISOString()} and the must-change flag is cleared, so the person has most likely signed in and set their own password (no action needed unless they ask)`
        : ""

    const authenticates = async (account: Account, password: string): Promise<boolean> =>
      account.passwordHash !== "" && password !== "" && bcrypt.compare(password, account.passwordHash)

    for (const [index, row] of handout.entries()) {
      const role = roleOfRow(row)
      const username = text(row.Username).toLowerCase()
      const password = String(row.Password ?? "")
      const holder = byUsername.get(username)
      const target = intended(row, role)
      let status: Status
      let detail = ""

      if (holder && target && target.id !== holder.id) {
        // The username has landed on somebody else's account; the person's own account is elsewhere.
        status = "USERNAME_ON_ANOTHER_PERSONS_ACCOUNT"
        detail = `Username is on the account of ${holder.fullName ?? holder.id} <${holder.email}>; this person's own account is ${target.username ?? target.id}`
        coveredIds.add(target.id)
      } else if (holder) {
        coveredIds.add(holder.id)
        if (!await authenticates(holder, password)) { status = "PASSWORD_MISMATCH"; detail = `Hand-out password does not authenticate this account${changedSince(holder)}` }
        else if (!holder.isActive) { status = "ACCOUNT_INACTIVE"; detail = "Username and password are right but the account is inactive" }
        else status = "OK"
      } else if (deletedByCode(row, role) && codeKey(target?.externalId) !== codeKey(row["Login Code"])) {
        const gone = deletedByCode(row, role)!
        status = "ACCOUNT_DELETED"
        detail = `The account for login code ${text(row["Login Code"])} (${gone.username ?? gone.id}) is soft-deleted`
      } else if (target) {
        coveredIds.add(target.id)
        const where = `${target.username ?? target.id} (${target.role})`
        if (!await authenticates(target, password)) {
          status = "PASSWORD_MISMATCH"
          detail = `Account exists as ${where} but the hand-out password does not authenticate it, so the hand-out username was not applied`
        } else {
          status = "USERNAME_NOT_SET_YET"
          detail = `Account exists as ${where}; the hand-out username has not been applied yet`
        }
      } else {
        status = "NOT_IN_DATABASE"
        detail = `No active ${role ?? ""} account with login code ${text(row["Login Code"])} or email ${text(row.Email)}`
      }

      counts[status]++
      if (status !== "OK") {
        problems.push({
          "Hand-out row": index + 2,
          Name: text(row.Name),
          Email: text(row.Email),
          Portal: text(row.Portal),
          Branch: text(row.Branch),
          Username: text(row.Username),
          "Login Code": text(row["Login Code"]),
          Status: status,
          Detail: detail,
          "Action to clear": ACTION[status],
        })
      }
    }

    const notInHandout = live
      .filter((a) => !coveredIds.has(a.id) && ["BRANCH_ADMIN", "ORDER_PORTAL", "HEAD_OFFICE"].includes(a.role))
      .map((a) => ({
        Name: a.fullName ?? "", Email: a.email, Role: a.role, Branch: a.branch ?? "", Username: a.username ?? "",
        "External id": a.externalId ?? "", Active: a.isActive ? "Yes" : "No",
        Detail: "No hand-out row addresses this account; the person has no credentials from this hand-out",
      }))
      .sort((a, b) => (a.Active === b.Active ? a.Name.localeCompare(b.Name) : a.Active === "Yes" ? -1 : 1))

    const summary = [
      { Metric: "Hand-out rows", Value: handout.length },
      { Metric: "Can sign in now", Value: counts.OK },
      ...Object.entries(counts).filter(([k]) => k !== "OK").map(([k, v]) => ({ Metric: `Cannot sign in — ${k}`, Value: v })),
      { Metric: "Active accounts with no hand-out row", Value: notInHandout.filter((a) => a.Active === "Yes").length },
      { Metric: "Inactive accounts with no hand-out row", Value: notInHandout.filter((a) => a.Active === "No").length },
      { Metric: "Checked at", Value: new Date().toISOString() },
      { Metric: "Organization", Value: `${org.id}:${org.code}:${org.name}` },
    ]

    const output = resolve(arg("--output") ?? "deliverables/handout-login-status.xlsx")
    mkdirSync(dirname(output), { recursive: true })
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(summary)), "Summary")
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
      problems.length > 0 ? problems : [{ Result: "Every hand-out row can sign in" }])), "Cannot sign in")
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords<Record<string, unknown>>(
      notInHandout.length > 0 ? notInHandout : [{ Result: "Every account has a hand-out row" }])), "Not in handout")
    XLSX.writeFile(book, output)

    console.log(JSON.stringify({ output, organization: `${org.id}:${org.code}:${org.name}`, handoutRows: handout.length, ...counts,
      notInHandout: notInHandout.length }, null, 2))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})

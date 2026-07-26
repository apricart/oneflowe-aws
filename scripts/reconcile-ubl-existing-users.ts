#!/usr/bin/env tsx

import * as dotenv from "dotenv"
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { extname, resolve } from "node:path"
import * as XLSX from "xlsx"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { and, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm"

import { generateImportPassword, hashImportPassword } from "../lib/password-cli"
import {
  normalizeImportKey,
  normalizePhoneKey,
  parseUserImportRecords,
  resolveImportBranch,
  type ParsedUserImportRow,
} from "../lib/user-import"

dotenv.config({ path: ".env.local" })
dotenv.config()

const ORG_CODE = "UBL_123A"
const TARGET_ROWS = new Set([2, 3, 4, 5, 6])
const CONFIRMATION = "RESET_UBL_EXISTING_5"

type Options = {
  file: string
  overrides: string
  credentialSource: string
  credentialOutput: string
  insert: boolean
  confirmation?: string
}

type BranchRow = { id: number; name: string; code: string | null; status: string | null }
type RoleRow = { id: number; name: string }
type ExistingRow = {
  id: string
  email: string
  username: string | null
  organizationId: number | null
  sessionVersion: number
}

function getArgValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function options(argv: string[]): Options {
  const file = getArgValue(argv, "--file")
  const overrides = getArgValue(argv, "--overrides")
  const credentialSource = getArgValue(argv, "--credentials-source")
  const credentialOutput = getArgValue(argv, "--credentials-output")
  if (!file || !overrides || !credentialSource || !credentialOutput) {
    throw new Error("--file, --overrides, --credentials-source, and --credentials-output are required.")
  }
  return {
    file: resolve(file),
    overrides: resolve(overrides),
    credentialSource: resolve(credentialSource),
    credentialOutput: resolve(credentialOutput),
    insert: argv.includes("--insert"),
    confirmation: getArgValue(argv, "--confirm"),
  }
}

function readImportRows(file: string, usernameFormat: "explicit" | "first.last"): ParsedUserImportRow[] {
  if (!existsSync(file)) throw new Error(`Workbook not found: ${file}`)
  if (statSync(file).size > 10 * 1024 * 1024) throw new Error("Workbook exceeds the 10MB limit.")
  const workbook = XLSX.readFile(file, { cellDates: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) throw new Error("Workbook has no sheets.")
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName], {
    defval: "",
    raw: false,
  })
  if (records.length > 5000) throw new Error("Workbook exceeds the 5,000-row limit.")
  return parseUserImportRecords(records, { usernameFormat })
}

function readCredentialRows(file: string): Array<Record<string, string | number>> {
  if (!existsSync(file)) throw new Error(`Credential source not found: ${file}`)
  if (statSync(file).size > 10 * 1024 * 1024) throw new Error("Credential workbook exceeds the 10MB limit.")
  const workbook = XLSX.readFile(file)
  const sheet = workbook.Sheets.Credentials
  if (!sheet) throw new Error("Credential source has no Credentials sheet.")
  const rows = XLSX.utils.sheet_to_json<Record<string, string | number>>(sheet, { defval: "", raw: false })
  if (rows.length > 5000) throw new Error("Credential workbook exceeds the 5,000-row limit.")
  return rows
}

function createCredentialWorkbook(rows: Array<Record<string, string | number>>): Buffer {
  const sheet = XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(rows))
  sheet["!cols"] = [
    { wch: 14 }, { wch: 28 }, { wch: 34 }, { wch: 28 },
    { wch: 28 }, { wch: 18 }, { wch: 36 }, { wch: 26 },
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, "Credentials")
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
}

async function main(): Promise<void> {
  const input = options(process.argv.slice(2))
  if (input.insert && input.confirmation !== CONFIRMATION) {
    throw new Error(`Refusing reset: --confirm must exactly equal ${CONFIRMATION}.`)
  }
  if (extname(input.credentialOutput).toLowerCase() !== ".xlsx") {
    throw new Error("Credential output must be an .xlsx file.")
  }
  if (existsSync(input.credentialOutput)) {
    throw new Error(`Credential output already exists: ${input.credentialOutput}`)
  }

  const config = JSON.parse(readFileSync(input.overrides, "utf8")) as {
    organization: string
    branchOverrides: Record<string, string>
    usernameFormat: "explicit" | "first.last"
  }
  if (config.organization !== ORG_CODE || config.usernameFormat !== "first.last") {
    throw new Error("Override config must be bound to UBL_123A with usernameFormat=first.last.")
  }

  const workbookRows = readImportRows(input.file, config.usernameFormat)
  const blockingWorkbookRows = workbookRows.filter((row) => row.issues.some((item) => item.severity === "error"))
  if (blockingWorkbookRows.length > 0) {
    throw new Error(`Workbook has blocking errors on rows ${blockingWorkbookRows.map((row) => row.rowNumber).join(", ")}.`)
  }
  const targets = workbookRows.filter((row) => TARGET_ROWS.has(row.rowNumber))
  if (targets.length !== TARGET_ROWS.size) throw new Error("Expected exactly workbook rows 2 through 6.")

  const sourceCredentials = readCredentialRows(input.credentialSource)
  const sourceCredentialByRow = new Map(sourceCredentials.map((row) => [Number(row["Workbook Row"]), row]))
  const expectedPreservedRows = workbookRows.filter((row) => !TARGET_ROWS.has(row.rowNumber))
  if (
    sourceCredentials.length !== expectedPreservedRows.length
    || expectedPreservedRows.some((row) => !sourceCredentialByRow.has(row.rowNumber))
  ) {
    throw new Error("Credential source does not contain exactly the 18 previously imported workbook rows.")
  }

  const { db, closePool } = await import("../lib/db-cli")
  const { organizations, branches, roles, users, employeeCredentials, systemLogs } = await import("../db/schema")
  let credentialFileCreated = false

  try {
    const [organization] = await db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code, status: organizations.status })
      .from(organizations)
      .where(eq(organizations.code, ORG_CODE))
      .limit(1)
    if (!organization || normalizeImportKey(organization.status) !== "active") {
      throw new Error("Active UBL_123A organization not found.")
    }

    const [organizationBranches, databaseRoles] = await Promise.all([
      db
        .select({ id: branches.id, name: branches.name, code: branches.code, status: branches.status })
        .from(branches)
        .where(eq(branches.organizationId, organization.id)),
      db.select({ id: roles.id, name: roles.name }).from(roles),
    ])
    const roleByName = new Map(databaseRoles.map((role: RoleRow) => [role.name, role]))
    const branchByRow = new Map<number, BranchRow | null>()
    for (const row of targets) {
      if (!row.role || !roleByName.has(row.role)) throw new Error(`Role resolution failed for row ${row.rowNumber}.`)
      if (row.role === "HEAD_OFFICE") {
        branchByRow.set(row.rowNumber, null)
        continue
      }
      const { branch } = resolveImportBranch(row.branchSource, organizationBranches, config.branchOverrides)
      if (!branch || normalizeImportKey(branch.status) !== "active") {
        throw new Error(`Active branch resolution failed for row ${row.rowNumber}.`)
      }
      branchByRow.set(row.rowNumber, branch)
    }

    const targetEmails = targets.map((row) => normalizeImportKey(row.email))
    const existingRows: ExistingRow[] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        organizationId: users.organizationId,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(and(
        eq(users.organizationId, organization.id),
        isNull(users.deletedAt),
        inArray(sql<string>`lower(trim(${users.email}))`, targetEmails),
      ))
    if (existingRows.length !== targets.length) {
      throw new Error(`Expected five existing UBL users; found ${existingRows.length}.`)
    }
    const existingByEmail = new Map(existingRows.map((row) => [normalizeImportKey(row.email), row]))
    if (targets.some((row) => !existingByEmail.has(normalizeImportKey(row.email)))) {
      throw new Error("Existing users do not map one-to-one to workbook rows 2 through 6.")
    }

    const targetIds = existingRows.map((row) => row.id)
    const usernames = targets.map((row) => normalizeImportKey(row.username))
    const phones = targets.map((row) => normalizePhoneKey(row.phone)).filter(Boolean)
    const employeeIds = targets.map((row) => normalizeImportKey(row.employeeId)).filter(Boolean)
    const conflictConditions: SQL[] = [
      inArray(sql<string>`lower(trim(coalesce(${users.username}, '')))`, usernames),
      inArray(sql<string>`lower(trim(${users.email}))`, targetEmails),
    ]
    if (phones.length > 0) {
      conflictConditions.push(inArray(sql<string>`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g')`, phones))
    }
    if (employeeIds.length > 0) {
      conflictConditions.push(inArray(sql<string>`lower(trim(coalesce(${users.employeeId}, '')))`, employeeIds))
    }
    const outsideConflicts = await db
      .select({ id: users.id })
      .from(users)
      .where(and(isNull(users.deletedAt), notInArray(users.id, targetIds), or(...conflictConditions)))
    const credentialConflicts = await db
      .select({ id: employeeCredentials.id })
      .from(employeeCredentials)
      .where(or(
        inArray(sql<string>`lower(trim(coalesce(${employeeCredentials.username}, '')))`, usernames),
        inArray(sql<string>`lower(trim(${employeeCredentials.email}))`, targetEmails),
      ))
    if (outsideConflicts.length > 0 || credentialConflicts.length > 0) {
      throw new Error("A proposed workbook identity conflicts with another account; no users were changed.")
    }

    console.log(JSON.stringify({
      mode: input.insert ? "insert" : "dry-run",
      targetUsers: targets.length,
      preservedCredentialRows: sourceCredentials.length,
      outsideConflicts: outsideConflicts.length,
      legacyCredentialConflicts: credentialConflicts.length,
      emailsToSend: 0,
    }, null, 2))
    if (!input.insert) return

    const resets = await Promise.all(targets.map(async (row) => {
      const temporaryPassword = generateImportPassword(20)
      return {
        row,
        existing: existingByEmail.get(normalizeImportKey(row.email))!,
        branch: branchByRow.get(row.rowNumber) ?? null,
        role: roleByName.get(row.role!)!,
        temporaryPassword,
        passwordHash: await hashImportPassword(temporaryPassword),
      }
    }))
    const resetByRow = new Map(resets.map((item) => [item.row.rowNumber, item]))

    const allCredentialRows = workbookRows.map((row) => {
      const reset = resetByRow.get(row.rowNumber)
      const preserved = sourceCredentialByRow.get(row.rowNumber)
      const temporaryPassword = reset?.temporaryPassword ?? String(preserved?.["Temporary Password"] ?? "")
      if (!temporaryPassword) throw new Error(`Temporary password missing for workbook row ${row.rowNumber}.`)
      const branch = reset?.branch
      return {
        "Workbook Row": row.rowNumber,
        "Full Name": row.fullName,
        "Email": row.email,
        "Username": row.username,
        "Temporary Password": temporaryPassword,
        "Role": row.role ?? "",
        "Branch": row.role === "HEAD_OFFICE"
          ? "Head Office"
          : branch?.name ?? String(preserved?.["Branch"] ?? ""),
        "Password Change Required": "Yes",
      }
    })

    writeFileSync(input.credentialOutput, createCredentialWorkbook(allCredentialRows), { flag: "wx", mode: 0o600 })
    credentialFileCreated = true

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('oneflowe:user-import'))`)
        for (const item of resets) {
          const [updated] = await tx
            .update(users)
            .set({
              email: item.row.email,
              username: item.row.username,
              passwordHash: item.passwordHash,
              roleId: item.role.id,
              isActive: true,
              fullName: item.row.fullName,
              firstName: item.row.firstName,
              lastName: item.row.lastName,
              phone: item.row.phone,
              employeeId: item.row.employeeId,
              organizationId: organization.id,
              branchId: item.row.role === "HEAD_OFFICE" ? null : item.branch?.id ?? null,
              location: item.row.branchSource || null,
              address: item.row.address,
              mustChangePassword: true,
              sessionVersion: sql`${users.sessionVersion} + 1`,
              updatedAt: new Date(),
            })
            .where(and(
              eq(users.id, item.existing.id),
              eq(users.sessionVersion, item.existing.sessionVersion),
            ))
            .returning({ id: users.id })
          if (!updated) throw new Error(`User changed concurrently for workbook row ${item.row.rowNumber}.`)

          await tx.insert(systemLogs).values({
            userRole: "SYSTEM",
            organizationId: organization.id,
            branchId: item.row.role === "HEAD_OFFICE" ? null : item.branch?.id ?? null,
            action: "USER_BULK_RECONCILE",
            resourceType: "user",
            resourceId: updated.id,
            details: {
              sourceFile: input.file.split(/[\\/]/).at(-1),
              sourceRow: item.row.rowNumber,
              passwordReset: true,
              reconciledToWorkbook: true,
            },
            success: true,
          })
        }
      }, { isolationLevel: "serializable" })
    } catch (error) {
      if (credentialFileCreated) {
        try { unlinkSync(input.credentialOutput) } catch { /* preserve original error */ }
      }
      throw error
    }

    console.log(JSON.stringify({
      reconciledUsers: resets.length,
      credentialRows: allCredentialRows.length,
      credentialOutput: input.credentialOutput,
      emailsSent: 0,
    }, null, 2))
  } finally {
    await closePool()
  }
}

main().catch((error) => {
  console.error(`Reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

#!/usr/bin/env tsx
/**
 * Organization-agnostic user import for CSV/XLS/XLSX files.
 *
 * Dry run (default):
 *   npx tsx scripts/import-users-csv.ts --file users.xlsx --organization ORG_CODE
 *
 * Live import with generated one-time passwords:
 *   npx tsx scripts/import-users-csv.ts --file users.xlsx --organization ORG_CODE \
 *     --overrides config/user-import-overrides.example.json \
 *     --generate-passwords --send-welcome --insert --confirm ORG_CODE
 */

import * as dotenv from "dotenv"
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs"
import { basename, dirname, extname, resolve } from "path"
import * as XLSX from "xlsx"
import { sanitizeSpreadsheetRecords } from "../lib/spreadsheet"
import { inArray, or, sql, type SQL } from "drizzle-orm"
import {
  normalizeImportKey,
  normalizeImportText,
  normalizePhoneKey,
  parseUserImportRecords,
  resolveImportBranch,
  type ImportableUserRole,
  type ParsedUserImportRow,
  type UserImportIssue,
  type UserImportRecord,
  type UserImportUsernameFormat,
} from "../lib/user-import"
import { generateImportPassword, hashImportPassword } from "../lib/password-cli"

dotenv.config({ path: ".env.local" })
dotenv.config()

type Options = {
  file: string
  organization: string
  sheet?: string
  overrides?: string
  insert: boolean
  confirmation?: string
  generatePasswords: boolean
  sendWelcome: boolean
  credentialsOutput?: string
}

type OrganizationRow = {
  id: number
  name: string
  code: string | null
  status: string | null
}

type BranchRow = {
  id: number
  name: string
  code: string | null
  status: string | null
}

type RoleRow = {
  id: number
  name: string
}

type ExistingUserRow = {
  id: string
  email: string
  username: string | null
  phone: string | null
  employeeId: string | null
  fullName: string | null
  firstName: string | null
  lastName: string | null
  organizationId: number | null
  branchId: number | null
  roleId: number
  address: string | null
  isActive: boolean
  deletedAt: Date | null
}

type ExistingCredentialRow = {
  id: number
  email: string
  username: string | null
  organizationId: number
  branchId: number
}

type ExistingAccounts = {
  users: ExistingUserRow[]
  credentials: ExistingCredentialRow[]
}

type OverrideConfig = {
  organization: string | number
  branchOverrides: Record<string, string>
  allowedEmailDomains: string[]
  usernameFormat: UserImportUsernameFormat
}

type ClassifiedRow = {
  row: ParsedUserImportRow
  branch: BranchRow | null
  state: "ready" | "existing" | "blocked"
  existingUser?: ExistingUserRow
  issues: UserImportIssue[]
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/import-users-csv.ts --file <csv|xls|xlsx> --organization <id|code|name> [options]",
    "",
    "Options:",
    "  --sheet <name>           Workbook sheet (defaults to first sheet)",
    "  --overrides <json>       Organization-bound branch name overrides",
    "  --generate-passwords     Generate secure passwords for rows without Password",
    "  --send-welcome           Email usernames and temporary passwords after commit",
    "  --credentials-output     Write an XLSX credential handoff file instead of emailing",
    "  --insert                 Commit rows that pass preflight (dry run is default)",
    "  --confirm <org-code>     Required with --insert; must exactly match the org code",
    "  --help                   Show this help",
  ].join("\n")
}

function getArgValue(argv: string[], name: string): string | undefined {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function parseOptions(argv: string[]): Options | null {
  if (argv.includes("--help") || argv.includes("-h")) return null
  const file = getArgValue(argv, "--file")
  const organization = getArgValue(argv, "--organization")
  if (!file || !organization) throw new Error("--file and --organization are required.\n\n" + usage())
  return {
    file: resolve(file),
    organization: normalizeImportText(organization),
    sheet: getArgValue(argv, "--sheet"),
    overrides: getArgValue(argv, "--overrides"),
    insert: argv.includes("--insert"),
    confirmation: getArgValue(argv, "--confirm"),
    generatePasswords: argv.includes("--generate-passwords"),
    sendWelcome: argv.includes("--send-welcome"),
    credentialsOutput: getArgValue(argv, "--credentials-output"),
  }
}

function credentialsWorkbook(items: Array<{
  row: ParsedUserImportRow
  branch: BranchRow | null
  temporaryPassword: string
}>): Buffer {
  const sheet = XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(items.map((item) => ({
    "Workbook Row": item.row.rowNumber,
    "Full Name": item.row.fullName,
    "Email": item.row.email,
    "Username": item.row.username,
    "Temporary Password": item.temporaryPassword,
    "Role": item.row.role,
    "Branch": item.row.role === "HEAD_OFFICE" ? "Head Office" : item.branch?.name ?? "",
    "Password Change Required": "Yes",
  }))))
  sheet["!cols"] = [
    { wch: 14 }, { wch: 28 }, { wch: 34 }, { wch: 28 },
    { wch: 28 }, { wch: 18 }, { wch: 36 }, { wch: 26 },
  ]
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, "Credentials")
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
}

function loadRecords(filePath: string, requestedSheet?: string): { records: UserImportRecord[]; sheetName: string } {
  if (!existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`)
  if (statSync(filePath).size > 10 * 1024 * 1024) {
    throw new Error("User import file exceeds the 10MB limit.")
  }
  const extension = extname(filePath).toLowerCase()
  if (![".csv", ".xls", ".xlsx"].includes(extension)) {
    throw new Error(`Unsupported input type "${extension}". Use CSV, XLS, or XLSX.`)
  }

  const workbook = XLSX.readFile(filePath, { cellDates: false })
  const sheetName = requestedSheet || workbook.SheetNames[0]
  if (!sheetName || !workbook.Sheets[sheetName]) {
    throw new Error(`Sheet "${requestedSheet}" was not found. Available sheets: ${workbook.SheetNames.join(", ")}`)
  }
  const records = XLSX.utils.sheet_to_json<UserImportRecord>(workbook.Sheets[sheetName], {
    defval: "",
    raw: false,
  })
  if (records.length > 5000) throw new Error("User import exceeds the 5,000-row limit.")
  return { records, sheetName }
}

function loadOverrides(filePath?: string): OverrideConfig | null {
  if (!filePath) return null
  const resolvedPath = resolve(filePath)
  if (!existsSync(resolvedPath)) throw new Error(`Override file not found: ${resolvedPath}`)
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as Partial<OverrideConfig>
  if ((typeof parsed.organization !== "string" && typeof parsed.organization !== "number") || !parsed.branchOverrides) {
    throw new Error("Override JSON must contain organization and branchOverrides.")
  }
  if (typeof parsed.branchOverrides !== "object" || Array.isArray(parsed.branchOverrides)) {
    throw new Error("branchOverrides must be an object of source-name to database-name mappings.")
  }
  for (const [source, target] of Object.entries(parsed.branchOverrides)) {
    if (!normalizeImportText(source) || typeof target !== "string" || !normalizeImportText(target)) {
      throw new Error("Every branch override must map a non-empty source name to a non-empty database branch name.")
    }
  }
  const rawDomains = (parsed as Partial<OverrideConfig>).allowedEmailDomains ?? []
  if (!Array.isArray(rawDomains) || rawDomains.some((domain) => typeof domain !== "string" || !normalizeImportText(domain))) {
    throw new Error("allowedEmailDomains must be an array of domain names when provided.")
  }
  const usernameFormat = (parsed as Partial<OverrideConfig>).usernameFormat ?? "explicit"
  if (usernameFormat !== "explicit" && usernameFormat !== "first.last") {
    throw new Error("usernameFormat must be either explicit or first.last.")
  }
  return {
    organization: parsed.organization,
    branchOverrides: parsed.branchOverrides as Record<string, string>,
    allowedEmailDomains: rawDomains.map((domain) => normalizeImportKey(domain).replace(/^@/, "")),
    usernameFormat,
  }
}

function makeIssue(
  severity: UserImportIssue["severity"],
  code: string,
  rowNumber: number,
  message: string,
  field?: string,
): UserImportIssue {
  return { severity, code, rowNumber, message, field }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

async function findExistingAccounts(connection: any, importRows: ParsedUserImportRow[]): Promise<ExistingAccounts> {
  if (importRows.length === 0) return { users: [], credentials: [] }
  const { users, employeeCredentials } = await import("../db/schema")
  const emails = unique(importRows.map((row) => normalizeImportKey(row.email)))
  const usernames = unique(importRows.map((row) => normalizeImportKey(row.username)))
  const phones = unique(importRows.map((row) => normalizePhoneKey(row.phone)))
  const employeeIds = unique(importRows.map((row) => normalizeImportKey(row.employeeId)))

  const userConditions: SQL[] = [
    inArray(sql<string>`lower(trim(${users.email}))`, emails),
    inArray(sql<string>`lower(trim(coalesce(${users.username}, '')))`, usernames),
  ]
  if (phones.length > 0) {
    userConditions.push(inArray(sql<string>`regexp_replace(coalesce(${users.phone}, ''), '[^0-9]', '', 'g')`, phones))
  }
  if (employeeIds.length > 0) {
    userConditions.push(inArray(sql<string>`lower(trim(coalesce(${users.employeeId}, '')))`, employeeIds))
  }

  const credentialConditions: SQL[] = [
    inArray(sql<string>`lower(trim(${employeeCredentials.email}))`, emails),
    inArray(sql<string>`lower(trim(coalesce(${employeeCredentials.username}, '')))`, usernames),
  ]

  const [foundUsers, foundCredentials] = await Promise.all([
    connection
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        phone: users.phone,
        employeeId: users.employeeId,
        fullName: users.fullName,
        firstName: users.firstName,
        lastName: users.lastName,
        organizationId: users.organizationId,
        branchId: users.branchId,
        roleId: users.roleId,
        address: users.address,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(or(...userConditions)),
    connection
      .select({
        id: employeeCredentials.id,
        email: employeeCredentials.email,
        username: employeeCredentials.username,
        organizationId: employeeCredentials.organizationId,
        branchId: employeeCredentials.branchId,
      })
      .from(employeeCredentials)
      .where(or(...credentialConditions)),
  ])

  return { users: foundUsers, credentials: foundCredentials }
}

function userMatchFields(existing: ExistingUserRow, row: ParsedUserImportRow): string[] {
  const fields: string[] = []
  if (normalizeImportKey(existing.username) === normalizeImportKey(row.username)) fields.push("username")
  if (existing.deletedAt) return fields
  if (normalizeImportKey(existing.email) === normalizeImportKey(row.email)) fields.push("email")
  if (row.phone && normalizePhoneKey(existing.phone) === normalizePhoneKey(row.phone)) fields.push("phone")
  if (row.employeeId && normalizeImportKey(existing.employeeId) === normalizeImportKey(row.employeeId)) fields.push("employeeId")
  return fields
}

function credentialMatchFields(existing: ExistingCredentialRow, row: ParsedUserImportRow): string[] {
  const fields: string[] = []
  if (normalizeImportKey(existing.username) === normalizeImportKey(row.username)) fields.push("username")
  if (normalizeImportKey(existing.email) === normalizeImportKey(row.email)) fields.push("email")
  return fields
}

function existingNameMatches(existing: ExistingUserRow, row: ParsedUserImportRow): boolean {
  const candidates = [existing.fullName, `${existing.firstName ?? ""} ${existing.lastName ?? ""}`]
  return candidates.some((candidate) => normalizeImportKey(candidate) === normalizeImportKey(row.fullName))
}

function classifyRows(args: {
  rows: ParsedUserImportRow[]
  organization: OrganizationRow
  branches: BranchRow[]
  roles: RoleRow[]
  branchOverrides: Record<string, string>
  allowedEmailDomains: string[]
  accounts: ExistingAccounts
  generatePasswords: boolean
}): ClassifiedRow[] {
  const roleByName = new Map(args.roles.map((role) => [role.name, role]))

  return args.rows.map((row) => {
    const issues = [...row.issues]
    let branch: BranchRow | null = null
    if (row.role === "BRANCH_ADMIN" || row.role === "ORDER_PORTAL") {
      const resolved = resolveImportBranch(row.branchSource, args.branches, args.branchOverrides)
      branch = resolved.branch
      if (!branch) {
        issues.push(makeIssue(
          "error",
          "BRANCH_NOT_FOUND",
          row.rowNumber,
          `Branch/department "${row.branchSource}" does not exactly match a branch in ${args.organization.name}. Add an explicit override if the names intentionally differ.`,
          "branch",
        ))
      } else if (normalizeImportKey(branch.status) !== "active") {
        issues.push(makeIssue("error", "BRANCH_NOT_ACTIVE", row.rowNumber, `Branch "${branch.name}" is not active.`, "branch"))
      } else if (resolved.overriddenName) {
        issues.push(makeIssue(
          "warning",
          "BRANCH_OVERRIDE_APPLIED",
          row.rowNumber,
          `Branch override mapped "${row.branchSource}" to "${branch.name}".`,
          "branch",
        ))
      }
    }
    if (row.role && !roleByName.has(row.role)) {
      issues.push(makeIssue("error", "ROLE_NOT_IN_DATABASE", row.rowNumber, `Role ${row.role} is not present in the database.`, "role"))
    }
    if (args.allowedEmailDomains.length > 0) {
      const emailDomain = normalizeImportKey(row.email.split("@").at(-1))
      if (!args.allowedEmailDomains.includes(emailDomain)) {
        issues.push(makeIssue(
          "error",
          "EMAIL_DOMAIN_NOT_ALLOWED",
          row.rowNumber,
          `Email domain is not in the organization-bound allowlist (${args.allowedEmailDomains.join(", ")}).`,
          "email",
        ))
      }
    }
    const matchingUsers = args.accounts.users
      .map((existing) => ({ existing, fields: userMatchFields(existing, row) }))
      .filter((match) => match.fields.length > 0)
    const matchingCredentials = args.accounts.credentials
      .map((existing) => ({ existing, fields: credentialMatchFields(existing, row) }))
      .filter((match) => match.fields.length > 0)

    const soleMatch = matchingUsers.length === 1 ? matchingUsers[0] : null
    const isSameExistingUser = !!soleMatch
      && !soleMatch.existing.deletedAt
      && soleMatch.existing.organizationId === args.organization.id
      && existingNameMatches(soleMatch.existing, row)
      && (soleMatch.fields.includes("email") || soleMatch.fields.includes("employeeId"))
      && matchingCredentials.length === 0

    if (isSameExistingUser && soleMatch) {
      const existing = soleMatch.existing
      issues.push(makeIssue("warning", "ALREADY_EXISTS", row.rowNumber, "A matching active user already exists in this organization; the importer will not update or duplicate it."))
      if (normalizeImportKey(existing.username) !== normalizeImportKey(row.username)) {
        issues.push(makeIssue("warning", "EXISTING_USERNAME_DIFFERS", row.rowNumber, "Existing username differs from the imported/derived username."))
      }
      if (row.role && existing.roleId !== roleByName.get(row.role)?.id) {
        issues.push(makeIssue("warning", "EXISTING_ROLE_DIFFERS", row.rowNumber, "Existing role differs from the workbook role."))
      }
      const expectedBranchId = row.role === "HEAD_OFFICE" ? null : branch?.id ?? null
      if (existing.branchId !== expectedBranchId) {
        issues.push(makeIssue("warning", "EXISTING_BRANCH_DIFFERS", row.rowNumber, "Existing branch differs from the resolved workbook branch."))
      }
      if (normalizeImportKey(existing.email) !== normalizeImportKey(row.email)) {
        issues.push(makeIssue("warning", "EXISTING_EMAIL_DIFFERS", row.rowNumber, "Existing email differs from the workbook email."))
      }
      if (row.phone && normalizePhoneKey(existing.phone) !== normalizePhoneKey(row.phone)) {
        issues.push(makeIssue("warning", "EXISTING_PHONE_DIFFERS", row.rowNumber, "Existing phone differs from the workbook phone."))
      }
      if (row.employeeId && normalizeImportKey(existing.employeeId) !== normalizeImportKey(row.employeeId)) {
        issues.push(makeIssue("warning", "EXISTING_EMPLOYEE_ID_DIFFERS", row.rowNumber, "Existing employee ID differs from the workbook employee ID."))
      }
      if (row.address && normalizeImportKey(existing.address) !== normalizeImportKey(row.address)) {
        issues.push(makeIssue("warning", "EXISTING_ADDRESS_DIFFERS", row.rowNumber, "Existing address differs from the workbook address."))
      }
      if (existing.isActive !== row.isActive) {
        issues.push(makeIssue("warning", "EXISTING_STATUS_DIFFERS", row.rowNumber, "Existing activation status differs from the workbook status."))
      }
      return { row, branch, state: "existing", existingUser: existing, issues }
    }

    if (matchingUsers.length > 0) {
      const fields = unique(matchingUsers.flatMap((match) => match.fields)).join(", ")
      issues.push(makeIssue("error", "USER_IDENTITY_CONFLICT", row.rowNumber, `An existing user conflicts on: ${fields}.`))
    }
    if (matchingCredentials.length > 0) {
      const fields = unique(matchingCredentials.flatMap((match) => match.fields)).join(", ")
      issues.push(makeIssue("error", "EMPLOYEE_CREDENTIAL_CONFLICT", row.rowNumber, `Legacy employee credentials conflict on: ${fields}.`))
    }
    if (!row.password && !args.generatePasswords) {
      issues.push(makeIssue(
        "error",
        "MISSING_PASSWORD",
        row.rowNumber,
        "Password is blank. Supply a compliant Password or use --generate-passwords.",
        "password",
      ))
    }

    const state = issues.some((item) => item.severity === "error") ? "blocked" : "ready"
    return { row, branch, state, issues }
  })
}

function assertOverrideOrganization(config: OverrideConfig | null, organization: OrganizationRow): void {
  if (!config) return
  const expected = normalizeImportKey(config.organization)
  const permitted = [String(organization.id), organization.name, organization.code ?? ""].map(normalizeImportKey)
  if (!permitted.includes(expected)) {
    throw new Error(
      `Override file is bound to organization "${config.organization}" and cannot be used for ${organization.name} (${organization.code ?? organization.id}).`,
    )
  }
}

function printPreflight(args: {
  options: Options
  organization: OrganizationRow
  sheetName: string
  classified: ClassifiedRow[]
}): void {
  const ready = args.classified.filter((item) => item.state === "ready")
  const existing = args.classified.filter((item) => item.state === "existing")
  const blocked = args.classified.filter((item) => item.state === "blocked")
  const issueGroups = new Map<string, { severity: string; code: string; message: string; rows: number[] }>()

  for (const item of args.classified) {
    for (const found of item.issues) {
      const key = `${found.severity}:${found.code}:${found.message}`
      const group = issueGroups.get(key) ?? { severity: found.severity, code: found.code, message: found.message, rows: [] }
      group.rows.push(found.rowNumber)
      issueGroups.set(key, group)
    }
  }

  const branchMappings = new Map<string, { workbook: string; database: string; rows: number[] }>()
  for (const item of args.classified) {
    if (item.row.role !== "BRANCH_ADMIN" && item.row.role !== "ORDER_PORTAL") continue
    const key = normalizeImportKey(item.row.branchSource)
    const mapping = branchMappings.get(key) ?? {
      workbook: item.row.branchSource,
      database: item.branch?.name ?? "NOT FOUND",
      rows: [],
    }
    mapping.rows.push(item.row.rowNumber)
    branchMappings.set(key, mapping)
  }

  console.log("\n============================================================")
  console.log(` User Import - ${args.options.insert ? "LIVE MODE" : "DRY RUN (no writes)"}`)
  console.log("============================================================")
  console.log(` File          : ${args.options.file}`)
  console.log(` Sheet         : ${args.sheetName}`)
  console.log(` Organization  : ${args.organization.name} (id=${args.organization.id}, code=${args.organization.code ?? "n/a"})`)
  console.log(` Workbook rows : ${args.classified.length}`)
  console.log(` Ready to add  : ${ready.length}`)
  console.log(` Already exist : ${existing.length}`)
  console.log(` Blocked       : ${blocked.length}`)

  console.log("\nBranch resolution:")
  console.table([...branchMappings.values()].map((mapping) => ({
    workbook: mapping.workbook,
    database: mapping.database,
    rows: mapping.rows.join(", "),
  })))

  if (issueGroups.size > 0) {
    console.log("\nPreflight findings (personal values are intentionally omitted):")
    for (const group of [...issueGroups.values()].sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1
      return a.code.localeCompare(b.code)
    })) {
      console.log(` ${group.severity === "error" ? "ERROR" : "WARN "} ${group.code} [rows ${unique(group.rows.map(String)).join(", ")}]: ${group.message}`)
    }
  }

  console.log("\nSummary:")
  console.log(` Ready rows    : ${ready.map((item) => item.row.rowNumber).join(", ") || "none"}`)
  console.log(` Existing rows : ${existing.map((item) => item.row.rowNumber).join(", ") || "none"}`)
  console.log(` Blocked rows  : ${blocked.map((item) => item.row.rowNumber).join(", ") || "none"}`)
  if (!args.options.insert) console.log("\nNothing was written to the database.")
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return
  }

  const { records, sheetName } = loadRecords(options.file, options.sheet)
  const overrideConfig = loadOverrides(options.overrides)
  const parsedRows = parseUserImportRecords(records, {
    usernameFormat: overrideConfig?.usernameFormat ?? "explicit",
  })
  if (parsedRows.length === 0) throw new Error("The selected sheet contains no user rows.")

  const { db, closePool } = await import("../lib/db-cli")
  const { organizations, branches, roles, users, systemLogs } = await import("../db/schema")

  try {
    const selector = normalizeImportKey(options.organization)
    const organizationConditions: SQL[] = [
      sql`lower(trim(${organizations.name})) = ${selector}`,
      sql`lower(trim(coalesce(${organizations.code}, ''))) = ${selector}`,
    ]
    if (/^\d+$/.test(selector)) organizationConditions.push(sql`${organizations.id} = ${Number(selector)}`)
    const matchingOrganizations = await db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code, status: organizations.status })
      .from(organizations)
      .where(or(...organizationConditions))

    if (matchingOrganizations.length !== 1) {
      throw new Error(`Organization selector "${options.organization}" matched ${matchingOrganizations.length} organizations; expected exactly one.`)
    }
    const organization = matchingOrganizations[0]
    if (normalizeImportKey(organization.status) !== "active") {
      throw new Error(`Organization ${organization.name} is not active.`)
    }
    assertOverrideOrganization(overrideConfig, organization)

    const [organizationBranches, databaseRoles, accounts] = await Promise.all([
      db
        .select({ id: branches.id, name: branches.name, code: branches.code, status: branches.status })
        .from(branches)
        .where(sql`${branches.organizationId} = ${organization.id}`),
      db.select({ id: roles.id, name: roles.name }).from(roles),
      findExistingAccounts(db, parsedRows),
    ])

    const classified = classifyRows({
      rows: parsedRows,
      organization,
      branches: organizationBranches,
      roles: databaseRoles,
      branchOverrides: overrideConfig?.branchOverrides ?? {},
      allowedEmailDomains: overrideConfig?.allowedEmailDomains ?? [],
      accounts,
      generatePasswords: options.generatePasswords,
    })
    printPreflight({ options, organization, sheetName, classified })

    const blocked = classified.filter((item) => item.state === "blocked")
    const ready = classified.filter((item) => item.state === "ready")
    if (!options.insert) return
    if (blocked.length > 0) throw new Error(`Live import refused: ${blocked.length} workbook rows have blocking errors.`)
    if (ready.length === 0) {
      console.log("\nNo new users need to be inserted.")
      return
    }

    const confirmationToken = organization.code ?? String(organization.id)
    if (options.confirmation !== confirmationToken) {
      throw new Error(`Live import refused: --confirm must exactly equal "${confirmationToken}".`)
    }
    if (ready.some((item) => !item.row.password) && !options.generatePasswords) {
      throw new Error("Live import refused: some new rows have no password.")
    }
    if (options.sendWelcome && options.credentialsOutput) {
      throw new Error("Live import refused: choose either --send-welcome or --credentials-output, not both.")
    }
    if (ready.some((item) => !item.row.password) && !options.sendWelcome && !options.credentialsOutput) {
      throw new Error("Live import refused: generated passwords require either --send-welcome or --credentials-output.")
    }

    if (options.sendWelcome) {
      const { verifyUserImportEmailConfig } = await import("../lib/email/user-import-cli")
      if (!verifyUserImportEmailConfig()) {
        throw new Error("Live import refused: welcome-email configuration is not valid.")
      }
    }

    const prepared = await Promise.all(ready.map(async (item) => {
      const temporaryPassword = item.row.password ?? generateImportPassword(20)
      return { ...item, temporaryPassword, passwordHash: await hashImportPassword(temporaryPassword) }
    }))
    const roleByName = new Map(databaseRoles.map((role) => [role.name, role]))
    const created: Array<{ id: string; rowNumber: number; email: string; firstName: string; username: string; temporaryPassword: string }> = []
    const credentialsPath = options.credentialsOutput ? resolve(options.credentialsOutput) : null
    let credentialsFileCreated = false

    if (credentialsPath) {
      if (extname(credentialsPath).toLowerCase() !== ".xlsx") {
        throw new Error("--credentials-output must use an .xlsx filename.")
      }
      if (existsSync(credentialsPath)) {
        throw new Error(`Credentials output already exists; refusing to overwrite: ${credentialsPath}`)
      }
      mkdirSync(dirname(credentialsPath), { recursive: true })
      writeFileSync(credentialsPath, credentialsWorkbook(prepared), { flag: "wx", mode: 0o600 })
      credentialsFileCreated = true
    }

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('oneflowe:user-import'))`)
        const changedAccounts = await findExistingAccounts(tx, prepared.map((item) => item.row))
        if (changedAccounts.users.length > 0 || changedAccounts.credentials.length > 0) {
          throw new Error("Database changed after preflight; rerun the dry run before importing.")
        }

        for (const item of prepared) {
          const role = item.row.role ? roleByName.get(item.row.role) : undefined
          if (!role) throw new Error(`Role resolution failed for workbook row ${item.row.rowNumber}.`)
          const [inserted] = await tx
            .insert(users)
            .values({
              email: item.row.email,
              username: item.row.username,
              passwordHash: item.passwordHash,
              roleId: role.id,
              isActive: item.row.isActive,
              fullName: item.row.fullName,
              firstName: item.row.firstName,
              lastName: item.row.lastName,
              phone: item.row.phone,
              employeeId: item.row.employeeId,
              mfaEnabled: false,
              organizationId: organization.id,
              branchId: item.row.role === "HEAD_OFFICE" ? null : item.branch?.id ?? null,
              location: item.row.branchSource || null,
              address: item.row.address,
              mustChangePassword: true,
              sessionVersion: 1,
            })
            .returning({ id: users.id })

          await tx.insert(systemLogs).values({
            userRole: "SYSTEM",
            organizationId: organization.id,
            branchId: item.row.role === "HEAD_OFFICE" ? null : item.branch?.id ?? null,
            action: "USER_BULK_IMPORT",
            resourceType: "user",
            resourceId: inserted.id,
            details: {
              sourceFile: basename(options.file),
              sourceSheet: sheetName,
              sourceRow: item.row.rowNumber,
              importedRole: item.row.role,
            },
            success: true,
          })

          created.push({
            id: inserted.id,
            rowNumber: item.row.rowNumber,
            email: item.row.email,
            firstName: item.row.firstName,
            username: item.row.username,
            temporaryPassword: item.temporaryPassword,
          })
        }
      }, { isolationLevel: "serializable" })
    } catch (error) {
      if (credentialsPath && credentialsFileCreated) {
        try {
          unlinkSync(credentialsPath)
        } catch {
          console.error(`Import failed and the uncommitted credential file could not be removed: ${credentialsPath}`)
        }
      }
      throw error
    }

    console.log(`\nInserted ${created.length} users in one transaction.`)
    if (credentialsPath) {
      console.log(`Credentials written to: ${credentialsPath}`)
    }
    if (options.sendWelcome) {
      const { sendUserImportWelcomeEmail } = await import("../lib/email/user-import-cli")
      const failedRows: number[] = []
      for (const user of created) {
        const sent = await sendUserImportWelcomeEmail(user.email, user.firstName, user.username, user.temporaryPassword)
        if (!sent) failedRows.push(user.rowNumber)
      }
      console.log(`Welcome emails sent: ${created.length - failedRows.length}/${created.length}.`)
      if (failedRows.length > 0) {
        console.error(`Welcome email failed for workbook rows ${failedRows.join(", ")}; reset those users' passwords before sharing access.`)
        process.exitCode = 2
      }
    }
  } finally {
    await closePool()
  }
}

main().catch((error) => {
  console.error(`\nUser import failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

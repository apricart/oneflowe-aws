export const IMPORTABLE_USER_ROLES = ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"] as const

export type ImportableUserRole = (typeof IMPORTABLE_USER_ROLES)[number]
export type UserImportUsernameFormat = "explicit" | "first.last"

export type UserImportIssue = {
  severity: "error" | "warning"
  code: string
  rowNumber: number
  field?: string
  message: string
}

export type ParsedUserImportRow = {
  rowNumber: number
  firstName: string
  lastName: string
  fullName: string
  email: string
  username: string
  usernameSource: "column" | "name"
  password: string | null
  role: ImportableUserRole | null
  branchSource: string
  phone: string | null
  employeeId: string | null
  address: string | null
  isActive: boolean
  issues: UserImportIssue[]
}

export type UserImportRecord = Record<string, unknown> & { __rowNum__?: number }

const HEADER_ALIASES = {
  firstName: ["firstname", "givenname"],
  lastName: ["lastname", "surname", "familyname"],
  fullName: ["name", "fullname", "employeename"],
  email: ["email", "eamil", "emailaddress", "mail"],
  username: ["username", "login", "logincode", "loginid", "userid"],
  password: ["password", "temporarypassword", "temppassword", "initialpassword"],
  role: ["role", "usertype", "userrole"],
  branch: ["branch", "branchname", "department", "deparment", "location"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "contactnumber"],
  employeeId: ["employeeid", "employeenumber", "employeeno", "staffid", "staffnumber"],
  address: ["address", "postaladdress"],
  status: ["status", "userstatus", "accountstatus", "isactive"],
} as const

const ROLE_ALIASES: Record<string, ImportableUserRole> = {
  headoffice: "HEAD_OFFICE",
  headofficeuser: "HEAD_OFFICE",
  branchadmin: "BRANCH_ADMIN",
  branchadministrator: "BRANCH_ADMIN",
  orderportal: "ORDER_PORTAL",
  orderportaluser: "ORDER_PORTAL",
}

export function normalizeImportText(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ")
}

export function normalizeImportKey(value: unknown): string {
  return normalizeImportText(value).toLowerCase()
}

export function normalizeImportHeader(value: unknown): string {
  return normalizeImportKey(value).replace(/[^a-z0-9]/g, "")
}

export function normalizePhoneKey(value: unknown): string {
  return normalizeImportText(value).replace(/\D/g, "")
}

function usernameNamePart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

export function deriveNameUsername(firstName: string, lastName: string): string {
  const first = usernameNamePart(firstName)
  const last = usernameNamePart(lastName)
  return first && last ? `${first}.${last}` : ""
}

export function parseImportRole(value: unknown): ImportableUserRole | null {
  const normalized = normalizeImportHeader(value)
  return ROLE_ALIASES[normalized] ?? null
}

export function resolveImportBranch<T extends { name: string }>(
  sourceName: string,
  branches: T[],
  overrides: Record<string, string> = {},
): { branch: T | null; overriddenName: string | null } {
  const normalizedOverrides = new Map(
    Object.entries(overrides).map(([source, target]) => [normalizeImportKey(source), normalizeImportText(target)]),
  )
  const overriddenName = normalizedOverrides.get(normalizeImportKey(sourceName)) ?? null
  const lookupName = overriddenName ?? sourceName
  const branch = branches.find((candidate) => normalizeImportKey(candidate.name) === normalizeImportKey(lookupName)) ?? null
  return { branch, overriddenName }
}

function findValue(record: UserImportRecord, aliases: readonly string[]): string {
  const aliasSet = new Set(aliases)
  for (const [header, value] of Object.entries(record)) {
    if (aliasSet.has(normalizeImportHeader(header))) return normalizeImportText(value)
  }
  return ""
}

function issue(
  severity: UserImportIssue["severity"],
  code: string,
  rowNumber: number,
  message: string,
  field?: string,
): UserImportIssue {
  return { severity, code, rowNumber, field, message }
}

function parseName(record: UserImportRecord, rowNumber: number): {
  firstName: string
  lastName: string
  fullName: string
  issues: UserImportIssue[]
} {
  const explicitFirstName = findValue(record, HEADER_ALIASES.firstName)
  const explicitLastName = findValue(record, HEADER_ALIASES.lastName)
  const combinedName = findValue(record, HEADER_ALIASES.fullName)
  const issues: UserImportIssue[] = []

  if (explicitFirstName || explicitLastName) {
    if (!explicitFirstName) issues.push(issue("error", "MISSING_FIRST_NAME", rowNumber, "First name is required.", "firstName"))
    if (!explicitLastName) issues.push(issue("error", "MISSING_LAST_NAME", rowNumber, "Last name is required.", "lastName"))
    return {
      firstName: explicitFirstName,
      lastName: explicitLastName,
      fullName: normalizeImportText(`${explicitFirstName} ${explicitLastName}`),
      issues,
    }
  }

  const nameParts = combinedName.split(" ").filter(Boolean)
  if (nameParts.length < 2) {
    issues.push(issue("error", "INVALID_FULL_NAME", rowNumber, "A combined Name must contain both first and last names.", "name"))
    return { firstName: nameParts[0] ?? "", lastName: "", fullName: combinedName, issues }
  }

  issues.push(issue(
    "warning",
    "DERIVED_NAME_PARTS",
    rowNumber,
    "First and last names were derived from the combined Name column.",
    "name",
  ))
  return {
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(" "),
    fullName: combinedName,
    issues,
  }
}

function parseStatus(value: string, rowNumber: number): { isActive: boolean; issues: UserImportIssue[] } {
  const normalized = normalizeImportHeader(value)
  if (!normalized || ["active", "enabled", "yes", "true", "1"].includes(normalized)) {
    return { isActive: true, issues: [] }
  }
  if (["inactive", "disabled", "no", "false", "0"].includes(normalized)) {
    return { isActive: false, issues: [] }
  }
  return {
    isActive: true,
    issues: [issue(
      "warning",
      "IGNORED_STATUS_VALUE",
      rowNumber,
      `Status value "${value}" is not an account status and was ignored; the user defaults to active.`,
      "status",
    )],
  }
}

function validatePassword(password: string, rowNumber: number): UserImportIssue[] {
  if (!password) return []
  const issues: UserImportIssue[] = []
  if (password.length < 12 || password.length > 128) {
    issues.push(issue("error", "INVALID_PASSWORD_LENGTH", rowNumber, "Password must be 12 to 128 characters.", "password"))
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    issues.push(issue("error", "INVALID_PASSWORD_COMPLEXITY", rowNumber, "Password must include upper/lowercase letters, a number, and a special character.", "password"))
  }
  return issues
}

function addDuplicateIssues(rows: ParsedUserImportRow[]): void {
  const fields: Array<{
    field: "username" | "email" | "phone" | "employeeId"
    code: string
    value: (row: ParsedUserImportRow) => string
  }> = [
    { field: "username", code: "DUPLICATE_USERNAME_IN_FILE", value: (row) => normalizeImportKey(row.username) },
    { field: "email", code: "DUPLICATE_EMAIL_IN_FILE", value: (row) => normalizeImportKey(row.email) },
    { field: "phone", code: "DUPLICATE_PHONE_IN_FILE", value: (row) => normalizePhoneKey(row.phone) },
    { field: "employeeId", code: "DUPLICATE_EMPLOYEE_ID_IN_FILE", value: (row) => normalizeImportKey(row.employeeId) },
  ]

  for (const definition of fields) {
    const groups = new Map<string, ParsedUserImportRow[]>()
    for (const row of rows) {
      const value = definition.value(row)
      if (!value) continue
      const group = groups.get(value) ?? []
      group.push(row)
      groups.set(value, group)
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const rowNumbers = group.map((row) => row.rowNumber).join(", ")
      for (const row of group) {
        row.issues.push(issue(
          "error",
          definition.code,
          row.rowNumber,
          `${definition.field} is duplicated on workbook rows ${rowNumbers}.`,
          definition.field,
        ))
      }
    }
  }
}

export function parseUserImportRecords(
  records: UserImportRecord[],
  options: { usernameFormat?: UserImportUsernameFormat } = {},
): ParsedUserImportRow[] {
  const rows: ParsedUserImportRow[] = []
  const usernameFormat = options.usernameFormat ?? "explicit"

  records.forEach((record, index) => {
    const rowNumber = Number.isInteger(record.__rowNum__) ? Number(record.__rowNum__) + 1 : index + 2
    const visibleValues = Object.entries(record)
      .filter(([key]) => key !== "__rowNum__")
      .map(([, value]) => normalizeImportText(value))
    if (!visibleValues.some(Boolean)) return

    const name = parseName(record, rowNumber)
    const email = findValue(record, HEADER_ALIASES.email).toLowerCase()
    const employeeId = findValue(record, HEADER_ALIASES.employeeId) || null
    const explicitUsername = findValue(record, HEADER_ALIASES.username)
    const password = findValue(record, HEADER_ALIASES.password) || null
    const rawRole = findValue(record, HEADER_ALIASES.role)
    const role = parseImportRole(rawRole)
    const branchSource = findValue(record, HEADER_ALIASES.branch)
    const phone = findValue(record, HEADER_ALIASES.phone) || null
    const address = findValue(record, HEADER_ALIASES.address) || null
    const status = parseStatus(findValue(record, HEADER_ALIASES.status), rowNumber)
    const usernameSource = explicitUsername ? "column" : "name"
    const username = normalizeImportKey(
      explicitUsername || (usernameFormat === "first.last" ? deriveNameUsername(name.firstName, name.lastName) : ""),
    )
    const issues = [...name.issues, ...status.issues, ...validatePassword(password ?? "", rowNumber)]

    if (!email) {
      issues.push(issue("error", "MISSING_EMAIL", rowNumber, "Email is required.", "email"))
    } else if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      issues.push(issue("error", "INVALID_EMAIL", rowNumber, "Email is invalid or exceeds 255 characters.", "email"))
    }
    if (!username) {
      issues.push(issue(
        "error",
        "MISSING_USERNAME",
        rowNumber,
        "Provide Username or configure the organization import with usernameFormat=first.last.",
        "username",
      ))
    } else if (username.length > 255 || /\s/.test(username)) {
      issues.push(issue("error", "INVALID_USERNAME", rowNumber, "Username cannot contain whitespace or exceed 255 characters.", "username"))
    }
    if (!role) {
      issues.push(issue("error", "INVALID_ROLE", rowNumber, `Role "${rawRole || "(blank)"}" is not importable.`, "role"))
    }
    if ((role === "BRANCH_ADMIN" || role === "ORDER_PORTAL") && !branchSource) {
      issues.push(issue("error", "MISSING_BRANCH", rowNumber, `${role} requires a branch/department.`, "branch"))
    }
    if (name.firstName.length > 100 || name.lastName.length > 100 || name.fullName.length > 255) {
      issues.push(issue("error", "NAME_TOO_LONG", rowNumber, "Name exceeds the database length limit.", "name"))
    }
    if (phone && phone.length > 32) {
      issues.push(issue("error", "PHONE_TOO_LONG", rowNumber, "Phone exceeds 32 characters.", "phone"))
    }
    if (employeeId && employeeId.length > 64) {
      issues.push(issue("error", "EMPLOYEE_ID_TOO_LONG", rowNumber, "Employee ID exceeds 64 characters.", "employeeId"))
    }
    if (address && address.length > 2_000) {
      issues.push(issue("error", "ADDRESS_TOO_LONG", rowNumber, "Address exceeds 2,000 characters.", "address"))
    }
    if (!explicitUsername && username) {
      issues.push(issue(
        "warning",
        "USERNAME_DERIVED_FROM_NAME",
        rowNumber,
        `Username was derived from first and last name using the ${usernameFormat} format.`,
        "username",
      ))
    }

    rows.push({
      rowNumber,
      firstName: name.firstName,
      lastName: name.lastName,
      fullName: name.fullName,
      email,
      username,
      usernameSource,
      password,
      role,
      branchSource,
      phone,
      employeeId,
      address,
      isActive: status.isActive,
      issues,
    })
  })

  addDuplicateIssues(rows)
  return rows
}

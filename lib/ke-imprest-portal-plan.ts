export type ImprestPortalRow = {
  rowNumber: number
  branchName: string
  employeeNumber: string
  adminName: string
  adminEmail: string
  address: string
  contact: string
  ordererName: string
  ordererEmail: string
}

export type ImprestAccount = {
  email: string
  fullName: string
  firstName: string
  lastName: string
  username: string
  role: "BRANCH_ADMIN" | "ORDER_PORTAL" | "GROUP_USER" | "GROUP_ORDER_PORTAL"
  branchNames: string[]
  phone: string | null
  address: string | null
  sourceRows: number[]
}

export type ImprestPlanOptions = {
  repeatedAdminOrderer: boolean
  separateRepeatedNamedOrderer: boolean
  groupContact: "blank" | "first"
}

const REQUIRED_EMAIL_DOMAIN = /^[^\s@]+@ke\.com(?:\.pk)?$/i

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function slug(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = fullName.trim().split(/\s+/)
  assert(firstName && rest.length, `Cannot split full name ${JSON.stringify(fullName)}`)
  return { firstName, lastName: rest.join(" ") }
}

function username(fullName: string, suffix: "ba" | "op"): string {
  const { firstName, lastName } = splitName(fullName)
  const first = slug(firstName)
  const last = slug(lastName)
  assert(first && last, `Cannot derive username from ${JSON.stringify(fullName)}`)
  return `${first}.${last}-${suffix}`
}

export function validateImprestRows(rows: ImprestPortalRow[]): void {
  assert(rows.length > 0, "Workbook has no data rows")
  const seenBranches = new Map<string, number>()
  for (const row of rows) {
    const label = `Workbook row ${row.rowNumber}`
    for (const key of ["branchName", "adminName", "adminEmail", "address", "contact", "ordererName", "ordererEmail"] as const) {
      assert(row[key].trim(), `${label}: ${key} is blank`)
    }
    assert(row.branchName.length <= 100, `${label}: branch name exceeds 100 characters`)
    assert(row.address.length >= 5 && row.address.length <= 500, `${label}: address must be 5–500 characters`)
    assert(row.contact.length <= 32, `${label}: contact exceeds 32 characters`)
    for (const email of [row.adminEmail, row.ordererEmail]) {
      assert(email.length <= 128 && REQUIRED_EMAIL_DOMAIN.test(email), `${label}: unexpected email domain or length: ${email}`)
    }
    for (const name of [row.adminName, row.ordererName]) {
      const { firstName, lastName } = splitName(name)
      assert(firstName.length <= 100 && lastName.length <= 100 && name.length <= 255,
        `${label}: name exceeds user field limits`)
    }
    const key = row.branchName.trim().toLowerCase()
    assert(!seenBranches.has(key), `${label}: branch name repeats workbook row ${seenBranches.get(key)}`)
    seenBranches.set(key, row.rowNumber)
  }
}

type Appearance = { row: ImprestPortalRow; role: "BRANCH_ADMIN" | "ORDER_PORTAL"; name: string }
type AccountIdentity = Pick<ImprestAccount, "email" | "fullName" | "firstName" | "lastName" | "branchNames" | "sourceRows">

function repeatedAccounts(appearances: Appearance[], common: AccountIdentity,
  options: ImprestPlanOptions): ImprestAccount[] {
  const adminAppearances = appearances.filter(({ role }) => role === "BRANCH_ADMIN")
  assert(adminAppearances.length > 0,
    `${common.email} repeats as an Order Initiator; confirm its intended group roles`)
  const adminBranches = [...new Set(adminAppearances.map(({ row }) => row.branchName))]
  const adminRows = [...new Set(adminAppearances.map(({ row }) => row.rowNumber))]
  const firstContact = options.groupContact === "first" ? adminAppearances[0].row : null
  const result: ImprestAccount[] = [{ ...common, branchNames: adminBranches, sourceRows: adminRows,
    username: username(common.fullName, "ba"), role: "GROUP_USER",
    phone: firstContact?.contact ?? null, address: firstContact?.address ?? null }]
  if (options.repeatedAdminOrderer) {
    const ordererAppearances = options.separateRepeatedNamedOrderer ? adminAppearances : appearances
    result.push({ ...common,
      branchNames: [...new Set(ordererAppearances.map(({ row }) => row.branchName))],
      sourceRows: [...new Set(ordererAppearances.map(({ row }) => row.rowNumber))],
      username: username(common.fullName, "op"), role: "GROUP_ORDER_PORTAL",
      phone: firstContact?.contact ?? null, address: firstContact?.address ?? null })
  }
  if (options.separateRepeatedNamedOrderer) {
    for (const { row, role } of appearances) {
      if (role !== "ORDER_PORTAL") continue
      result.push({ ...common, username: `${username(common.fullName, "op")}-${row.rowNumber}`,
        role: "ORDER_PORTAL", branchNames: [row.branchName], phone: row.contact,
        address: row.address, sourceRows: [row.rowNumber] })
    }
  }
  return result
}

export function planImprestAccounts(rows: ImprestPortalRow[], options: ImprestPlanOptions): ImprestAccount[] {
  validateImprestRows(rows)
  const people = new Map<string, Appearance[]>()
  for (const row of rows) {
    for (const appearance of [
      { row, role: "BRANCH_ADMIN" as const, name: row.adminName, email: row.adminEmail },
      { row, role: "ORDER_PORTAL" as const, name: row.ordererName, email: row.ordererEmail },
    ]) {
      const email = appearance.email.trim().toLowerCase()
      people.set(email, [...(people.get(email) ?? []), appearance])
    }
  }

  const accounts: ImprestAccount[] = []
  for (const [email, appearances] of people) {
    const names = [...new Set(appearances.map(({ name }) => name.trim().toLowerCase()))]
    assert(names.length === 1, `${email} is attached to different names in the workbook`)
    const fullName = appearances[0].name.trim()
    const { firstName, lastName } = splitName(fullName)
    const branchNames = [...new Set(appearances.map(({ row }) => row.branchName))]
    const sourceRows = [...new Set(appearances.map(({ row }) => row.rowNumber))]
    const repeated = sourceRows.length > 1
    const common = { email, fullName, firstName, lastName, branchNames, sourceRows }
    if (repeated) {
      accounts.push(...repeatedAccounts(appearances, common, options))
      continue
    }
    for (const { row, role } of appearances) {
      accounts.push({ ...common, username: username(fullName, role === "BRANCH_ADMIN" ? "ba" : "op"),
        role, phone: row.contact, address: row.address })
    }
  }

  const seenUsernames = new Map<string, string>()
  for (const account of accounts) {
    assert(account.username.length <= 255, `Username exceeds 255 characters: ${account.email}`)
    const owner = seenUsernames.get(account.username)
    assert(!owner, `Username ${account.username} would be used by both ${owner} and ${account.email}`)
    seenUsernames.set(account.username, account.email)
  }
  return accounts.sort((a, b) => a.username.localeCompare(b.username))
}

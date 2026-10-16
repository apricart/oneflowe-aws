/**
 * Head Office editing a pending department sign-up before deciding it
 * (plans/OF-JOIN-department-signup-multi-user.md, "Editing at review").
 *
 * Pure. Two halves:
 *
 *   * the planners the server applies inside its transaction — which request
 *     branch and address rows survive an edit, which go, which are added — so
 *     an unchanged row keeps its id and the review dialog's branch and address
 *     choices still name it after the edit;
 *   * the dialog's draft, its per-field problems and the body it sends. These
 *     are a courtesy: the endpoint re-validates everything with
 *     `departmentJoinUpdateSchema` and the organization's own rules.
 *
 * Every field the applicant typed is editable except the password, which only
 * its owner may choose, and the acceptance of the terms, which only its owner
 * may give.
 */

import {
  SIGNUP_ADDRESS_MAX_LENGTH,
  SIGNUP_DESIGNATION_MAX_LENGTH,
  SIGNUP_EMPLOYEE_ID_MAX_LENGTH,
  SIGNUP_IP_EXTENSION_PATTERN,
  SIGNUP_MAX_ADDRESSES,
  SIGNUP_MAX_BRANCHES,
  SIGNUP_PHONE_PATTERN,
  type RequestedBranchEntry,
  type RequestedNewBranch,
  crcError,
  isDepartment,
  normalizeBranchName,
  normalizeCrc,
  requestedBranchNameError,
} from "@/lib/join-department-signup"
import { emailMatchesDomain } from "@/lib/organization-email-domain"
import { USERNAME_BASE_MAX_LENGTH } from "@/lib/username-prefix"

export const JOIN_EDIT_NAME_MAX_LENGTH = 100
export const JOIN_EDIT_USERNAME_MIN_LENGTH = 3
/** Room is left for the organization's prefix (`USERNAME_BASE_MAX_LENGTH`). */
export const JOIN_EDIT_USERNAME_MAX_LENGTH = USERNAME_BASE_MAX_LENGTH
export const JOIN_EDIT_USERNAME_PATTERN = /^\S+$/
export const JOIN_EDIT_EMAIL_MAX_LENGTH = 255

/** The applicant's own fields, in the order the audit names them. */
export const JOIN_EDIT_PERSON_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "username",
  "phone",
  "ipExtension",
  "employeeId",
  "department",
] as const
export type JoinEditPersonField = (typeof JOIN_EDIT_PERSON_FIELDS)[number]
export type JoinEditPerson = Record<JoinEditPersonField, string | null>

/** The person fields an edit changes, by name. Values are never listed: they are personal data. */
export function changedPersonFields(before: Readonly<JoinEditPerson>, after: Readonly<JoinEditPerson>): JoinEditPersonField[] {
  return JOIN_EDIT_PERSON_FIELDS.filter((field) => (before[field] ?? "") !== (after[field] ?? ""))
}

/* ── Server planners ─────────────────────────────────────────────────────── */

export type StoredRequestBranchRow = {
  id: number
  existingBranchId: number | null
  costCenterId: string | null
  requestedBranchName: string | null
}

export type RequestBranchEditPlan = {
  deleteIds: number[]
  insertExistingIds: number[]
  insertNewBranches: RequestedNewBranch[]
  /** Kept CRC rows whose name the edit gives or changes. */
  renames: Array<{ id: number; name: string }>
}

/**
 * The request branch rows an edit keeps, drops and adds. `next` is the edited
 * list after typed CRCs were matched: existing branch ids, and the branches
 * still to be created. A row is kept when it names the same branch or the same
 * CRC; a kept CRC row takes the edit's name when one is given, and keeps its
 * own when none is.
 */
export function planRequestBranchEdit(
  current: readonly StoredRequestBranchRow[],
  next: Readonly<{ existingIds: readonly number[]; newBranches: readonly RequestedNewBranch[] }>,
): RequestBranchEditPlan {
  const wantedExisting = new Set(next.existingIds)
  const wantedNew = new Map(next.newBranches.map((entry) => [
    normalizeCrc(entry.crc),
    normalizeBranchName(entry.name) || null,
  ]))
  const keptExisting = new Set<number>()
  const keptCrcs = new Set<string>()
  const deleteIds: number[] = []
  const renames: Array<{ id: number; name: string }> = []

  for (const row of current) {
    const crc = row.costCenterId === null ? null : normalizeCrc(row.costCenterId)
    if (row.existingBranchId !== null && wantedExisting.has(row.existingBranchId)) {
      keptExisting.add(row.existingBranchId)
    } else if (row.existingBranchId === null && crc !== null && wantedNew.has(crc)) {
      keptCrcs.add(crc)
      const name = wantedNew.get(crc)
      if (name && name !== row.requestedBranchName) renames.push({ id: row.id, name })
    } else {
      deleteIds.push(row.id)
    }
  }

  return {
    deleteIds,
    insertExistingIds: [...wantedExisting].filter((id) => !keptExisting.has(id)),
    insertNewBranches: [...wantedNew.entries()]
      .filter(([crc]) => !keptCrcs.has(crc))
      .map(([crc, name]) => ({ crc, name: name ?? null })),
    renames,
  }
}

export type StoredRequestAddressRow = { id: number; address: string }

/** The address rows an edit keeps (same text), drops and adds. */
export function planAddressEdit(
  current: readonly StoredRequestAddressRow[],
  next: readonly string[],
): { deleteIds: number[]; insertAddresses: string[] } {
  const remaining = next.map((address) => address.trim())
  const deleteIds: number[] = []
  for (const row of current) {
    const index = remaining.indexOf(row.address.trim())
    if (index === -1) deleteIds.push(row.id)
    else remaining.splice(index, 1)
  }
  return { deleteIds, insertAddresses: remaining }
}

export type EditedApprover = { level: number; email: string; designation: string }

/** The levels whose approver an edit changes, in level order. */
export function changedApproverLevels(
  current: readonly EditedApprover[],
  next: readonly EditedApprover[],
): number[] {
  const before = new Map(current.map((approver) => [approver.level, approver]))
  return next
    .filter((approver) => {
      const previous = before.get(approver.level)
      return !previous
        || previous.email.trim().toLowerCase() !== approver.email.trim().toLowerCase()
        || previous.designation.trim() !== approver.designation.trim()
    })
    .map((approver) => approver.level)
    .sort((a, b) => a - b)
}

/** Whether two addresses read as the same one: case and spacing aside. */
function addressKey(address: string): string {
  return address.trim().replaceAll(/\s+/g, " ").toLowerCase()
}

/** Why the edited address list cannot be accepted, or null. */
export function editedAddressListError(addresses: readonly string[]): string | null {
  if (addresses.length === 0) return "Keep at least one delivery address"
  if (addresses.length > SIGNUP_MAX_ADDRESSES) return `At most ${SIGNUP_MAX_ADDRESSES} delivery addresses`
  const keys = addresses.map(addressKey)
  return new Set(keys).size === keys.length ? null : "The same delivery address is listed twice"
}

/** Why the edited branch list cannot be accepted, or null. */
export function editedBranchListError(branches: readonly RequestedBranchEntry[]): string | null {
  if (branches.length === 0) return "Keep at least one branch"
  if (branches.length > SIGNUP_MAX_BRANCHES) return `At most ${SIGNUP_MAX_BRANCHES} branches`
  const keys = branches.map((entry) => ("branchId" in entry ? `b:${entry.branchId}` : `c:${normalizeCrc(entry.crc)}`))
  return new Set(keys).size === keys.length ? null : "The same branch is listed twice"
}

/* ── The dialog's draft ──────────────────────────────────────────────────── */

export type JoinEditBranch =
  | { key: string; kind: "existing"; branchId: number; label: string }
  | { key: string; kind: "crc"; crc: string; name: string | null; label: string }

export type DepartmentJoinEditDraft = {
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string
  ipExtension: string
  employeeId: string
  department: string
  branches: JoinEditBranch[]
  /** Keyed so a row keeps its identity in the list when another is removed. */
  addresses: Array<{ key: string; address: string }>
  approvers: EditedApprover[]
}

/** What the review answers that the draft starts from. */
export type JoinEditSource = {
  person: {
    firstName: string
    lastName: string
    email: string
    username: string
    phone: string | null
    employeeId: string | null
    department: string | null
    ipExtension: string | null
  }
  branches: ReadonlyArray<{
    kind: "existing" | "new"
    branchId: number | null
    name: string | null
    costCenterId: string | null
    requestedName: string | null
  }>
  addresses: ReadonlyArray<{ requestAddressId: number; address: string }>
  approvers: ReadonlyArray<{ level: number; email: string; designation: string }>
}

export function existingBranchKey(branchId: number): string {
  return `branch:${branchId}`
}

export function crcBranchKey(crc: string): string {
  return `crc:${normalizeCrc(crc)}`
}

/** How a branch still to be created is listed: by its name when it has one, always with its CRC. */
export function newBranchLabel(crc: string, name: string | null): string {
  const normalized = normalizeCrc(crc)
  return name ? `${name} (new, CRC ${normalized})` : `New branch for CRC ${normalized}`
}

export function draftFromReview(review: JoinEditSource): DepartmentJoinEditDraft {
  return {
    firstName: review.person.firstName,
    lastName: review.person.lastName,
    email: review.person.email,
    username: review.person.username,
    phone: review.person.phone ?? "",
    ipExtension: review.person.ipExtension ?? "",
    employeeId: review.person.employeeId ?? "",
    department: review.person.department ?? "",
    branches: review.branches.flatMap((row): JoinEditBranch[] => {
      if (row.kind === "existing" && row.branchId !== null) {
        return [{ key: existingBranchKey(row.branchId), kind: "existing", branchId: row.branchId, label: row.name ?? `Branch ${row.branchId}` }]
      }
      if (row.costCenterId) {
        return [{
          key: crcBranchKey(row.costCenterId),
          kind: "crc",
          crc: normalizeCrc(row.costCenterId),
          name: row.requestedName,
          label: newBranchLabel(row.costCenterId, row.requestedName),
        }]
      }
      return []
    }),
    addresses: review.addresses.map((row) => ({ key: `address:${row.requestAddressId}`, address: row.address })),
    approvers: [...review.approvers]
      .sort((a, b) => a.level - b.level)
      .map((approver) => ({ level: approver.level, email: approver.email, designation: approver.designation })),
  }
}

function personErrors(draft: DepartmentJoinEditDraft, emailDomain: string | null, errors: Record<string, string>): void {
  const firstName = draft.firstName.trim()
  if (!firstName) errors.firstName = "Enter the first name"
  else if (firstName.length > JOIN_EDIT_NAME_MAX_LENGTH) errors.firstName = `At most ${JOIN_EDIT_NAME_MAX_LENGTH} characters`
  if (draft.lastName.trim().length > JOIN_EDIT_NAME_MAX_LENGTH) errors.lastName = `At most ${JOIN_EDIT_NAME_MAX_LENGTH} characters`

  const email = draft.email.trim().toLowerCase()
  if (!email || !email.includes("@")) errors.email = "Enter an email address"
  else if (email.length > JOIN_EDIT_EMAIL_MAX_LENGTH) errors.email = `At most ${JOIN_EDIT_EMAIL_MAX_LENGTH} characters`
  else if (emailDomain && !emailMatchesDomain(email, emailDomain)) errors.email = `Use an @${emailDomain} email address`

  const username = draft.username.trim()
  if (username.length < JOIN_EDIT_USERNAME_MIN_LENGTH) errors.username = `At least ${JOIN_EDIT_USERNAME_MIN_LENGTH} characters`
  else if (username.length > JOIN_EDIT_USERNAME_MAX_LENGTH) errors.username = `At most ${JOIN_EDIT_USERNAME_MAX_LENGTH} characters`
  else if (!JOIN_EDIT_USERNAME_PATTERN.test(username)) errors.username = "A username cannot contain spaces"

  if (!SIGNUP_PHONE_PATTERN.test(draft.phone.trim())) errors.phone = "Enter an 11-digit mobile number starting with 0"
  if (!SIGNUP_IP_EXTENSION_PATTERN.test(draft.ipExtension.trim())) errors.ipExtension = "Enter 3 to 6 digits"
  const employeeId = draft.employeeId.trim()
  if (!employeeId) errors.employeeId = "Enter the employee ID"
  else if (employeeId.length > SIGNUP_EMPLOYEE_ID_MAX_LENGTH) errors.employeeId = `At most ${SIGNUP_EMPLOYEE_ID_MAX_LENGTH} characters`
  if (!isDepartment(draft.department)) errors.department = "Select a department"
}

function approverDraftErrors(draft: DepartmentJoinEditDraft, emailDomain: string | null, errors: Record<string, string>): void {
  const initiator = draft.email.trim().toLowerCase()
  const seen = new Set<string>()
  for (const approver of draft.approvers) {
    const key = `approver${approver.level}`
    const email = approver.email.trim().toLowerCase()
    if (!email || !email.includes("@")) errors[`${key}Email`] = "Enter the approver's email"
    else if (emailDomain && !emailMatchesDomain(email, emailDomain)) errors[`${key}Email`] = `Use an @${emailDomain} email address`
    else if (email === initiator) errors[`${key}Email`] = "An approver cannot be the person placing the orders"
    else if (seen.has(email)) errors[`${key}Email`] = "Each level needs a different approver"
    seen.add(email)

    const designation = approver.designation.trim()
    if (designation.length < 2) errors[`${key}Designation`] = "Enter the designation"
    else if (designation.length > SIGNUP_DESIGNATION_MAX_LENGTH) {
      errors[`${key}Designation`] = `At most ${SIGNUP_DESIGNATION_MAX_LENGTH} characters`
    }
  }
}

/** Every problem with the draft, keyed by field; empty when it can be saved. */
export function departmentJoinEditErrors(
  draft: DepartmentJoinEditDraft,
  emailDomain: string | null,
): Record<string, string> {
  const errors: Record<string, string> = {}
  personErrors(draft, emailDomain, errors)
  approverDraftErrors(draft, emailDomain, errors)

  const branchProblem = editedBranchListError(draft.branches.map((entry) => (
    entry.kind === "existing" ? { branchId: entry.branchId } : { crc: entry.crc }
  )))
  if (branchProblem) errors.branches = branchProblem

  const addresses = draft.addresses.map((row) => row.address)
  const addressProblem = addresses
    .map((address) => {
      const trimmed = address.trim()
      if (trimmed.length < 5) return "Each delivery address needs at least 5 characters"
      if (trimmed.length > SIGNUP_ADDRESS_MAX_LENGTH) return `A delivery address is at most ${SIGNUP_ADDRESS_MAX_LENGTH} characters`
      return null
    })
    .find(Boolean) ?? editedAddressListError(addresses)
  if (addressProblem) errors.addresses = addressProblem
  return errors
}

/** Why a typed CRC cannot be added to the draft, or null. */
export function crcDraftError(draft: DepartmentJoinEditDraft, crc: string): string | null {
  const problem = crcError(crc)
  if (problem) return problem
  if (draft.branches.some((entry) => entry.key === crcBranchKey(crc))) return "That CRC is already listed"
  if (draft.branches.length >= SIGNUP_MAX_BRANCHES) return `At most ${SIGNUP_MAX_BRANCHES} branches`
  return null
}

/** Why a new branch (its name and its CRC) cannot be added to the draft, or null. */
export function newBranchDraftError(
  draft: DepartmentJoinEditDraft,
  entry: Readonly<{ name: string; crc: string }>,
): { field: "name" | "crc"; message: string } | null {
  const nameProblem = requestedBranchNameError(entry.name)
  if (nameProblem) return { field: "name", message: nameProblem }
  const crcProblem = crcDraftError(draft, entry.crc)
  return crcProblem ? { field: "crc", message: crcProblem } : null
}

/** The PATCH body. Call only once `departmentJoinEditErrors` is empty. */
export function toDepartmentJoinUpdatePayload(draft: DepartmentJoinEditDraft) {
  return {
    update: {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      email: draft.email.trim().toLowerCase(),
      username: draft.username.trim().toLowerCase(),
      phone: draft.phone.trim(),
      ipExtension: draft.ipExtension.trim(),
      employeeId: draft.employeeId.trim(),
      department: draft.department,
      branches: draft.branches.map((entry) => {
        if (entry.kind === "existing") return { branchId: entry.branchId }
        return entry.name ? { crc: entry.crc, name: entry.name } : { crc: entry.crc }
      }),
      addresses: draft.addresses.map((row) => row.address.trim()),
      approvers: draft.approvers.map((approver) => ({
        level: approver.level,
        email: approver.email.trim().toLowerCase(),
        designation: approver.designation.trim(),
      })),
    },
  }
}

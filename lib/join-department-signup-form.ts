/**
 * The department sign-up form's drafts: what the page holds while the
 * applicant types, the per-field problems, and the body it sends
 * (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * Pure. The page shows these problems as a courtesy; the endpoint re-validates
 * everything with `departmentJoinSubmitSchema` and the rules in
 * `lib/join-department-signup.ts`.
 */

import {
  DEPARTMENT_SIGNUP_FORM_VERSION,
  SIGNUP_ADDRESS_MAX_LENGTH,
  SIGNUP_DESIGNATION_MAX_LENGTH,
  SIGNUP_IP_EXTENSION_PATTERN,
  SIGNUP_MAX_ADDRESSES,
  SIGNUP_MAX_BODY_BYTES,
  SIGNUP_MAX_BRANCHES,
  SIGNUP_PHONE_PATTERN,
  crcError,
  encodedBodyBytes,
  isDepartment,
  normalizeBranchName,
  normalizeCrc,
  type RequestedBranchEntry,
  requestedBranchCityError,
  requestedBranchHierarchyError,
  requestedBranchNameError,
  requestedNewBranches,
} from "@/lib/join-department-signup"
import type { BranchHierarchyRole } from "@/lib/branch-hierarchy"
import { composeDomainEmail, emailLocalPartError } from "@/lib/organization-email-domain"

/** The four rules the server's password policy holds an applicant to. */
export function joinPasswordError(password: string): string | undefined {
  if (!password) return "Choose a password"
  if (password.length < 12) return "Use at least 12 characters"
  const complete = /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^a-zA-Z0-9]/.test(password)
  return complete ? undefined : "Include an uppercase letter, a lowercase letter, a number and a symbol"
}

/**
 * One branch chip: an existing branch picked by name, or a new branch named
 * with its CRC number, the listed city it is in with that city's province, and
 * its type — a child names an existing parent branch or another new branch on
 * this form marked Parent (plans/OF-JOIN-new-branch-parent-child.md).
 */
export type BranchChip =
  | { key: string; kind: "existing"; branchId: number; label: string; checked: boolean }
  | {
      key: string
      kind: "crc"
      crc: string
      name: string
      city: string
      province: string
      hierarchyRole: BranchHierarchyRole
      parentBranchId: number | null
      parentCrc: string | null
      label: string
      checked: boolean
    }

/*
 * A child's parent as the form's select holds it: an existing branch
 * (`branch:<id>`) or a new branch on this form (`crc:<CRC>`). Never sent.
 */
const EXISTING_PARENT_PREFIX = "branch:"
const NEW_PARENT_PREFIX = "crc:"

export type ParentChoice = { parentBranchId: number | null; parentCrc: string | null }

export function parentChoiceValue(choice: ParentChoice): string {
  if (choice.parentBranchId !== null) return `${EXISTING_PARENT_PREFIX}${choice.parentBranchId}`
  if (choice.parentCrc !== null) return `${NEW_PARENT_PREFIX}${choice.parentCrc}`
  return ""
}

export function parseParentChoice(value: string): ParentChoice {
  if (value.startsWith(EXISTING_PARENT_PREFIX)) {
    const id = Number(value.slice(EXISTING_PARENT_PREFIX.length))
    return { parentBranchId: Number.isInteger(id) && id > 0 ? id : null, parentCrc: null }
  }
  if (value.startsWith(NEW_PARENT_PREFIX)) return { parentBranchId: null, parentCrc: normalizeCrc(value.slice(NEW_PARENT_PREFIX.length)) || null }
  return { parentBranchId: null, parentCrc: null }
}

/**
 * The parents a new branch on this form may name: the organization's parent
 * branches (`parentBranchIds`, from the lookup) and the new branches already
 * added here as Parent, by name.
 */
export function parentChoiceOptions(
  branches: ReadonlyArray<{ id: number; name: string }>,
  parentBranchIds: readonly number[],
  chips: readonly BranchChip[],
): Array<{ value: string; label: string }> {
  const parents = new Set(parentBranchIds)
  const existing = branches
    .filter((branch) => parents.has(branch.id))
    .map((branch) => ({ value: parentChoiceValue({ parentBranchId: branch.id, parentCrc: null }), label: branch.name }))
  const added = chips.flatMap((chip) => (chip.kind === "crc" && chip.hierarchyRole === "PARENT"
    ? [{ value: parentChoiceValue({ parentBranchId: null, parentCrc: chip.crc }), label: `${chip.name} (new)` }]
    : []))
  return [...existing, ...added]
}

/** How a new branch chip's type reads: "Parent branch", "Child of …", or null for Standalone. */
export function chipHierarchyText(
  chip: BranchChip,
  chips: readonly BranchChip[],
  branches: ReadonlyArray<{ id: number; name: string }>,
): string | null {
  if (chip.kind !== "crc" || chip.hierarchyRole === "STANDALONE") return null
  if (chip.hierarchyRole === "PARENT") return "Parent branch"
  const parent = chip.parentCrc !== null
    ? chips.find((other) => other.kind === "crc" && other.crc === chip.parentCrc)?.label
    : branches.find((branch) => branch.id === chip.parentBranchId)?.name
  return `Child of ${parent ?? "a branch not on this form"}`
}

export type AddressChip = { key: string; address: string; checked: boolean }

export type ApproverDraft = { level: number; emailLocalPart: string; designation: string }

export type DepartmentSignupDraft = {
  fullName: string
  emailLocalPart: string
  phone: string
  ipExtension: string
  employeeId: string
  department: string
  approvers: ApproverDraft[]
  branches: BranchChip[]
  addresses: AddressChip[]
  password: string
  confirmPassword: string
  termsAccepted: boolean
}

export function emptyDepartmentSignupDraft(levelCount: number): DepartmentSignupDraft {
  return {
    fullName: "",
    emailLocalPart: "",
    phone: "",
    ipExtension: "",
    employeeId: "",
    department: "",
    approvers: Array.from({ length: levelCount }, (_, index) => ({ level: index + 1, emailLocalPart: "", designation: "" })),
    branches: [],
    addresses: [],
    password: "",
    confirmPassword: "",
    termsAccepted: false,
  }
}

function approverErrors(draft: DepartmentSignupDraft, errors: Record<string, string>): void {
  const initiator = draft.emailLocalPart.trim().toLowerCase()
  const seen = new Set<string>()
  for (const approver of draft.approvers) {
    const key = `approver${approver.level}`
    const local = approver.emailLocalPart.trim().toLowerCase()
    const emailProblem = emailLocalPartError(approver.emailLocalPart)
    if (emailProblem) errors[`${key}Email`] = emailProblem
    else if (local === initiator) errors[`${key}Email`] = "An approver cannot be the person placing the orders"
    else if (seen.has(local)) errors[`${key}Email`] = "Each level needs a different approver"
    seen.add(local)

    const designation = approver.designation.trim()
    if (designation.length < 2) errors[`${key}Designation`] = "Enter the designation"
    else if (designation.length > SIGNUP_DESIGNATION_MAX_LENGTH) {
      errors[`${key}Designation`] = `At most ${SIGNUP_DESIGNATION_MAX_LENGTH} characters`
    }
  }
}

/** Every problem with the draft, keyed by field; empty when it can be sent. */
export function departmentSignupErrors(draft: DepartmentSignupDraft): Record<string, string> {
  const errors: Record<string, string> = {}
  if (draft.fullName.trim().length < 3) errors.fullName = "Enter your complete name"
  const email = emailLocalPartError(draft.emailLocalPart)
  if (email) errors.email = email
  if (!SIGNUP_PHONE_PATTERN.test(draft.phone.trim())) errors.phone = "Enter an 11-digit mobile number starting with 0"
  if (!SIGNUP_IP_EXTENSION_PATTERN.test(draft.ipExtension.trim())) errors.ipExtension = "Enter 3 to 6 digits"
  if (!draft.employeeId.trim()) errors.employeeId = "Enter your employee ID"
  if (!isDepartment(draft.department)) errors.department = "Select a department"

  approverErrors(draft, errors)

  const branches = draft.branches.filter((chip) => chip.checked)
  const hierarchyProblem = requestedBranchHierarchyError(requestedNewBranches(branchEntries(branches)))
  if (branches.length === 0) errors.branches = "Add at least one branch and keep it checked"
  else if (branches.length > SIGNUP_MAX_BRANCHES) errors.branches = `At most ${SIGNUP_MAX_BRANCHES} branches`
  // A child whose parent on this form was removed or unchecked: the server
  // would refuse it, so say which before sending.
  else if (hierarchyProblem) errors.branches = `${hierarchyProblem}. Add its parent again, or remove it and add it with another type.`

  const addresses = draft.addresses.filter((chip) => chip.checked)
  if (addresses.length === 0) errors.addresses = "Add at least one delivery address and keep it checked"
  else if (addresses.length > SIGNUP_MAX_ADDRESSES) errors.addresses = `At most ${SIGNUP_MAX_ADDRESSES} delivery addresses`

  const password = joinPasswordError(draft.password)
  if (password) errors.password = password
  else if (draft.password !== draft.confirmPassword) errors.confirmPassword = "Passwords do not match"

  if (!draft.termsAccepted) errors.terms = "Accept the terms to continue"
  return errors
}

/** Whether two branch names read as the same one: case and spacing aside. */
export function sameBranchName(a: string, b: string): boolean {
  return normalizeBranchName(a).toLowerCase() === normalizeBranchName(b).toLowerCase()
}

/**
 * Why a name cannot be taken for a new branch, or null. `knownBranchNames` are
 * the organization's branches the page was given: a name that is one of them
 * is that branch, to be picked, not created again.
 */
export function newBranchNameChipError(
  chips: readonly BranchChip[],
  knownBranchNames: readonly string[],
  name: string,
): string | null {
  const nameProblem = requestedBranchNameError(name)
  if (nameProblem) return nameProblem
  if (knownBranchNames.some((known) => sameBranchName(known, name))) {
    return "This branch already exists. Pick it from the suggestions instead."
  }
  if (chips.some((chip) => chip.kind === "crc" && sameBranchName(chip.name, name))) {
    return "This branch is already added"
  }
  return null
}

/**
 * Why a new branch (its name, its CRC, its city and its type) cannot be added
 * as typed, or null. A child must name its parent.
 */
export function newBranchChipError(
  chips: readonly BranchChip[],
  knownBranchNames: readonly string[],
  entry: Readonly<{ name: string; crc: string; city: string; hierarchyRole?: BranchHierarchyRole; parent?: ParentChoice }>,
): { field: "name" | "crc" | "city" | "parent"; message: string } | null {
  const nameProblem = newBranchNameChipError(chips, knownBranchNames, entry.name)
  if (nameProblem) return { field: "name", message: nameProblem }
  const crcProblem = crcError(entry.crc)
  if (crcProblem) return { field: "crc", message: crcProblem }
  if (chips.some((chip) => chip.kind === "crc" && chip.crc === normalizeCrc(entry.crc))) {
    return { field: "crc", message: "This CRC is already added" }
  }
  const cityProblem = requestedBranchCityError(entry.city)
  if (cityProblem) return { field: "city", message: cityProblem }
  if (entry.hierarchyRole === "CHILD" && entry.parent?.parentBranchId == null && entry.parent?.parentCrc == null) {
    return { field: "parent", message: "Choose the parent branch" }
  }
  return null
}

/** The chips as the body names them: an existing branch by id, a new one with its details and type. */
function branchEntries(chips: readonly BranchChip[]): RequestedBranchEntry[] {
  return chips.map((chip) => (chip.kind === "existing"
    ? { branchId: chip.branchId }
    : {
        name: chip.name,
        crc: chip.crc,
        city: chip.city,
        province: chip.province,
        hierarchyRole: chip.hierarchyRole,
        ...(chip.hierarchyRole === "CHILD" && chip.parentBranchId !== null ? { parentBranchId: chip.parentBranchId } : {}),
        ...(chip.hierarchyRole === "CHILD" && chip.parentCrc !== null ? { parentCrc: chip.parentCrc } : {}),
      }))
}

/** Why an address cannot be added as typed, or null. */
export function addressDraftError(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed.length < 5) return "Enter at least 5 characters"
  if (trimmed.length > SIGNUP_ADDRESS_MAX_LENGTH) return `At most ${SIGNUP_ADDRESS_MAX_LENGTH} characters`
  return null
}

/**
 * The body the join page sends, less the code the page adds itself. Only
 * checked chips are sent. Call only once `departmentSignupErrors` is empty.
 */
export function toDepartmentSignupPayload(draft: DepartmentSignupDraft, emailDomain: string) {
  return {
    formVersion: DEPARTMENT_SIGNUP_FORM_VERSION,
    fullName: draft.fullName.trim(),
    email: composeDomainEmail(draft.emailLocalPart, emailDomain),
    password: draft.password,
    phone: draft.phone.trim(),
    ipExtension: draft.ipExtension.trim(),
    employeeId: draft.employeeId.trim(),
    department: draft.department,
    branches: branchEntries(draft.branches.filter((chip) => chip.checked)),
    addresses: draft.addresses.filter((chip) => chip.checked).map((chip) => chip.address.trim()),
    approvers: draft.approvers.map((approver) => ({
      level: approver.level,
      email: composeDomainEmail(approver.emailLocalPart, emailDomain),
      designation: approver.designation.trim(),
    })),
    termsAccepted: true as const,
  }
}

/** Why the body would be refused by the production WAF, or null. */
export function payloadSizeError(payload: unknown): string | null {
  return encodedBodyBytes(payload) > SIGNUP_MAX_BODY_BYTES
    ? "This form is too long to send. Shorten the addresses or designations and try again."
    : null
}

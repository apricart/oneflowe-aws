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
  requestedBranchCityError,
  requestedBranchNameError,
} from "@/lib/join-department-signup"
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
 * with its CRC number and the listed city it is in, with that city's province.
 */
export type BranchChip =
  | { key: string; kind: "existing"; branchId: number; label: string; checked: boolean }
  | { key: string; kind: "crc"; crc: string; name: string; city: string; province: string; label: string; checked: boolean }

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
  if (branches.length === 0) errors.branches = "Add at least one branch and keep it checked"
  else if (branches.length > SIGNUP_MAX_BRANCHES) errors.branches = `At most ${SIGNUP_MAX_BRANCHES} branches`

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

/** Why a new branch (its name, its CRC and its city) cannot be added as typed, or null. */
export function newBranchChipError(
  chips: readonly BranchChip[],
  knownBranchNames: readonly string[],
  entry: Readonly<{ name: string; crc: string; city: string }>,
): { field: "name" | "crc" | "city"; message: string } | null {
  const nameProblem = newBranchNameChipError(chips, knownBranchNames, entry.name)
  if (nameProblem) return { field: "name", message: nameProblem }
  const crcProblem = crcError(entry.crc)
  if (crcProblem) return { field: "crc", message: crcProblem }
  if (chips.some((chip) => chip.kind === "crc" && chip.crc === normalizeCrc(entry.crc))) {
    return { field: "crc", message: "This CRC is already added" }
  }
  const cityProblem = requestedBranchCityError(entry.city)
  if (cityProblem) return { field: "city", message: cityProblem }
  return null
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
    branches: draft.branches
      .filter((chip) => chip.checked)
      .map((chip) => (chip.kind === "existing"
        ? { branchId: chip.branchId }
        : { name: chip.name, crc: chip.crc, city: chip.city, province: chip.province })),
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

/**
 * The department sign-up — every rule that needs no database
 * (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * The department sign-up is the join form of an organization with order
 * approval levels on. It asks for one person (the order initiator), the
 * branches they order for (an existing branch picked by name, or a new
 * branch's name and its CRC number), their delivery addresses, and one
 * financial approver per approval level. Nothing is created until Head Office
 * approves.
 *
 * Shared by the join page and the endpoints, so the two cannot disagree. The
 * server re-validates everything the page checks.
 */

import { emailMatchesDomain } from "@/lib/organization-email-domain"
import { findPakistanCity } from "@/lib/pakistan-cities"

/** `organization_join_requests.form_version` of a department sign-up. */
export const DEPARTMENT_SIGNUP_FORM_VERSION = 2

/** The departments the design offers, in its order. */
export const DEPARTMENTS = [
  "Finance",
  "Operations",
  "IT",
  "Human Resources",
  "Procurement",
  "Compliance",
  "Sales & Marketing",
  "Administration",
  "Other",
] as const

export type Department = (typeof DEPARTMENTS)[number]

export function isDepartment(value: unknown): value is Department {
  return typeof value === "string" && (DEPARTMENTS as readonly string[]).includes(value)
}

/*
 * Bounds. The production WAF refuses any JSON body over 8 KB with an opaque
 * 403, so these keep the worst case well under it, and the form also measures
 * the encoded body before sending (`SIGNUP_MAX_BODY_BYTES`).
 */
export const SIGNUP_MAX_BRANCHES = 10
export const SIGNUP_MAX_ADDRESSES = 5
export const SIGNUP_ADDRESS_MAX_LENGTH = 200
export const SIGNUP_DESIGNATION_MAX_LENGTH = 60
export const SIGNUP_APPROVER_EMAIL_MAX_LENGTH = 120
export const SIGNUP_FULL_NAME_MAX_LENGTH = 120
export const SIGNUP_EMPLOYEE_ID_MAX_LENGTH = 64
export const CRC_MAX_LENGTH = 32
export const SIGNUP_MAX_BODY_BYTES = 8000

/** A CRC (cost centre) number: letters, digits and inner dashes. */
export const CRC_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/
/** A mobile number as the design asks: 0 then ten digits. */
export const SIGNUP_PHONE_PATTERN = /^0\d{10}$/
/** An IP-phone extension: three to six digits. */
export const SIGNUP_IP_EXTENSION_PATTERN = /^\d{3,6}$/

/** The one spelling of a CRC: trimmed and upper-cased. */
export function normalizeCrc(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : ""
}

export function crcError(value: unknown): string | null {
  const crc = normalizeCrc(value)
  if (!crc) return "Enter a CRC number"
  if (crc.length > CRC_MAX_LENGTH) return `A CRC number is at most ${CRC_MAX_LENGTH} characters`
  if (!CRC_PATTERN.test(crc)) return "Use letters, numbers and dashes only"
  return null
}

/** The one spelling of a requested branch name: trimmed, inner spaces collapsed. */
export function normalizeBranchName(value: unknown): string {
  return typeof value === "string" ? value.trim().replaceAll(/\s+/g, " ") : ""
}

/** Why a name for a branch to be created cannot be accepted, or null. */
export function requestedBranchNameError(value: unknown): string | null {
  return newBranchFieldError("name", normalizeBranchName(value))
}

/** One branch of a sign-up: an existing one picked by name, or one to create from its CRC. */
export type RequestedBranchEntry = { branchId: number } | { crc: string; name?: string | null }

export type RequestedNewBranch = { crc: string; name: string | null }

/**
 * The branches to create, one per CRC, normalised. A CRC listed twice is one
 * branch, and the first name given for it is kept.
 */
export function requestedNewBranches(entries: readonly RequestedBranchEntry[]): RequestedNewBranch[] {
  const byCrc = new Map<string, RequestedNewBranch>()
  for (const entry of entries) {
    if (!("crc" in entry)) continue
    const crc = normalizeCrc(entry.crc)
    const name = normalizeBranchName(entry.name) || null
    const known = byCrc.get(crc)
    if (!known) byCrc.set(crc, { crc, name })
    else if (known.name === null && name !== null) known.name = name
  }
  return [...byCrc.values()]
}

/** The username an address gets: the part before the `@`, lower-cased. */
export function deriveUsernameFromEmail(email: string): string {
  const at = email.lastIndexOf("@")
  return (at === -1 ? email : email.slice(0, at)).trim().toLowerCase()
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

/**
 * A new approver's name, from the address alone: `huzaifa.abid@…` is Huzaifa
 * Abid. The applicant gives an approver's email and designation, not a name.
 */
export function deriveNameFromEmail(email: string): { firstName: string; lastName: string } {
  const words = deriveUsernameFromEmail(email).split(/[._'+-]+/).filter(Boolean).map(capitalize)
  if (words.length === 0) return { firstName: deriveUsernameFromEmail(email), lastName: "" }
  return { firstName: words[0], lastName: words.slice(1).join(" ") }
}

/** "Complete Name" split into the first and last name the users table keeps. */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const words = fullName.trim().split(/\s+/).filter(Boolean)
  return { firstName: words[0] ?? "", lastName: words.slice(1).join(" ") }
}

export type InitiatorRole = "ORDER_PORTAL" | "GROUP_ORDER_PORTAL"

/** One branch orders through the shop; more than one through the group storefront. */
export function initiatorRoleForBranchCount(count: number): InitiatorRole {
  return count === 1 ? "ORDER_PORTAL" : "GROUP_ORDER_PORTAL"
}

/**
 * Whether an organization takes the department sign-up instead of the
 * standard join form. The organization half of `canHoldApprovalLevel`, plus at
 * least one level: an organization where no one could hold a level has no
 * approvers to name.
 */
export function joinUsesApprovalLevels(organization: {
  orderApprovalRequired: boolean
  orderApprovalLevelsEnabled: boolean
  levelCount: number
}): boolean {
  return organization.orderApprovalRequired
    && organization.orderApprovalLevelsEnabled
    && organization.levelCount > 0
}

export type SignupApprover = { level: number; email: string; designation: string }

/**
 * Why the approvers cannot be accepted, or null. One per level, levels 1..N
 * exactly, every address at the organization's domain, no address twice, and
 * none the initiator's own.
 */
export function approverListError(input: {
  initiatorEmail: string
  approvers: readonly SignupApprover[]
  levelCount: number
  emailDomain: string
}): string | null {
  const levels = input.approvers.map((approver) => approver.level).sort((a, b) => a - b)
  const expected = Array.from({ length: input.levelCount }, (_, index) => index + 1)
  if (levels.length !== expected.length || levels.some((level, index) => level !== expected[index])) {
    return `Name one approver for each of the ${input.levelCount} approval levels.`
  }

  const seen = new Set<string>()
  for (const approver of [...input.approvers].sort((a, b) => a.level - b.level)) {
    const email = approver.email.trim().toLowerCase()
    if (!emailMatchesDomain(email, input.emailDomain)) {
      return `Level ${approver.level}: use an @${input.emailDomain} email address.`
    }
    if (email === input.initiatorEmail.trim().toLowerCase()) {
      return `Level ${approver.level}: an approver cannot be the person placing the orders.`
    }
    if (seen.has(email)) return `Level ${approver.level}: each level needs a different approver.`
    seen.add(email)
    if (approver.designation.trim().length < 2) return `Level ${approver.level}: enter the approver's designation.`
  }
  return null
}

/** What the form sends, measured as the WAF measures it: UTF-8 bytes. */
export function encodedBodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length
}

/*
 * A new branch Head Office creates from a CRC at review. The decision schema
 * and the review dialog both read these bounds, so the dialog can name the
 * field it refuses instead of the server answering with a bare length error.
 */
export const NEW_BRANCH_FIELDS = ["name", "province", "city", "address"] as const
export type NewBranchField = (typeof NEW_BRANCH_FIELDS)[number]

export const NEW_BRANCH_FIELD_RULES: Record<NewBranchField, { label: string; min: number; max: number }> = {
  name: { label: "branch name", min: 2, max: 100 },
  province: { label: "province", min: 2, max: 100 },
  city: { label: "city", min: 2, max: 100 },
  address: { label: "branch address", min: 5, max: 500 },
}

/** Why one field of a new branch cannot be accepted, or null. */
export function newBranchFieldError(field: NewBranchField, value: string): string | null {
  const { label, min, max } = NEW_BRANCH_FIELD_RULES[field]
  const length = value.trim().length
  if (length === 0) return `Enter the ${label}`
  if (length < min) return `The ${label} needs at least ${min} characters`
  if (length > max) return `The ${label} can be at most ${max} characters`
  return null
}

export const UNLISTED_CITY_MESSAGE = "Choose the city from the list"

/**
 * Why a new branch's province cannot go with its city, or null. The city must
 * be one of Pakistan's listed cities and the province its own
 * (plans/OF-JOIN-new-branch-city-warehouse.md); a blank field is reported by
 * the length rule instead.
 */
export function newBranchLocationError(
  draft: Readonly<Pick<Record<NewBranchField, string>, "city" | "province">>,
): Partial<Record<"city" | "province", string>> {
  if (!draft.city.trim()) return {}
  const city = findPakistanCity(draft.city)
  if (!city) return { city: UNLISTED_CITY_MESSAGE }
  if (draft.province.trim() && draft.province.trim() !== city.province) {
    return { province: `${city.name} is in ${city.province}` }
  }
  return {}
}

/** Every field of a new branch that cannot be accepted, keyed by field; empty when all are fine. */
export function newBranchDraftErrors(
  draft: Readonly<Record<NewBranchField, string>>,
): Partial<Record<NewBranchField, string>> {
  const errors: Partial<Record<NewBranchField, string>> = {}
  for (const field of NEW_BRANCH_FIELDS) {
    const problem = newBranchFieldError(field, draft[field])
    if (problem) errors[field] = problem
  }
  return { ...newBranchLocationError(draft), ...errors }
}

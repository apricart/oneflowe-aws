/**
 * The department sign-up — every rule that needs no database
 * (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * The department sign-up is the join form of an organization with order
 * approval levels on. It asks for one person (the order initiator), the
 * branches they order for (an existing branch picked by name, or a new
 * branch's name, its CRC number and its city), their delivery addresses, and one
 * financial approver per approval level. Nothing is created until Head Office
 * approves.
 *
 * A new branch may also be given a type — Standalone, Parent, or Child of an
 * existing parent branch or of another new branch on the same request
 * (plans/OF-JOIN-new-branch-parent-child.md). Like the city it is a proposal:
 * Head Office confirms or changes it at review.
 *
 * Shared by the join page and the endpoints, so the two cannot disagree. The
 * server re-validates everything the page checks.
 */

import type { BranchHierarchyRole } from "@/lib/branch-hierarchy"
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

/**
 * One branch of a sign-up: an existing one picked by name, or one to create
 * from its CRC, with the city the applicant says it is in
 * (plans/OF-JOIN-applicant-new-branch-city.md).
 */
export type RequestedBranchEntry =
  | { branchId: number }
  | {
      crc: string
      name?: string | null
      city?: string | null
      province?: string | null
      hierarchyRole?: BranchHierarchyRole | null
      parentBranchId?: number | null
      parentCrc?: string | null
    }

/**
 * The type the applicant proposes for a branch to create: a child's parent is
 * an existing branch of the organization (`parentBranchId`) or another branch
 * to create on the same request (`parentCrc`), never both. Held as given, so
 * `requestedBranchHierarchyError` can refuse a pairing rather than repair it.
 */
export type RequestedHierarchy = {
  hierarchyRole: BranchHierarchyRole
  parentBranchId: number | null
  parentCrc: string | null
}

/**
 * `city` and `province` are both null, or a listed city and its own province.
 * `hierarchy` is null (or absent) when no type was proposed.
 */
export type RequestedNewBranch = {
  crc: string
  name: string | null
  city: string | null
  province: string | null
  hierarchy?: RequestedHierarchy | null
}

/** The type one entry proposes, normalised; null when it proposes none. */
export function requestedHierarchyOf(entry: Readonly<{
  hierarchyRole?: BranchHierarchyRole | null
  parentBranchId?: number | null
  parentCrc?: string | null
}>): RequestedHierarchy | null {
  if (entry.hierarchyRole === undefined || entry.hierarchyRole === null) return null
  return {
    hierarchyRole: entry.hierarchyRole,
    parentBranchId: entry.parentBranchId ?? null,
    parentCrc: normalizeCrc(entry.parentCrc) || null,
  }
}

/**
 * A requested city as Pakistan's list spells it, with the list's province; or
 * nulls when none was given or it is not listed. The province always comes from
 * the list, never from the caller, so the two cannot disagree once stored.
 */
export function requestedBranchLocation(city: unknown): { city: string | null; province: string | null } {
  const listed = typeof city === "string" ? findPakistanCity(city) : null
  return listed ? { city: listed.name, province: listed.province } : { city: null, province: null }
}

/**
 * The branches to create, one per CRC, normalised. A CRC listed twice is one
 * branch, and the first name, the first city and the first type given for it
 * are kept.
 */
export function requestedNewBranches(entries: readonly RequestedBranchEntry[]): RequestedNewBranch[] {
  const byCrc = new Map<string, RequestedNewBranch>()
  for (const entry of entries) {
    if (!("crc" in entry)) continue
    const crc = normalizeCrc(entry.crc)
    const name = normalizeBranchName(entry.name) || null
    const location = requestedBranchLocation(entry.city)
    const hierarchy = requestedHierarchyOf(entry)
    const known = byCrc.get(crc)
    if (!known) {
      byCrc.set(crc, { crc, name, ...location, hierarchy })
      continue
    }
    if (known.name === null && name !== null) known.name = name
    if (known.city === null && location.city !== null) Object.assign(known, location)
    if (!known.hierarchy && hierarchy) known.hierarchy = hierarchy
  }
  return [...byCrc.values()]
}

/**
 * Why the types proposed for the branches to create cannot stand together, or
 * null. Judged on the whole list, because a child may name another branch on
 * it: a child names exactly one parent; a parent CRC is another branch on the
 * list proposed as Parent; nothing but a child names a parent. Whether an
 * existing parent id is a Parent of the organization needs the database and is
 * the caller's to check.
 */
export function requestedBranchHierarchyError(newBranches: readonly RequestedNewBranch[]): string | null {
  const byCrc = new Map(newBranches.map((branch) => [normalizeCrc(branch.crc), branch]))
  for (const branch of newBranches) {
    const hierarchy = branch.hierarchy
    if (!hierarchy) continue
    const label = branch.name ?? `The new branch for CRC ${normalizeCrc(branch.crc)}`
    const pairing = requestedHierarchyPairingError(branch.crc, hierarchy)
    if (pairing) return `${label}: ${pairing}`
    if (hierarchy.parentCrc !== null && byCrc.get(hierarchy.parentCrc)?.hierarchy?.hierarchyRole !== "PARENT") {
      return `${label}: its parent must be a new branch on this request marked Parent`
    }
  }
  return null
}

/**
 * Why one proposed type cannot stand on its own, or null: a child names
 * exactly one parent, never its own CRC, and nothing else names one. What the
 * parent is needs the rest of the list, or the database.
 */
export function requestedHierarchyPairingError(crc: string, hierarchy: Readonly<RequestedHierarchy>): string | null {
  const namesExisting = hierarchy.parentBranchId !== null
  const namesNew = hierarchy.parentCrc !== null
  if (hierarchy.hierarchyRole !== "CHILD") {
    return namesExisting || namesNew ? "only a child branch has a parent branch" : null
  }
  if (namesExisting && namesNew) return "choose one parent branch"
  if (!namesExisting && !namesNew) return "choose its parent branch"
  if (hierarchy.parentCrc === normalizeCrc(crc)) return "a branch cannot be its own parent"
  return null
}

/** The existing branches the proposed types name as parents, once each. */
export function requestedParentBranchIds(newBranches: readonly RequestedNewBranch[]): number[] {
  return [...new Set(newBranches.flatMap((branch) => (
    branch.hierarchy?.parentBranchId ? [branch.hierarchy.parentBranchId] : []
  )))]
}

/**
 * Head Office's choice for one branch to create at approval: an existing
 * branch to map the CRC onto (which keeps its own type), or a type for the
 * branch it creates, whose parent is an existing branch or another branch this
 * same approval creates as Parent.
 */
export type NewBranchHierarchyChoice = {
  requestBranchId: number
  mapToBranchId?: number
  hierarchyRole?: BranchHierarchyRole
  parentBranchId?: number
  parentRequestBranchId?: number
}

/** Why one choice's type and parent cannot stand together, or null. */
export function newBranchChoiceHierarchyError(choice: Readonly<NewBranchHierarchyChoice>): string | null {
  const namesExisting = choice.parentBranchId !== undefined
  const namesNew = choice.parentRequestBranchId !== undefined
  if (choice.mapToBranchId !== undefined) {
    return choice.hierarchyRole !== undefined || namesExisting || namesNew
      ? "A branch mapped onto an existing one keeps that branch's type"
      : null
  }
  if (choice.hierarchyRole !== "CHILD") {
    return namesExisting || namesNew ? "Only a child branch has a parent branch" : null
  }
  if (namesExisting && namesNew) return "Choose one parent branch for a child branch"
  if (!namesExisting && !namesNew) return "Choose the parent branch for a child branch"
  if (choice.parentRequestBranchId === choice.requestBranchId) return "A branch cannot be its own parent"
  return null
}

/**
 * Why Head Office's choices cannot be applied together, or null: each holds on
 * its own, and a parent named among them is a branch this approval creates as
 * Parent.
 */
export function newBranchDecisionHierarchyError(choices: readonly NewBranchHierarchyChoice[]): string | null {
  for (const choice of choices) {
    const own = newBranchChoiceHierarchyError(choice)
    if (own) return own
    if (choice.parentRequestBranchId === undefined) continue
    const parent = choices.find((other) => other.requestBranchId === choice.parentRequestBranchId)
    if (!parent || parent.mapToBranchId !== undefined || parent.hierarchyRole !== "PARENT") {
      return "A child branch's parent must be an existing parent branch or a new branch created here as Parent"
    }
  }
  return null
}

/** Whether a choice creates a child branch, which the approval creates after every parent. */
export function createsChildBranch(choice: Readonly<NewBranchHierarchyChoice> | undefined): boolean {
  return choice?.mapToBranchId === undefined && choice?.hierarchyRole === "CHILD"
}

/**
 * Why a new branch's city, as the applicant chose it, cannot be accepted, or
 * null. It must be one of Pakistan's listed cities, and a province sent with it
 * must be that city's own.
 */
export function requestedBranchCityError(city: string, province?: string): string | null {
  if (!city.trim()) return "Choose the city of the new branch"
  const listed = findPakistanCity(city)
  if (!listed) return UNLISTED_CITY_MESSAGE
  if (province !== undefined && province.trim() !== listed.province) return `${listed.name} is in ${listed.province}`
  return null
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

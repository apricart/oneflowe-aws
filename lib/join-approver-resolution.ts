/**
 * What approving a department sign-up does with each named approver
 * (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * Pure, and the one statement of the rule: Head Office's review previews with
 * it and the approval re-runs it inside its transaction, refusing if the
 * outcome changed in between. So what Head Office saw is what gets written.
 *
 * A level belongs to the approver (`users.order_approval_level`), and an order
 * goes to the holders of its band who reach its branch. So naming someone as
 * Level 2 makes them a Level 2 approver for **everyone** at the initiator's
 * branches, and they must reach every one of those branches.
 *
 * **Levels 1 and 2 are always Group Users.** Other levels follow how many
 * branches the approver will reach (plans/OF-JOIN-department-signup-multi-user.md,
 * "Approver roles"): one branch is a Branch Admin of that branch, more than
 * one is a Group User.
 *
 *   * A new Level 1 or Level 2 approver is always a Group User. At later
 *     levels, one branch creates a Branch Admin — and is blocked where the
 *     organization's approver role is Head Office, because a Branch Admin
 *     cannot hold a level there. More than one branch creates a Group User.
 *   * An existing Branch Admin assigned to Level 1 or Level 2, or one that
 *     would reach more than its own branch, is converted to a Group User
 *     assigned to its old branch and the initiator's ones — refused while it
 *     still has orders of its own pending or approved, the rule every role
 *     change follows.
 *   * No other existing account changes role: a Group User stays a Group User
 *     even for one branch, Head Office stays Head Office, and any other role is
 *     blocked as before.
 */

import { canHoldApprovalLevel, type ApprovalLevelOrganization } from "@/lib/order-approval-levels"

/** An existing account found at the approver's email. */
export type ApproverCandidate = {
  userId: string
  organizationId: number | null
  role: string
  isActive: boolean
  level: number | null
  /** The single branch of a single-branch role. */
  branchId: number | null
  /** The resolved reach of a group role; empty otherwise. */
  scopedBranchIds: readonly number[]
  /**
   * Orders this account raised that are still pending or approved. Read only
   * for a Branch Admin, the one role this can convert; a role change waits for
   * them to complete (`lib/role-change-preconditions.ts`).
   */
  ordersInFlight: number
}

/** The two roles an approver can be created as. */
export type NewApproverRole = "BRANCH_ADMIN" | "GROUP_USER"

export type ApproverResolution =
  /** No account at that email: one is created, a Branch Admin for one branch, a Group User for more. */
  | { kind: "create"; role: NewApproverRole }
  /**
   * Eligible and holds no level: it is given this level, and any branches it
   * lacks. `becomesGroupUser`: a Branch Admin converted to reach them.
   */
  | { kind: "assign"; userId: string; addBranchIds: number[]; becomesGroupUser: boolean }
  /** Already holds this level: it is given the branches it lacks (converted, if a Branch Admin). */
  | { kind: "extend"; userId: string; addBranchIds: number[]; becomesGroupUser: boolean }
  /** Already holds this level and reaches every branch: nothing to do. */
  | { kind: "covered"; userId: string }
  /** The organization no longer takes levels, or this level is gone: no level is assigned. */
  | { kind: "not_applied"; reason: string }
  /** Cannot be used; Head Office names someone else or rejects. */
  | { kind: "blocked"; reason: string }

export type ApproverResolutionKind = ApproverResolution["kind"]

export function planApproverResolution(input: PlanInput): ApproverResolution {
  const { organization, level } = input
  if (!organization.orderApprovalRequired || !organization.orderApprovalLevelsEnabled) {
    return { kind: "not_applied", reason: "Approval levels are switched off for this organization." }
  }
  if (level > organization.levelCount) {
    return { kind: "not_applied", reason: `This organization no longer has a Level ${level}.` }
  }

  if (input.candidates.length === 0) return resolveNewApprover(input)
  if (input.candidates.length > 1) {
    return { kind: "blocked", reason: "More than one account uses this email address." }
  }

  const [candidate] = input.candidates
  const refusal = candidateRefusal(candidate, input)
  if (refusal) return { kind: "blocked", reason: refusal }
  return resolveForRole(candidate, input)
}

type PlanInput = {
  level: number
  organizationId: number
  organization: ApprovalLevelOrganization & { levelCount: number }
  /** Every non-deleted account at the email, in any organization. */
  candidates: readonly ApproverCandidate[]
  /** The initiator's branches that already exist. */
  initiatorBranchIds: readonly number[]
  /** The initiator's branches still to be created (none, inside the approval). */
  newBranchCount: number
  /** The Head Office user deciding the request. */
  deciderUserId: string
}

/** How many branches the initiator will order at: those that exist and those still to be created. */
export function approverBranchCount(input: { initiatorBranchIds: readonly number[]; newBranchCount: number }): number {
  return new Set(input.initiatorBranchIds).size + input.newBranchCount
}

/** Levels 1 and 2 always use the organization-wide Financial Approver role. */
export function levelRequiresGroupFinancialApprover(level: number): boolean {
  return level === 1 || level === 2
}

/**
 * The role a new approver is created as. Levels 1 and 2 are always Group
 * Users; remaining levels use a Branch Admin only when they reach one branch.
 */
export function newApproverRole(level: number, branchCount: number): NewApproverRole {
  return levelRequiresGroupFinancialApprover(level) || branchCount !== 1 ? "GROUP_USER" : "BRANCH_ADMIN"
}

export const NEW_BRANCH_ADMIN_APPROVER_REFUSAL =
  "A new approver for one branch is created as a Financial Approver, and in this organization a Financial Approver cannot hold an approval level (its approver role is Head Office). Name an existing Group Financial Approver instead."

function resolveNewApprover(input: PlanInput): ApproverResolution {
  const role = newApproverRole(input.level, approverBranchCount(input))
  if (role === "BRANCH_ADMIN" && !canHoldApprovalLevel("BRANCH_ADMIN", input.organization)) {
    return { kind: "blocked", reason: NEW_BRANCH_ADMIN_APPROVER_REFUSAL }
  }
  return { kind: "create", role }
}

/**
 * Whether an existing Branch Admin must become a Group User: Levels 1 and 2
 * always use that role; other levels convert when they reach past its branch.
 */
export function branchAdminBecomesGroupUser(
  candidate: Pick<ApproverCandidate, "role" | "branchId">,
  input: { level: number; initiatorBranchIds: readonly number[]; newBranchCount: number },
): boolean {
  if (candidate.role !== "BRANCH_ADMIN") return false
  if (levelRequiresGroupFinancialApprover(input.level)) return true
  return input.newBranchCount > 0 || input.initiatorBranchIds.some((branchId) => branchId !== candidate.branchId)
}

export const BRANCH_ADMIN_ORDERS_IN_FLIGHT_REFUSAL =
  "This Financial Approver would become a Group Financial Approver to approve for all of this person's branches, but still has orders they raised that are pending or approved. A role cannot change until those orders are completed."

/** Why an existing account cannot be this level's approver at all, or null. */
function candidateRefusal(
  candidate: ApproverCandidate,
  input: PlanInput,
): string | null {
  if (candidate.organizationId !== input.organizationId) {
    return "This email belongs to an account outside your organization."
  }
  if (candidate.userId === input.deciderUserId) {
    return "You cannot make yourself an approver. Ask another administrator."
  }
  if (!candidate.isActive) return "This account is inactive."
  // A Branch Admin that becomes a Group User is judged as the Group User it will be.
  const converts = branchAdminBecomesGroupUser(candidate, input)
  const roleAfter = converts ? "GROUP_USER" : candidate.role
  if (!canHoldApprovalLevel(roleAfter, input.organization)) {
    return "This account's role cannot hold an approval level here."
  }
  if (candidate.level !== null && candidate.level !== input.level) {
    return `This person already holds Level ${candidate.level}.`
  }
  if (converts && candidate.ordersInFlight > 0) return BRANCH_ADMIN_ORDERS_IN_FLIGHT_REFUSAL
  return null
}

/** What an eligible account needs: its reach decides, by role. */
function resolveForRole(
  candidate: ApproverCandidate,
  input: PlanInput,
): ApproverResolution {
  const holdsThisLevel = candidate.level === input.level

  if (candidate.role === "HEAD_OFFICE") {
    // Head Office reaches the whole organization, but only Super Admin may
    // give a Head Office user a level (`canManageUser`).
    return holdsThisLevel
      ? { kind: "covered", userId: candidate.userId }
      : { kind: "blocked", reason: "Only Super Admin can give a Head Office user an approval level." }
  }

  if (candidate.role === "BRANCH_ADMIN") {
    if (!branchAdminBecomesGroupUser(candidate, input)) {
      // Its own branch is the only branch: it stays the Branch Admin it is.
      return holdsThisLevel
        ? { kind: "covered", userId: candidate.userId }
        : { kind: "assign", userId: candidate.userId, addBranchIds: [], becomesGroupUser: false }
    }
    // It becomes a Group User; its own branch is kept as an assignment.
    const addBranchIds = [...new Set(input.initiatorBranchIds)].filter((branchId) => branchId !== candidate.branchId)
    return holdsThisLevel
      ? { kind: "extend", userId: candidate.userId, addBranchIds, becomesGroupUser: true }
      : { kind: "assign", userId: candidate.userId, addBranchIds, becomesGroupUser: true }
  }

  // A Group User stays one, whatever the branch count: whatever it lacks of the
  // initiator's branches is added.
  const reach = new Set(candidate.scopedBranchIds)
  const addBranchIds = [...new Set(input.initiatorBranchIds)].filter((branchId) => !reach.has(branchId))
  if (!holdsThisLevel) return { kind: "assign", userId: candidate.userId, addBranchIds, becomesGroupUser: false }
  return addBranchIds.length === 0 && input.newBranchCount === 0
    ? { kind: "covered", userId: candidate.userId }
    : { kind: "extend", userId: candidate.userId, addBranchIds, becomesGroupUser: false }
}

/**
 * What an approval records for a level (`organization_join_request_approvers.resolution`,
 * held by its check constraint). A blocked approver is never recorded: the
 * approval is refused instead.
 */
export const RECORDED_RESOLUTION = {
  create: "created",
  assign: "assigned",
  extend: "extended",
  covered: "covered",
  not_applied: "not_applied",
} as const satisfies Record<Exclude<ApproverResolutionKind, "blocked">, string>

/**
 * Whether two resolutions would write the same thing (the drift check): the
 * same kind for the same account. What follows from the branches Head Office
 * settles in the same approval is not part of it, because the review cannot
 * know them (mapping a CRC onto a branch already listed lowers the count): the
 * role an approver ends with, the branches it is given, and so whether a
 * holder of the level is extended or already covered. The approval decides
 * those on the final branches, and the dialog previews them on the same rule.
 */
export function sameResolution(a: ApproverResolution, b: ApproverResolution): boolean {
  const holdsLevel = (kind: ApproverResolutionKind) => (kind === "covered" ? "extend" : kind)
  if (holdsLevel(a.kind) !== holdsLevel(b.kind)) return false
  const userOf = (resolution: ApproverResolution) => ("userId" in resolution ? resolution.userId : null)
  return userOf(a) === userOf(b)
}

/**
 * The role an approver will hold after the approval, or null when nothing is
 * written for it (not applied, blocked). For the review's wording.
 */
export function approverRoleAfterApproval(
  resolution: ApproverResolution,
  existingRole: string | null,
): string | null {
  switch (resolution.kind) {
    case "create":
      return resolution.role
    case "assign":
    case "extend":
      return resolution.becomesGroupUser ? "GROUP_USER" : existingRole
    case "covered":
      return existingRole
    default:
      return null
  }
}

/**
 * How many branches the initiator will have once Head Office's choices at
 * review are applied: every existing branch, each CRC mapped onto a branch,
 * and each CRC to be created — counted once each, because mapping a CRC onto a
 * branch already in the request does not add one. The approval decides the
 * initiator's and the new approvers' roles on this count.
 */
export function branchCountAfterReview(
  rows: ReadonlyArray<{ requestBranchId: number; branchId: number | null }>,
  mappedBranchIds: Readonly<Record<number, number | null | undefined>>,
): number {
  const keys = new Set<string>()
  for (const row of rows) {
    const branchId = row.branchId ?? mappedBranchIds[row.requestBranchId] ?? null
    keys.add(branchId === null ? `new:${row.requestBranchId}` : `branch:${branchId}`)
  }
  return keys.size
}

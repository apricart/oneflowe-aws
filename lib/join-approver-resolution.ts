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
}

export type ApproverResolution =
  /** No account at that email: one is created, as a Group User. */
  | { kind: "create" }
  /** Eligible and holds no level: it is given this level, and any branches it lacks. */
  | { kind: "assign"; userId: string; addBranchIds: number[] }
  /** Already holds this level: it is given the branches it lacks. */
  | { kind: "extend"; userId: string; addBranchIds: number[] }
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

  if (input.candidates.length === 0) return { kind: "create" }
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
  if (!canHoldApprovalLevel(candidate.role, input.organization)) {
    return "This account's role cannot hold an approval level here."
  }
  if (candidate.level !== null && candidate.level !== input.level) {
    return `This person already holds Level ${candidate.level}.`
  }
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
    const reachesAll = input.newBranchCount === 0
      && input.initiatorBranchIds.every((branchId) => branchId === candidate.branchId)
    if (!reachesAll) {
      return { kind: "blocked", reason: "A Branch Admin reaches only their own branch, not all of this person's branches." }
    }
    return holdsThisLevel
      ? { kind: "covered", userId: candidate.userId }
      : { kind: "assign", userId: candidate.userId, addBranchIds: [] }
  }

  // A Group User: whatever it lacks of the initiator's branches is added.
  const reach = new Set(candidate.scopedBranchIds)
  const addBranchIds = [...new Set(input.initiatorBranchIds)].filter((branchId) => !reach.has(branchId))
  if (!holdsThisLevel) return { kind: "assign", userId: candidate.userId, addBranchIds }
  return addBranchIds.length === 0 && input.newBranchCount === 0
    ? { kind: "covered", userId: candidate.userId }
    : { kind: "extend", userId: candidate.userId, addBranchIds }
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

/** Whether two resolutions would write the same thing (the drift check). */
export function sameResolution(a: ApproverResolution, b: ApproverResolution): boolean {
  if (a.kind !== b.kind) return false
  const userOf = (resolution: ApproverResolution) => ("userId" in resolution ? resolution.userId : null)
  return userOf(a) === userOf(b)
}

import type { Role } from "@/lib/rbac"

export const ORDER_APPROVER_ROLES = ["BRANCH_ADMIN", "HEAD_OFFICE"] as const

export type OrderApproverRole = (typeof ORDER_APPROVER_ROLES)[number]

export const DEFAULT_ORDER_APPROVER_ROLE: OrderApproverRole = "BRANCH_ADMIN"

export const ORDER_APPROVER_ROLE_LABELS: Record<OrderApproverRole, string> = {
  BRANCH_ADMIN: "Branch Admin",
  HEAD_OFFICE: "Head Office",
}

export function isOrderApproverRole(value: unknown): value is OrderApproverRole {
  return typeof value === "string"
    && ORDER_APPROVER_ROLES.includes(value as OrderApproverRole)
}

export function parseOrderApproverRole(value: unknown): OrderApproverRole {
  return isOrderApproverRole(value) ? value : DEFAULT_ORDER_APPROVER_ROLE
}

/**
 * The role that actually made a decision. This is the tenant's configured
 * approver role for the standard flow, or GROUP_USER when a multi-branch
 * approver acted. It is reported in audits, notifications, and emails so the
 * record always names the role that really decided.
 */
export type OrderDecisionRole = OrderApproverRole | "GROUP_USER"

export const ORDER_DECISION_ROLE_LABELS: Record<OrderDecisionRole, string> = {
  ...ORDER_APPROVER_ROLE_LABELS,
  GROUP_USER: "Group User",
}

export function isOrderDecisionRole(value: unknown): value is OrderDecisionRole {
  return isOrderApproverRole(value) || value === "GROUP_USER"
}

export type OrderDecisionAccessInput = {
  actorRole: Role
  actorOrganizationId: number | null
  actorBranchId: number | null
  configuredApproverRole: unknown
  orderOrganizationId: number | null
  orderBranchId: number
  branchOrganizationId: number | null
  /**
   * Branches a GROUP_USER may decide for, resolved from its group and branch
   * assignments. Null or omitted for every other role, which is why no other
   * role's outcome can be affected by this field.
   */
  actorScopedBranchIds?: number[] | null
}

/**
 * The fail-closed, tenant-aware policy shared by approve and reject operations.
 * The order and branch must agree on their organization before role scope is
 * considered, preventing a malformed foreign-key relationship from crossing
 * tenant boundaries.
 */
export function canMakeOrderDecision(input: OrderDecisionAccessInput): boolean {
  if (!input.orderOrganizationId || !input.actorOrganizationId) return false
  if (input.orderOrganizationId !== input.actorOrganizationId) return false
  if (input.branchOrganizationId !== input.orderOrganizationId) return false

  // GROUP_USER is an additional approver whose authority comes from its own
  // branch assignments, not from the tenant's configured approver role. It is
  // resolved first and separately so the configured-role path below keeps
  // exactly the behaviour it had before this role existed.
  if (input.actorRole === "GROUP_USER") {
    const scoped = input.actorScopedBranchIds
    return Array.isArray(scoped) && scoped.includes(input.orderBranchId)
  }

  if (!isOrderApproverRole(input.configuredApproverRole)) return false
  if (input.actorRole !== input.configuredApproverRole) return false

  if (input.actorRole === "BRANCH_ADMIN") {
    return Boolean(input.actorBranchId)
      && input.actorBranchId === input.orderBranchId
  }

  return input.actorRole === "HEAD_OFFICE"
}


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

export type OrderDecisionAccessInput = {
  actorRole: Role
  actorOrganizationId: number | null
  actorBranchId: number | null
  configuredApproverRole: unknown
  orderOrganizationId: number | null
  orderBranchId: number
  branchOrganizationId: number | null
}

/**
 * The fail-closed, tenant-aware policy shared by approve and reject operations.
 * The order and branch must agree on their organization before role scope is
 * considered, preventing a malformed foreign-key relationship from crossing
 * tenant boundaries.
 */
export function canMakeOrderDecision(input: OrderDecisionAccessInput): boolean {
  if (!isOrderApproverRole(input.configuredApproverRole)) return false
  if (input.actorRole !== input.configuredApproverRole) return false
  if (!input.orderOrganizationId || !input.actorOrganizationId) return false
  if (input.orderOrganizationId !== input.actorOrganizationId) return false
  if (input.branchOrganizationId !== input.orderOrganizationId) return false

  if (input.actorRole === "BRANCH_ADMIN") {
    return Boolean(input.actorBranchId)
      && input.actorBranchId === input.orderBranchId
  }

  return input.actorRole === "HEAD_OFFICE"
}


import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import { branches, orders, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import type { RequestScope } from "@/lib/auth"
import {
  canMakeOrderDecision,
  isOrderApproverRole,
  type OrderApproverRole,
} from "@/lib/order-approver-role"

export type OrderDecisionCapabilities = {
  canApproveOrders: boolean
  canRejectOrders: boolean
  orderApproverRole: OrderApproverRole | null
}

export type OrderDecisionAuthorization =
  | {
    ok: true
    order: typeof orders.$inferSelect
    configuredApproverRole: OrderApproverRole
  }
  | {
    ok: false
    reason: "not-found" | "forbidden"
  }

/**
 * Authorize an order decision inside the same transaction as the status
 * transition. The organization row share lock serializes decisions with a
 * Super Admin changing the configured approver role.
 */
export async function authorizeOrderDecision(
  tx: any,
  input: { orderId: number; scope: RequestScope },
): Promise<OrderDecisionAuthorization> {
  if (input.scope.role !== "BRANCH_ADMIN" && input.scope.role !== "HEAD_OFFICE") {
    return { ok: false, reason: "forbidden" }
  }

  const [actor] = await tx
    .select({
      organizationId: users.organizationId,
      branchId: users.branchId,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, input.scope.userId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  if (
    actor?.role !== input.scope.role
    || actor.organizationId !== input.scope.organizationId
    || actor.branchId !== input.scope.branchId
  ) {
    return { ok: false, reason: "forbidden" }
  }

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1)

  if (!order) return { ok: false, reason: "not-found" }
  if (!order.organizationId) return { ok: false, reason: "forbidden" }

  const [organization] = await tx
    .select({
      id: organizations.id,
      orderApproverRole: organizations.orderApproverRole,
    })
    .from(organizations)
    .where(eq(organizations.id, order.organizationId))
    .for("share")
    .limit(1)

  if (!organization || !isOrderApproverRole(organization.orderApproverRole)) {
    return { ok: false, reason: "forbidden" }
  }

  const [branch] = await tx
    .select({ organizationId: branches.organizationId })
    .from(branches)
    .where(eq(branches.id, order.branchId))
    .limit(1)

  if (!branch || !canMakeOrderDecision({
    actorRole: input.scope.role,
    actorOrganizationId: actor.organizationId,
    actorBranchId: actor.branchId,
    configuredApproverRole: organization.orderApproverRole,
    orderOrganizationId: order.organizationId,
    orderBranchId: order.branchId,
    branchOrganizationId: branch.organizationId,
  })) {
    return { ok: false, reason: "forbidden" }
  }

  return {
    ok: true,
    order,
    configuredApproverRole: organization.orderApproverRole,
  }
}

export async function getOrderDecisionCapabilities(
  scope: RequestScope | null,
): Promise<OrderDecisionCapabilities> {
  const denied: OrderDecisionCapabilities = {
    canApproveOrders: false,
    canRejectOrders: false,
    orderApproverRole: null,
  }

  if (!scope?.organizationId) return denied
  if (scope.role !== "BRANCH_ADMIN" && scope.role !== "HEAD_OFFICE") return denied

  const [actor] = await db
    .select({
      organizationId: users.organizationId,
      branchId: users.branchId,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, scope.userId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  if (
    actor?.role !== scope.role
    || actor.organizationId !== scope.organizationId
    || actor.branchId !== scope.branchId
  ) {
    return denied
  }

  const [organization] = await db
    .select({ orderApproverRole: organizations.orderApproverRole })
    .from(organizations)
    .where(eq(organizations.id, scope.organizationId))
    .limit(1)

  if (!organization || !isOrderApproverRole(organization.orderApproverRole)) {
    return denied
  }

  let allowed = organization.orderApproverRole === scope.role
  if (allowed && scope.role === "BRANCH_ADMIN") {
    if (!actor.branchId) {
      allowed = false
    } else {
      const [branch] = await db
        .select({ id: branches.id })
        .from(branches)
        .where(and(
          eq(branches.id, actor.branchId),
          eq(branches.organizationId, actor.organizationId),
        ))
        .limit(1)
      allowed = Boolean(branch && scope.organizationId)
    }
  }
  return {
    canApproveOrders: allowed,
    canRejectOrders: allowed,
    orderApproverRole: organization.orderApproverRole,
  }
}

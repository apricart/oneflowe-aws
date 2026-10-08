import "server-only"

import { and, eq, isNull } from "drizzle-orm"

import { branches, orders, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import type { RequestScope } from "@/lib/auth"
import { APRICART_EXECUTIVE_ROLE, isApricartExecutiveRole } from "@/lib/apricart-executive-access"
import { canExecutiveDecideOrder, isDeskEnteredOrder } from "@/lib/order-desk-approval"
import {
  canMakeOrderDecision,
  isOrderApproverRole,
  type OrderApproverRole,
  type OrderDecisionRole,
} from "@/lib/order-approver-role"
import { loadExecutiveApprovalReach } from "@/lib/server/apricart-executive-scope"
import {
  GROUP_USER_ROLE,
  isGroupApproverRole,
  resolveScopedBranchIds,
} from "@/lib/server/multi-branch-scope"

/** Roles permitted to reach an order decision at all. */
const ORDER_DECISION_ROLES = new Set<string>(["BRANCH_ADMIN", "HEAD_OFFICE", GROUP_USER_ROLE])

function canAttemptOrderDecision(role: unknown): boolean {
  return typeof role === "string" && ORDER_DECISION_ROLES.has(role)
}

export type OrderDecisionCapabilities = {
  canApproveOrders: boolean
  canRejectOrders: boolean
  /** Sending a pending order back for correction is the third decision, held to the same rule. */
  canReturnOrders: boolean
  orderApproverRole: OrderApproverRole | null
}

export type OrderDecisionAuthorization =
  | {
    ok: true
    order: typeof orders.$inferSelect
    configuredApproverRole: OrderApproverRole
    /** The role that actually decided — GROUP_USER, APRICART_EXECUTIVE, or the configured role. */
    decisionRole: OrderDecisionRole
  }
  | {
    ok: false
    reason: "not-found" | "forbidden"
  }

/**
 * Authorize an order decision inside the same transaction as the status
 * transition. The organization row share lock serializes decisions with a
 * Super Admin changing the configured approver role.
 *
 * Who decides is fixed by where the order came from
 * (`lib/order-desk-approval.ts`): an order the Order Desk entered is decided
 * by an Apricart Executive assigned to its organization, and by no one in the
 * tenant; every other order by the tenant's approvers, exactly as before.
 */
export async function authorizeOrderDecision(
  tx: any,
  input: { orderId: number; scope: RequestScope },
): Promise<OrderDecisionAuthorization> {
  if (isApricartExecutiveRole(input.scope.role)) {
    return authorizeExecutiveOrderDecision(tx, input)
  }
  if (!canAttemptOrderDecision(input.scope.role)) {
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
  // An order Apricart's Order Desk entered is Apricart's to decide.
  if (isDeskEnteredOrder(order)) return { ok: false, reason: "forbidden" }

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

  // Read the assignments inside the same transaction as the status change, so
  // a concurrent scope edit cannot be observed half-applied.
  const actorScopedBranchIds = isGroupApproverRole(input.scope.role)
    ? await resolveScopedBranchIds(tx, input.scope.userId)
    : null

  if (!branch || !canMakeOrderDecision({
    actorRole: input.scope.role,
    actorOrganizationId: actor.organizationId,
    actorBranchId: actor.branchId,
    configuredApproverRole: organization.orderApproverRole,
    orderOrganizationId: order.organizationId,
    orderBranchId: order.branchId,
    branchOrganizationId: branch.organizationId,
    actorScopedBranchIds,
  })) {
    return { ok: false, reason: "forbidden" }
  }

  return {
    ok: true,
    order,
    configuredApproverRole: organization.orderApproverRole,
    decisionRole: isGroupApproverRole(input.scope.role)
      ? GROUP_USER_ROLE
      : organization.orderApproverRole,
  }
}

/**
 * An Apricart Executive deciding an Order Desk order. Everything is re-read on
 * this transaction: the account (inside `loadExecutiveApprovalReach`), the
 * assignment for the order's organization under FOR SHARE — so a Super Admin
 * removing it waits for this decision — and the organization under the same
 * share lock the tenant path takes. Anything outside the reach reads as "not
 * found", so the response cannot be used to discover another tenant's orders.
 */
async function authorizeExecutiveOrderDecision(
  tx: any,
  input: { orderId: number; scope: RequestScope },
): Promise<OrderDecisionAuthorization> {
  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .limit(1)
  if (!order?.organizationId || !isDeskEnteredOrder(order)) return { ok: false, reason: "not-found" }

  const reachOrganizationIds = await loadExecutiveApprovalReach(tx, input.scope.userId, {
    organizationId: order.organizationId,
    lock: true,
  })
  if (reachOrganizationIds.length === 0) return { ok: false, reason: "not-found" }

  const [organization] = await tx
    .select({ orderApproverRole: organizations.orderApproverRole })
    .from(organizations)
    .where(eq(organizations.id, order.organizationId))
    .for("share")
    .limit(1)
  const [branch] = await tx
    .select({ organizationId: branches.organizationId })
    .from(branches)
    .where(eq(branches.id, order.branchId))
    .limit(1)

  if (
    !organization
    || !isOrderApproverRole(organization.orderApproverRole)
    || !canExecutiveDecideOrder({
      reachOrganizationIds,
      order: {
        createdByRole: order.createdByRole,
        organizationId: order.organizationId,
        branchOrganizationId: branch?.organizationId,
      },
    })
  ) {
    return { ok: false, reason: "not-found" }
  }

  return {
    ok: true,
    order,
    // Recorded for the trail only; it does not decide anything here.
    configuredApproverRole: organization.orderApproverRole,
    decisionRole: APRICART_EXECUTIVE_ROLE,
  }
}

export async function getOrderDecisionCapabilities(
  scope: RequestScope | null,
): Promise<OrderDecisionCapabilities> {
  const denied: OrderDecisionCapabilities = {
    canApproveOrders: false,
    canRejectOrders: false,
    canReturnOrders: false,
    orderApproverRole: null,
  }

  if (!scope?.organizationId) return denied
  if (!canAttemptOrderDecision(scope.role)) return denied

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

  // A GROUP_USER decides for its assigned branches regardless of which role the
  // tenant configured as its standard approver, so it is resolved separately.
  if (isGroupApproverRole(scope.role)) {
    const scopedBranchIds = await resolveScopedBranchIds(db, scope.userId)
    const allowedForGroupUser = scopedBranchIds.length > 0
    return {
      canApproveOrders: allowedForGroupUser,
      canRejectOrders: allowedForGroupUser,
      canReturnOrders: allowedForGroupUser,
      orderApproverRole: organization.orderApproverRole,
    }
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
    canReturnOrders: allowed,
    orderApproverRole: organization.orderApproverRole,
  }
}

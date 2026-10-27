/**
 * Who decides an order the Order Desk entered.
 *
 * Every desk order starts `PENDING`, whatever its organization's own approval
 * switch says, and only an Apricart Executive assigned to that organization
 * may approve, reject or return it. The customer's own approvers — Head
 * Office, Branch Admin, Group User — decide every other order exactly as
 * before, and never a desk order. The customer's requesters may not edit or
 * resubmit one either: the desk corrects its own entries.
 *
 * Pure, so the decision policy, the routes and the screens all read the same
 * rule. The rows it judges are loaded by `lib/server/apricart-executive-scope.ts`
 * and `lib/server/order-decision-policy.ts`.
 *
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

import { APRICART_EXECUTIVE_ROLE } from "@/lib/apricart-executive-access"
import { ORDER_DESK_ROLE } from "@/lib/order-desk-access"

/** Recorded in the creation log, so the trail says why the order waits. */
export const DESK_ORDER_APPROVAL_BASIS = "APRICART_EXECUTIVE_APPROVAL"

/** An order is a desk entry by the creator's role as recorded on the order. */
export function isDeskEnteredOrder(order: { createdByRole?: string | null }): boolean {
  return order.createdByRole === ORDER_DESK_ROLE
}

export type OrderDecisionAuthority = typeof APRICART_EXECUTIVE_ROLE | "TENANT"

/** Who may approve, reject or return this order. */
export function orderDecisionAuthority(order: { createdByRole?: string | null }): OrderDecisionAuthority {
  return isDeskEnteredOrder(order) ? APRICART_EXECUTIVE_ROLE : "TENANT"
}

/**
 * Whether an executive whose approval reach is `reachOrganizationIds` may
 * decide this order: a desk entry, in an assigned organization, whose branch
 * belongs to that same organization. An empty reach decides nothing.
 */
export function canExecutiveDecideOrder(input: {
  reachOrganizationIds: readonly number[]
  order: {
    createdByRole?: string | null
    organizationId: number | null | undefined
    /** The organization the order's branch belongs to, read separately. */
    branchOrganizationId: number | null | undefined
  }
}): boolean {
  const { order } = input
  if (!isDeskEnteredOrder(order)) return false
  if (typeof order.organizationId !== "number") return false
  if (order.branchOrganizationId !== order.organizationId) return false
  return input.reachOrganizationIds.includes(order.organizationId)
}

/** Super Admin also decides desk orders — every one, with no assignment. */
export const SUPER_ADMIN_DESK_APPROVER_ROLE = "SUPER_ADMIN"

/**
 * Which desk orders an approver reaches: every one (an active Super Admin), or
 * those in the organizations assigned to an executive. Resolved from the rows
 * as they are now by `loadDeskApprovalReach`, never from the session.
 * See plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md.
 */
export type DeskApprovalReach =
  | { kind: "all" }
  | { kind: "organizations"; organizationIds: readonly number[] }

export function deskApprovalReachIsEmpty(reach: DeskApprovalReach): boolean {
  return reach.kind === "organizations" && reach.organizationIds.length === 0
}

/**
 * Whether Super Admin may decide this order: a desk entry whose branch belongs
 * to the order's own organization. Never an order the tenant's staff raised —
 * those stay with the tenant's approvers.
 */
export function canSuperAdminDecideDeskOrder(order: {
  createdByRole?: string | null
  organizationId: number | null | undefined
  branchOrganizationId: number | null | undefined
}): boolean {
  if (!isDeskEnteredOrder(order)) return false
  if (typeof order.organizationId !== "number") return false
  return order.branchOrganizationId === order.organizationId
}

/**
 * Whether a decision queues the usual notices — to the Order Portal raiser and
 * to Super Admin. Not for a decision on a desk order, by an executive or by
 * Super Admin: desk orders notify no one (the customer has no account to tell,
 * and the desk sees the outcome on its own list), and the notice builders
 * assume a deciding role inside the tenant.
 */
export function decisionQueuesNotifications(decisionRole: string): boolean {
  return decisionRole !== APRICART_EXECUTIVE_ROLE && decisionRole !== SUPER_ADMIN_DESK_APPROVER_ROLE
}

/**
 * The decision buttons a tenant reader is offered on one order: none on a
 * desk order, which an Apricart Executive decides; otherwise exactly what
 * the reader's role allows. The decision routes refuse a desk order anyway —
 * this only keeps the screen from offering what would be refused.
 */
export function decisionCapabilitiesForOrder<
  T extends { canApproveOrders: boolean; canRejectOrders: boolean; canReturnOrders: boolean },
>(capabilities: T, order: { createdByRole?: string | null }): T {
  if (!isDeskEnteredOrder(order)) return capabilities
  return { ...capabilities, canApproveOrders: false, canRejectOrders: false, canReturnOrders: false }
}

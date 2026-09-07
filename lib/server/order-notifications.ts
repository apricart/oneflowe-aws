import "server-only"

import { and, eq, inArray, isNull } from "drizzle-orm"

import {
  branches,
  emailOutbox,
  notifications,
  orders,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { sendOrderLifecycleEmail, type OrderLifecycleEmailPayload, type OrderLifecycleEmailTemplate } from "@/lib/email/order-lifecycle"
import { db } from "@/lib/db"
import { isValidEmailAddress } from "@/lib/validation/email"
import {
  isOrderApproverRole,
  isOrderDecisionRole,
  ORDER_APPROVER_ROLE_LABELS,
  ORDER_DECISION_ROLE_LABELS,
  type OrderApproverRole,
  type OrderDecisionRole,
} from "@/lib/order-approver-role"
import { ORDER_CREATOR_ROLES } from "@/lib/group-order-visibility"
import { GROUP_ORDER_PORTAL_ROLE, resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import {
  markFailedAttempt,
  markSent,
  markSkipped,
  runEmailOutbox,
  type ClaimedOutboxRow,
  type DeliveryOutcome,
} from "@/lib/server/email-outbox-runtime"
import {
  deliverClaimedSupportEmail,
  isSupportEmailTemplate,
} from "@/lib/server/support-notifications"

type OrderEventInput = {
  id: number
  tid: string
  organizationId: number | null
  branchId: number
  createdByUserId: string
}

export type QueuedOrderNotifications = {
  eventKeys: string[]
  recipientCount: number
}

export function orderNotificationEventKey(
  template: OrderLifecycleEmailTemplate,
  orderId: number,
  recipientUserId: string,
) {
  return `${template}:${orderId}:${recipientUserId}`
}

async function getOrderContext(tx: any, order: OrderEventInput) {
  if (!order.organizationId) return null

  const [context] = await tx
    .select({
      organizationName: organizations.name,
      orderApproverRole: organizations.orderApproverRole,
      branchName: branches.name,
    })
    .from(branches)
    .innerJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(and(
      eq(branches.id, order.branchId),
      eq(branches.organizationId, order.organizationId),
    ))
    .limit(1)

  return context || null
}

async function insertRecipientEvents(tx: any, input: {
  order: OrderEventInput & { organizationId: number }
  template: OrderLifecycleEmailTemplate
  targetRole: "BRANCH_ADMIN" | "HEAD_OFFICE" | "ORDER_PORTAL" | "SUPER_ADMIN"
  message: string
  payload: OrderLifecycleEmailPayload
  recipients: Array<{ id: string; email: string }>
}): Promise<QueuedOrderNotifications> {
  if (input.recipients.length === 0) return { eventKeys: [], recipientCount: 0 }

  const rows = input.recipients.map((recipient) => ({
    recipient,
    eventKey: orderNotificationEventKey(input.template, input.order.id, recipient.id),
  }))

  await tx.insert(notifications).values(rows.map(({ recipient, eventKey }) => ({
    userId: recipient.id,
    organizationId: input.order.organizationId,
    branchId: input.order.branchId,
    orderId: input.order.id,
    eventKey,
    type: input.template,
    targetRole: input.targetRole,
    message: input.message,
  }))).onConflictDoNothing()

  await tx.insert(emailOutbox).values(rows.map(({ recipient, eventKey }) => ({
    eventKey,
    recipientUserId: recipient.id,
    recipientEmail: recipient.email,
    recipientRole: input.targetRole,
    organizationId: input.order.organizationId,
    branchId: input.order.branchId,
    orderId: input.order.id,
    template: input.template,
    payload: input.payload,
  }))).onConflictDoNothing()

  return {
    eventKeys: rows.map((row) => row.eventKey),
    recipientCount: rows.length,
  }
}

/**
 * Confirm the person who raised the order really reaches the branch it was
 * raised for.
 *
 * An Order Portal user is pinned to one branch, so the comparison is direct. A
 * Group Order Portal user has no pinned branch — its reach is the set of
 * branches an administrator assigned it — so it is checked against that
 * resolved set instead, read inside the caller's transaction. An empty set
 * denies rather than widening to the organization.
 */
async function creatorReachesOrderBranch(
  tx: any,
  creator: { id: string; role: string; branchId: number | null },
  branchId: number,
): Promise<boolean> {
  if (creator.role === GROUP_ORDER_PORTAL_ROLE) {
    const scopedBranchIds = await resolveScopedBranchIds(tx, creator.id)
    return scopedBranchIds.includes(branchId)
  }
  return creator.branchId === branchId
}

export async function queueOrderCreatedNotifications(tx: any, input: {
  order: OrderEventInput
  requestedBy: string
}): Promise<QueuedOrderNotifications> {
  const { order } = input
  if (!order.organizationId) return { eventKeys: [], recipientCount: 0 }

  // Both requester roles raise orders that an approver has to decide, so both
  // have to be able to raise the "awaiting approval" event. Nothing else about
  // the notification changes: the recipients are still the tenant's configured
  // approvers for this order's branch.
  const [creator] = await tx
    .select({
      id: users.id,
      fullName: users.fullName,
      branchId: users.branchId,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, order.createdByUserId),
      inArray(roles.name, [...ORDER_CREATOR_ROLES]),
      eq(users.organizationId, order.organizationId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  if (!creator) return { eventKeys: [], recipientCount: 0 }
  if (!await creatorReachesOrderBranch(tx, creator, order.branchId)) {
    return { eventKeys: [], recipientCount: 0 }
  }

  const context = await getOrderContext(tx, order)
  if (!context || !isOrderApproverRole(context.orderApproverRole)) {
    throw new Error("ORDER_NOTIFICATION_SCOPE_INVALID")
  }
  const approverRole = context.orderApproverRole

  const recipients = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(roles.name, approverRole),
      eq(users.organizationId, order.organizationId),
      approverRole === "BRANCH_ADMIN" ? eq(users.branchId, order.branchId) : undefined,
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))

  return insertRecipientEvents(tx, {
    order: { ...order, organizationId: order.organizationId },
    template: "ORDER_CREATED",
    targetRole: approverRole,
    message: `Order ${order.tid} was submitted and is awaiting approval.`,
    payload: {
      orderId: order.id,
      tid: order.tid,
      organizationName: context.organizationName,
      branchName: context.branchName,
      requestedBy: creator.fullName?.trim() || input.requestedBy,
    },
    recipients,
  })
}

export async function queueOrderDecisionNotification(tx: any, input: {
  order: OrderEventInput
  decision: "APPROVED" | "REJECTED"
  rejectionReason?: string | null
}): Promise<QueuedOrderNotifications> {
  const { order } = input
  if (!order.organizationId) return { eventKeys: [], recipientCount: 0 }

  const [creator] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, order.createdByUserId),
      eq(roles.name, "ORDER_PORTAL"),
      eq(users.organizationId, order.organizationId),
      eq(users.branchId, order.branchId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  if (!creator) return { eventKeys: [], recipientCount: 0 }

  const context = await getOrderContext(tx, order)
  if (!context) throw new Error("ORDER_NOTIFICATION_SCOPE_INVALID")
  const template = input.decision === "APPROVED" ? "ORDER_APPROVED" : "ORDER_REJECTED"

  return insertRecipientEvents(tx, {
    order: { ...order, organizationId: order.organizationId },
    template,
    targetRole: "ORDER_PORTAL",
    message: (() => {
      if (input.decision === "APPROVED") {
        return `Order ${order.tid} was approved.`
      }
      return `Order ${order.tid} was rejected${input.rejectionReason ? (": " + String(input.rejectionReason)) : "."}`
    })(),
    payload: {
      orderId: order.id,
      tid: order.tid,
      organizationName: context.organizationName,
      branchName: context.branchName,
      rejectionReason: input.rejectionReason || null,
    },
    recipients: [creator],
  })
}

export async function queueSuperAdminApprovalNotifications(tx: any, input: {
  order: OrderEventInput
  approvedByUserId: string
  approvedByRole: OrderDecisionRole
}): Promise<QueuedOrderNotifications> {
  const { order } = input
  if (!order.organizationId) return { eventKeys: [], recipientCount: 0 }

  const context = await getOrderContext(tx, order)
  // A GROUP_USER approves on the strength of its own branch assignments, so it
  // is intentionally not required to match the tenant's configured approver
  // role. Every other approver still must.
  const contextMatchesApprover = input.approvedByRole === "GROUP_USER"
    ? Boolean(context)
    : context?.orderApproverRole === input.approvedByRole
  if (!contextMatchesApprover) {
    throw new Error("ORDER_NOTIFICATION_SCOPE_INVALID")
  }
  const approverLabel = ORDER_DECISION_ROLE_LABELS[input.approvedByRole]

  const [approver] = await tx
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, input.approvedByUserId),
      eq(roles.name, input.approvedByRole),
      eq(users.organizationId, order.organizationId),
      input.approvedByRole === "BRANCH_ADMIN" ? eq(users.branchId, order.branchId) : undefined,
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  if (!approver) return { eventKeys: [], recipientCount: 0 }

  const recipients = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(roles.name, "SUPER_ADMIN"),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))

  return insertRecipientEvents(tx, {
    order: { ...order, organizationId: order.organizationId },
    template: "ORDER_APPROVED_ADMIN",
    targetRole: "SUPER_ADMIN",
    message: `Order ${order.tid} was approved by ${approverLabel} and is ready for review.`,
    payload: {
      orderId: order.id,
      tid: order.tid,
      organizationName: context.organizationName,
      branchName: context.branchName,
      approvedBy: approver.fullName?.trim() || approverLabel,
      approvedByRole: input.approvedByRole,
    },
    recipients,
  })
}

function isLifecycleTemplate(value: string): value is OrderLifecycleEmailTemplate {
  return value === "ORDER_CREATED" ||
    value === "ORDER_APPROVED" ||
    value === "ORDER_REJECTED" ||
    value === "ORDER_APPROVED_ADMIN"
}

function parsePayload(value: Record<string, unknown>): OrderLifecycleEmailPayload | null {
  const orderId = Number(value?.orderId)
  if (
    !Number.isInteger(orderId) || orderId <= 0 ||
    typeof value?.tid !== "string" || !value.tid ||
    typeof value?.organizationName !== "string" ||
    typeof value?.branchName !== "string"
  ) {
    return null
  }

  return {
    orderId,
    tid: value.tid,
    organizationName: value.organizationName,
    branchName: value.branchName,
    requestedBy: typeof value.requestedBy === "string" ? value.requestedBy : null,
    approvedBy: typeof value.approvedBy === "string" ? value.approvedBy : null,
    approvedByRole: isOrderDecisionRole(value.approvedByRole) ? value.approvedByRole : null,
    rejectionReason: typeof value.rejectionReason === "string" ? value.rejectionReason : null,
  }
}

/**
 * `branch_id` became nullable on `email_outbox` when support threads started
 * sharing the table, so this asks for a row whose branch is already known to be
 * present. `deliverClaimedOrderEmail` establishes that before it calls in; the
 * rule itself is exactly what it always was.
 */
type OrderScopedOutboxRow = ClaimedOutboxRow & { orderId: number; branchId: number }

function recipientScopeCondition(row: OrderScopedOutboxRow) {
  if (row.recipientRole === "SUPER_ADMIN") return undefined
  if (row.recipientRole === "HEAD_OFFICE") return eq(users.organizationId, row.organizationId)
  return and(eq(users.organizationId, row.organizationId), eq(users.branchId, row.branchId))
}

async function deliverClaimedOrderEmail(claimed: ClaimedOutboxRow): Promise<DeliveryOutcome> {
  const template = isLifecycleTemplate(claimed.template) ? claimed.template : null
  const payload = parsePayload(claimed.payload)
  if (!template || !payload) {
    await markSkipped(claimed.id, "Invalid order email template or payload")
    return "skipped"
  }

  // `order_id` and `branch_id` became nullable when support threads joined this
  // table. Every order lifecycle row still carries both; one that does not is
  // malformed and is retired rather than delivered against a partial scope.
  // Past this guard the row is known to carry its whole order scope, which is
  // what the rest of this function has always assumed.
  if (claimed.orderId === null || claimed.branchId === null) {
    await markSkipped(claimed.id, "Order lifecycle email is missing its order scope")
    return "skipped"
  }
  const row: OrderScopedOutboxRow = { ...claimed, orderId: claimed.orderId, branchId: claimed.branchId }

  const currentApproverCondition = row.template === "ORDER_CREATED"
    ? eq(organizations.orderApproverRole, row.recipientRole)
    : undefined
  const [recipient] = await db
    .select({ email: users.email, role: roles.name, orderCreatorId: orders.createdByUserId })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(orders, eq(orders.id, row.orderId))
    .innerJoin(organizations, eq(orders.organizationId, organizations.id))
    .where(and(
      eq(users.id, row.recipientUserId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
      recipientScopeCondition(row),
      eq(roles.name, row.recipientRole),
      eq(orders.organizationId, row.organizationId),
      eq(orders.branchId, row.branchId),
      currentApproverCondition,
    ))
    .limit(1)

  const creatorMatches = row.recipientRole !== "ORDER_PORTAL" || recipient?.orderCreatorId === row.recipientUserId
  if (!recipient || !creatorMatches || !isValidEmailAddress(recipient.email)) {
    await markSkipped(row.id, "Recipient is no longer authorized for this order scope")
    return "skipped"
  }

  try {
    const providerMessageId = await sendOrderLifecycleEmail({ to: recipient.email, template, payload })
    await markSent(row.id, { recipientEmail: recipient.email, providerMessageId })
    return "sent"
  } catch (error) {
    return markFailedAttempt(row, error)
  }
}

/**
 * Which deliverer a claimed row belongs to.
 *
 * The outbox carries more than one kind of mail. An order lifecycle row takes
 * exactly the path it always has; a support row takes the support path.
 */
function deliverClaimedEmail(row: ClaimedOutboxRow): Promise<DeliveryOutcome> {
  return isSupportEmailTemplate(row.template)
    ? deliverClaimedSupportEmail(row)
    : deliverClaimedOrderEmail(row)
}

/**
 * Drains the email outbox.
 *
 * Kept under its original name because the cron route and every order handler
 * call it; it now drives the shared runtime and dispatches each claimed row to
 * the deliverer for its template family.
 */
export async function processOrderEmailOutbox(options?: {
  eventKeys?: string[]
  limit?: number
}) {
  return runEmailOutbox(deliverClaimedEmail, options)
}

export async function attemptImmediateOrderEmailDelivery(eventKeys: string[]) {
  if (eventKeys.length === 0) return

  try {
    const result = await processOrderEmailOutbox({ eventKeys, limit: eventKeys.length })
    if (result.retried || result.failed || result.skipped) {
      console.error("[OrderNotifications] Some lifecycle emails were not delivered immediately", {
        eventCount: eventKeys.length,
        sent: result.sent,
        retried: result.retried,
        failed: result.failed,
        skipped: result.skipped,
      })
    }
  } catch (error) {
    console.error("[OrderNotifications] Immediate outbox processing failed", {
      eventCount: eventKeys.length,
      error: error instanceof Error ? error.name : "UnknownError",
    })
  }
}

/**
 * The same immediate drain, under a name that does not claim to be about
 * orders. Support routes call this after queueing; the dispatcher sends each
 * claimed row down the path for its own template family.
 */
export const attemptImmediateEmailDelivery = attemptImmediateOrderEmailDelivery

import "server-only"

import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"

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

type DbLike = any

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

const MAX_DELIVERY_ATTEMPTS = 5
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000]
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function orderNotificationEventKey(
  template: OrderLifecycleEmailTemplate,
  orderId: number,
  recipientUserId: string,
) {
  return `${template}:${orderId}:${recipientUserId}`
}

async function getOrderContext(tx: DbLike, order: OrderEventInput) {
  if (!order.organizationId) return null

  const [context] = await tx
    .select({
      organizationName: organizations.name,
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

async function insertRecipientEvents(tx: DbLike, input: {
  order: OrderEventInput & { organizationId: number }
  template: OrderLifecycleEmailTemplate
  targetRole: "BRANCH_ADMIN" | "ORDER_PORTAL" | "SUPER_ADMIN"
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

export async function queueOrderCreatedNotifications(tx: DbLike, input: {
  order: OrderEventInput
  requestedBy: string
}): Promise<QueuedOrderNotifications> {
  const { order } = input
  if (!order.organizationId) return { eventKeys: [], recipientCount: 0 }

  const [creator] = await tx
    .select({ id: users.id, fullName: users.fullName })
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

  const recipients = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(roles.name, "BRANCH_ADMIN"),
      eq(users.organizationId, order.organizationId),
      eq(users.branchId, order.branchId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))

  const context = await getOrderContext(tx, order)
  if (!context) throw new Error("ORDER_NOTIFICATION_SCOPE_INVALID")

  return insertRecipientEvents(tx, {
    order: { ...order, organizationId: order.organizationId },
    template: "ORDER_CREATED",
    targetRole: "BRANCH_ADMIN",
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

export async function queueOrderDecisionNotification(tx: DbLike, input: {
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
    message: input.decision === "APPROVED"
      ? `Order ${order.tid} was approved.`
      : `Order ${order.tid} was rejected${input.rejectionReason ? `: ${input.rejectionReason}` : "."}`,
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

export async function queueSuperAdminApprovalNotifications(tx: DbLike, input: {
  order: OrderEventInput
  approvedByUserId: string
}): Promise<QueuedOrderNotifications> {
  const { order } = input
  if (!order.organizationId) return { eventKeys: [], recipientCount: 0 }

  const [approver] = await tx
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, input.approvedByUserId),
      eq(roles.name, "BRANCH_ADMIN"),
      eq(users.organizationId, order.organizationId),
      eq(users.branchId, order.branchId),
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

  const context = await getOrderContext(tx, order)
  if (!context) throw new Error("ORDER_NOTIFICATION_SCOPE_INVALID")

  return insertRecipientEvents(tx, {
    order: { ...order, organizationId: order.organizationId },
    template: "ORDER_APPROVED_ADMIN",
    targetRole: "SUPER_ADMIN",
    message: `Order ${order.tid} was approved by a Branch Admin and is ready for review.`,
    payload: {
      orderId: order.id,
      tid: order.tid,
      organizationName: context.organizationName,
      branchName: context.branchName,
      approvedBy: approver.fullName?.trim() || "Branch Admin",
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
    rejectionReason: typeof value.rejectionReason === "string" ? value.rejectionReason : null,
  }
}

function retryTime(attempts: number) {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
  return new Date(Date.now() + delay)
}

function safeDeliveryError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown email delivery error"
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000)
}

async function markSkipped(id: number, reason: string) {
  await db.update(emailOutbox).set({
    status: "SKIPPED",
    processingStartedAt: null,
    lastError: reason,
    updatedAt: new Date(),
  }).where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "PROCESSING")))
}

export async function processOrderEmailOutbox(options?: {
  eventKeys?: string[]
  limit?: number
}) {
  const eventKeys = Array.from(new Set((options?.eventKeys || []).filter(Boolean))).slice(0, 100)
  const limit = Math.min(Math.max(Math.floor(options?.limit || 25), 1), 50)
  const now = new Date()
  const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MS)

  const claimed = await db.transaction(async (tx) => {
    const eligibility = or(
      and(
        eq(emailOutbox.status, "PENDING"),
        or(isNull(emailOutbox.nextAttemptAt), lte(emailOutbox.nextAttemptAt, now)),
      ),
      and(
        eq(emailOutbox.status, "PROCESSING"),
        or(isNull(emailOutbox.processingStartedAt), lte(emailOutbox.processingStartedAt, staleBefore)),
      ),
    )

    await tx.update(emailOutbox).set({
      status: "FAILED",
      processingStartedAt: null,
      nextAttemptAt: null,
      lastError: "Delivery worker stopped after the maximum number of attempts",
      updatedAt: now,
    }).where(and(
      gte(emailOutbox.attempts, MAX_DELIVERY_ATTEMPTS),
      or(
        eq(emailOutbox.status, "PENDING"),
        and(
          eq(emailOutbox.status, "PROCESSING"),
          or(isNull(emailOutbox.processingStartedAt), lte(emailOutbox.processingStartedAt, staleBefore)),
        ),
      ),
    ))

    const conditions = [eligibility, lt(emailOutbox.attempts, MAX_DELIVERY_ATTEMPTS)]
    if (eventKeys.length > 0) conditions.push(inArray(emailOutbox.eventKey, eventKeys))

    const rows = await tx
      .select()
      .from(emailOutbox)
      .where(and(...conditions))
      .orderBy(asc(emailOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true })

    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    await tx.update(emailOutbox).set({
      status: "PROCESSING",
      processingStartedAt: now,
      attempts: sql`${emailOutbox.attempts} + 1`,
      updatedAt: now,
    }).where(inArray(emailOutbox.id, ids))

    return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }))
  })

  let sent = 0
  let retried = 0
  let failed = 0
  let skipped = 0

  for (const row of claimed) {
    const template = isLifecycleTemplate(row.template) ? row.template : null
    const payload = parsePayload(row.payload)
    if (!template || !payload) {
      await markSkipped(row.id, "Invalid order email template or payload")
      skipped++
      continue
    }

    const recipientScopeCondition = row.recipientRole === "SUPER_ADMIN"
      ? undefined
      : and(
        eq(users.organizationId, row.organizationId),
        eq(users.branchId, row.branchId),
      )

    const [recipient] = await db
      .select({
        email: users.email,
        role: roles.name,
        orderCreatorId: orders.createdByUserId,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .innerJoin(orders, eq(orders.id, row.orderId))
      .where(and(
        eq(users.id, row.recipientUserId),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        recipientScopeCondition,
        eq(roles.name, row.recipientRole),
        eq(orders.organizationId, row.organizationId),
        eq(orders.branchId, row.branchId),
      ))
      .limit(1)

    const creatorMatches = row.recipientRole !== "ORDER_PORTAL" || recipient?.orderCreatorId === row.recipientUserId
    if (!recipient || !creatorMatches || !EMAIL_PATTERN.test(recipient.email)) {
      await markSkipped(row.id, "Recipient is no longer authorized for this order scope")
      skipped++
      continue
    }

    try {
      const providerMessageId = await sendOrderLifecycleEmail({
        to: recipient.email,
        template,
        payload,
      })
      await db.update(emailOutbox).set({
        recipientEmail: recipient.email,
        status: "SENT",
        processingStartedAt: null,
        sentAt: new Date(),
        providerMessageId,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, "PROCESSING")))
      sent++
    } catch (error) {
      const terminal = row.attempts >= MAX_DELIVERY_ATTEMPTS
      await db.update(emailOutbox).set({
        status: terminal ? "FAILED" : "PENDING",
        processingStartedAt: null,
        nextAttemptAt: terminal ? null : retryTime(row.attempts),
        lastError: safeDeliveryError(error),
        updatedAt: new Date(),
      }).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, "PROCESSING")))
      if (terminal) failed++
      else retried++
    }
  }

  return { claimed: claimed.length, sent, retried, failed, skipped }
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

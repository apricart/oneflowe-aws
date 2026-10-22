import "server-only"

import { and, eq, inArray, isNull, ne } from "drizzle-orm"

import {
  branches,
  emailOutbox,
  notifications,
  orders,
  organizations,
  roles,
  supportThreads,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  parseSupportEmailPayload,
  sendSupportEmail,
  type SupportEmailPayload,
  type SupportEmailTemplate,
} from "@/lib/email/support"
import { isApricartSupportRole } from "@/lib/apricart-support-access"
import { isValidEmailAddress } from "@/lib/validation/email"
import { canReadSupportThread } from "@/lib/support-access"
import {
  SUPPORT_WHOLE_QUEUE_ROLES,
  isSupportApricartRole,
  supportThreadReference,
  type SupportSide,
} from "@/lib/support-thread"
import {
  markFailedAttempt,
  markSent,
  markSkipped,
  type ClaimedOutboxRow,
  type DeliveryOutcome,
} from "@/lib/server/email-outbox-runtime"
import { warehouseCityBranchOn, warehouseCityOrganizationOn } from "@/lib/server/warehouse-city-rule"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import { WAREHOUSE_ROLE, isWarehouseRole } from "@/lib/warehouse-access"

export { isSupportEmailTemplate } from "@/lib/email/support"

/**
 * Telling the other side that something happened on a support thread.
 *
 * Both channels are written in the caller's transaction: a `notifications` row
 * for the bell, and an `email_outbox` row for mail. Nothing is sent from inside
 * the transaction — the outbox worker delivers, so a failed send never rolls
 * back the message the user just posted, and a retried send never posts twice.
 *
 * **Who is told.** The people on the other side of the conversation, plus the
 * person who raised the thread when somebody else answers on their behalf:
 *
 * - a customer wrote → every active account on Apricart's whole queue, every
 *   active warehouse serving the thread's branch or its cited order's branch,
 *   and the raiser
 * - Apricart wrote  → the raiser
 *
 * A branch administrator and a head office reading their organization's queue
 * are deliberately not mailed for every reply; the thread's unread marker in
 * their list is what tells them it moved. Mailing them would turn one client's
 * conversation into everybody's inbox.
 */

export type SupportNotificationRecipient = {
  id: string
  email: string
  role: string
  organizationId: number | null
  branchId: number | null
}

export type QueuedSupportNotifications = {
  eventKeys: string[]
  recipientCount: number
}

export type SupportThreadEvent = {
  id: number
  organizationId: number
  subject: string
  category: string
  organizationName: string
}

/**
 * The event key is what makes queueing idempotent: the unique index on it means
 * a retried write inserts nothing rather than notifying twice.
 *
 * `discriminator` is the message id for a posted message, and the transition's
 * own timestamp for a status change — a thread can be resolved, reopened and
 * resolved again, and each of those is a separate event.
 */
export function supportNotificationEventKey(
  template: SupportEmailTemplate,
  threadId: number,
  discriminator: string | number,
  recipientUserId: string,
): string {
  return `${template}:${threadId}:${discriminator}:${recipientUserId}`
}

/**
 * The Apricart side of one thread: every active account on the whole queue —
 * Super Admin and the support agents, a party to every thread — and every
 * active warehouse whose reach covers it (plans/OF-WAREHOUSE-support-queue.md).
 */
async function apricartRecipients(tx: any, threadId: number): Promise<SupportNotificationRecipient[]> {
  const wholeQueue: SupportNotificationRecipient[] = await tx
    .select({
      id: users.id,
      email: users.email,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      inArray(roles.name, [...SUPPORT_WHOLE_QUEUE_ROLES]),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))

  return [...wholeQueue, ...await warehouseRecipients(tx, threadId)]
}

/**
 * The branches a thread is at, for the warehouse fence: its own branch and its
 * cited order's branch, each only when it belongs to the thread's organization
 * — the same two halves `supportBranchReachCondition` reads.
 */
async function supportThreadBranchIds(tx: any, threadId: number): Promise<number[]> {
  const [row] = await tx
    .select({
      organizationId: supportThreads.organizationId,
      branchId: supportThreads.branchId,
      branchOrganizationId: branches.organizationId,
      orderBranchId: orders.branchId,
      orderOrganizationId: orders.organizationId,
    })
    .from(supportThreads)
    .leftJoin(branches, eq(branches.id, supportThreads.branchId))
    .leftJoin(orders, eq(orders.id, supportThreads.orderId))
    .where(eq(supportThreads.id, threadId))
    .limit(1)
  if (!row) return []

  const ids: number[] = []
  if (row.branchId !== null && row.branchOrganizationId === row.organizationId) ids.push(row.branchId)
  if (row.orderBranchId !== null && row.orderOrganizationId === row.organizationId) ids.push(row.orderBranchId)
  return [...new Set(ids)]
}

/**
 * Every active warehouse account serving one of the thread's branches — by a
 * single-branch assignment or by the branch's city in a chosen organization — matched exactly as
 * `loadWarehouseReach` matches, so the people mailed are the people whose
 * queue lists the thread.
 */
async function warehouseRecipients(tx: any, threadId: number): Promise<SupportNotificationRecipient[]> {
  const branchIds = await supportThreadBranchIds(tx, threadId)
  if (branchIds.length === 0) return []

  const byBranch: Array<{ userId: string }> = await tx
    .select({ userId: warehouseAssignments.userId })
    .from(warehouseAssignments)
    .where(inArray(warehouseAssignments.branchId, branchIds))
  const byCity: Array<{ userId: string }> = await tx
    .select({ userId: warehouseCityAssignments.userId })
    .from(warehouseCityAssignments)
    .innerJoin(branches, warehouseCityBranchOn())
    .innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())
    .where(inArray(branches.id, branchIds))

  const userIds = [...new Set([...byBranch, ...byCity].map((row) => row.userId))]
  if (userIds.length === 0) return []

  return tx
    .select({
      id: users.id,
      email: users.email,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      inArray(users.id, userIds),
      eq(roles.name, WAREHOUSE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
}

/**
 * Whether a recipient reads support movement in an in-app bell. The support
 * agent has none (no topbar, the notifications API is outside its allowlist);
 * the warehouse's bell lists its order-stage notices alone
 * (`/api/v1/warehouse/notifications`). Both are mailed, and see movement in
 * the thread list's unread marker.
 */
function hasSupportBell(role: string): boolean {
  return !isApricartSupportRole(role) && !isWarehouseRole(role)
}

async function threadRaiser(
  tx: any,
  threadId: number,
  excludeUserId: string,
): Promise<SupportNotificationRecipient[]> {
  return tx
    .select({
      id: users.id,
      email: users.email,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(supportThreads)
    .innerJoin(users, eq(users.id, supportThreads.createdByUserId))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(supportThreads.id, threadId),
      ne(users.id, excludeUserId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)
}

async function insertSupportEvents(tx: any, input: {
  thread: SupportThreadEvent
  template: SupportEmailTemplate
  discriminator: string | number
  message: string
  actorName: string
  recipients: SupportNotificationRecipient[]
}): Promise<QueuedSupportNotifications> {
  const recipients = input.recipients.filter((recipient) => recipient?.id)
  if (recipients.length === 0) return { eventKeys: [], recipientCount: 0 }

  const rows = recipients.map((recipient) => ({
    recipient,
    eventKey: supportNotificationEventKey(
      input.template,
      input.thread.id,
      input.discriminator,
      recipient.id,
    ),
  }))

  // The bell scopes a notification against the *recipient's* own organization
  // and branch (`app/api/v1/notifications/route.ts`), so each row carries the
  // recipient's scope rather than the thread's. A row stamped with the thread's
  // branch would simply never be shown to a reader on another branch.
  //
  // A support agent and a warehouse are mailed but given no row their bell
  // would never show (`hasSupportBell`).
  const bellRows = rows.filter(({ recipient }) => hasSupportBell(recipient.role))
  if (bellRows.length > 0) {
    await tx.insert(notifications).values(bellRows.map(({ recipient, eventKey }) => ({
      userId: recipient.id,
      organizationId: recipient.organizationId,
      branchId: recipient.branchId,
      supportThreadId: input.thread.id,
      eventKey,
      type: input.template,
      targetRole: recipient.role,
      message: input.message,
    }))).onConflictDoNothing()
  }

  const payload: SupportEmailPayload = {
    threadId: input.thread.id,
    subject: input.thread.subject,
    category: input.thread.category,
    organizationName: input.thread.organizationName,
    actorName: input.actorName,
    toApricart: false,
  }

  await tx.insert(emailOutbox).values(rows.map(({ recipient, eventKey }) => ({
    eventKey,
    recipientUserId: recipient.id,
    recipientEmail: recipient.email,
    recipientRole: recipient.role,
    // The tenant the conversation belongs to — an Apricart recipient has no
    // organization of their own, and this column has never been nullable.
    organizationId: input.thread.organizationId,
    branchId: null,
    orderId: null,
    supportThreadId: input.thread.id,
    template: input.template,
    payload: { ...payload, toApricart: isSupportApricartRole(recipient.role) },
  }))).onConflictDoNothing()

  return { eventKeys: rows.map((row) => row.eventKey), recipientCount: rows.length }
}

/** A new thread has been raised, or a message posted to an existing one. */
export async function queueSupportMessageNotifications(tx: any, input: {
  thread: SupportThreadEvent
  messageId: number
  authorUserId: string
  authorSide: SupportSide
  authorName: string
  isFirstMessage: boolean
}): Promise<QueuedSupportNotifications> {
  const template: SupportEmailTemplate = input.isFirstMessage
    ? "SUPPORT_THREAD_OPENED"
    : "SUPPORT_MESSAGE_RECEIVED"

  const recipients: SupportNotificationRecipient[] = []
  if (input.authorSide === "CUSTOMER") {
    recipients.push(...await apricartRecipients(tx, input.thread.id))
  }
  // The raiser is told whenever somebody else moves their thread — Apricart
  // answering, or a colleague on their branch answering for them.
  recipients.push(...await threadRaiser(tx, input.thread.id, input.authorUserId))

  const reference = supportThreadReference(input.thread.id)
  const message = input.isFirstMessage
    ? `${input.authorName} raised support request ${reference}: ${input.thread.subject}`
    : `${input.authorName} replied on support request ${reference}.`

  return insertSupportEvents(tx, {
    thread: input.thread,
    template,
    discriminator: input.messageId,
    message,
    actorName: input.authorName,
    recipients: dedupeById(recipients, input.authorUserId),
  })
}

/** A thread has been resolved or closed by hand. */
export async function queueSupportStatusNotifications(tx: any, input: {
  thread: SupportThreadEvent
  template: Extract<SupportEmailTemplate, "SUPPORT_THREAD_RESOLVED" | "SUPPORT_THREAD_CLOSED">
  discriminator: string | number
  actorUserId: string
  actorSide: SupportSide
  actorName: string
}): Promise<QueuedSupportNotifications> {
  const recipients: SupportNotificationRecipient[] = []
  if (input.actorSide === "CUSTOMER") {
    recipients.push(...await apricartRecipients(tx, input.thread.id))
  }
  recipients.push(...await threadRaiser(tx, input.thread.id, input.actorUserId))

  const reference = supportThreadReference(input.thread.id)
  const verb = input.template === "SUPPORT_THREAD_RESOLVED" ? "resolved" : "closed"

  return insertSupportEvents(tx, {
    thread: input.thread,
    template: input.template,
    discriminator: input.discriminator,
    message: `${input.actorName} ${verb} support request ${reference}.`,
    actorName: input.actorName,
    recipients: dedupeById(recipients, input.actorUserId),
  })
}

function dedupeById(
  recipients: SupportNotificationRecipient[],
  excludeUserId: string,
): SupportNotificationRecipient[] {
  const seen = new Set<string>([excludeUserId])
  const unique: SupportNotificationRecipient[] = []
  for (const recipient of recipients) {
    if (!recipient?.id || seen.has(recipient.id)) continue
    seen.add(recipient.id)
    unique.push(recipient)
  }
  return unique
}

/**
 * Delivers one claimed support email.
 *
 * The recipient's right to the thread is re-checked at delivery time, against
 * the same rule the API uses. Between queueing and sending, a person can be
 * deactivated, moved to another branch, or have their role changed; a queued
 * row is not a standing grant, so a recipient who no longer passes the rule is
 * retired rather than mailed.
 */
export async function deliverClaimedSupportEmail(
  row: ClaimedOutboxRow,
): Promise<DeliveryOutcome> {
  const payload = parseSupportEmailPayload(row.payload)
  if (!payload || row.supportThreadId === null) {
    await markSkipped(row.id, "Invalid support email payload")
    return "skipped"
  }

  const [context] = await db
    .select({
      email: users.email,
      role: roles.name,
      userOrganizationId: users.organizationId,
      userBranchId: users.branchId,
      threadOrganizationId: supportThreads.organizationId,
      threadBranchId: supportThreads.branchId,
      threadCreatedByUserId: supportThreads.createdByUserId,
      orderBranchId: orders.branchId,
      orderOrganizationId: orders.organizationId,
      threadSubject: supportThreads.subject,
      threadCategory: supportThreads.category,
      organizationName: organizations.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(supportThreads, eq(supportThreads.id, row.supportThreadId))
    .innerJoin(organizations, eq(organizations.id, supportThreads.organizationId))
    .leftJoin(orders, eq(orders.id, supportThreads.orderId))
    .where(and(
      eq(users.id, row.recipientUserId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
      eq(roles.name, row.recipientRole),
    ))
    .limit(1)

  // A warehouse's reach is re-read now, so a branch or city withdrawn since the
  // message was queued is not mailed.
  const reachBranchIds = context && isWarehouseRole(context.role)
    ? await loadWarehouseReach(db, row.recipientUserId)
    : undefined

  const stillAuthorized = context
    ? canReadSupportThread({
        viewer: {
          userId: row.recipientUserId,
          role: context.role,
          organizationId: context.userOrganizationId,
          branchId: context.userBranchId,
          reachBranchIds,
        },
        thread: {
          organizationId: context.threadOrganizationId,
          branchId: context.threadBranchId,
          createdByUserId: context.threadCreatedByUserId,
          orderBranchId: context.orderOrganizationId === context.threadOrganizationId ? context.orderBranchId : null,
        },
      })
    : false

  if (!context || !stillAuthorized || !isValidEmailAddress(context.email)) {
    await markSkipped(row.id, "Recipient is no longer authorized for this support thread")
    return "skipped"
  }

  try {
    const providerMessageId = await sendSupportEmail({
      to: context.email,
      template: row.template as SupportEmailTemplate,
      payload: {
        ...payload,
        // Read back from the row rather than trusted from the queued payload,
        // so a renamed organization or edited subject cannot go stale.
        subject: context.threadSubject,
        category: context.threadCategory,
        organizationName: context.organizationName,
      },
    })
    await markSent(row.id, { recipientEmail: context.email, providerMessageId })
    return "sent"
  } catch (error) {
    return markFailedAttempt(row, error)
  }
}

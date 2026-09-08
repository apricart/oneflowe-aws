import "server-only"

import { and, eq, isNull, ne } from "drizzle-orm"

import { emailOutbox, notifications, organizations, roles, supportThreads, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  parseSupportEmailPayload,
  sendSupportEmail,
  type SupportEmailPayload,
  type SupportEmailTemplate,
} from "@/lib/email/support"
import { isValidEmailAddress } from "@/lib/validation/email"
import { canReadSupportThread } from "@/lib/support-access"
import { supportThreadReference, type SupportSide } from "@/lib/support-thread"
import {
  markFailedAttempt,
  markSent,
  markSkipped,
  type ClaimedOutboxRow,
  type DeliveryOutcome,
} from "@/lib/server/email-outbox-runtime"

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
 * - a customer wrote → every active Apricart administrator, and the raiser
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

/** Every active Apricart administrator. Apricart is a party to every thread. */
async function apricartRecipients(tx: any): Promise<SupportNotificationRecipient[]> {
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
      eq(roles.name, "SUPER_ADMIN"),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
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
  await tx.insert(notifications).values(rows.map(({ recipient, eventKey }) => ({
    userId: recipient.id,
    organizationId: recipient.organizationId,
    branchId: recipient.branchId,
    supportThreadId: input.thread.id,
    eventKey,
    type: input.template,
    targetRole: recipient.role,
    message: input.message,
  }))).onConflictDoNothing()

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
    payload: { ...payload, toApricart: recipient.role === "SUPER_ADMIN" },
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
    recipients.push(...await apricartRecipients(tx))
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
    recipients.push(...await apricartRecipients(tx))
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
      threadSubject: supportThreads.subject,
      threadCategory: supportThreads.category,
      organizationName: organizations.name,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .innerJoin(supportThreads, eq(supportThreads.id, row.supportThreadId))
    .innerJoin(organizations, eq(organizations.id, supportThreads.organizationId))
    .where(and(
      eq(users.id, row.recipientUserId),
      eq(users.isActive, true),
      isNull(users.deletedAt),
      eq(roles.name, row.recipientRole),
    ))
    .limit(1)

  const stillAuthorized = context
    ? canReadSupportThread({
        viewer: {
          userId: row.recipientUserId,
          role: context.role,
          organizationId: context.userOrganizationId,
          branchId: context.userBranchId,
        },
        thread: {
          organizationId: context.threadOrganizationId,
          branchId: context.threadBranchId,
          createdByUserId: context.threadCreatedByUserId,
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

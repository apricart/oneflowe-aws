import "server-only"

import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm"

import {
  branches,
  globalProducts,
  orders,
  organizationInventory,
  organizations,
  roles,
  supportAttachments,
  supportMessages,
  supportThreadReads,
  supportThreads,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  canReferenceOrderInSupportThread,
  supportThreadVisibilityScope,
  type SupportViewer,
} from "@/lib/support-access"
import {
  SUPPORT_APRICART_ROLES,
  nextSupportStatusAfterMessage,
  supportOrderSearchId,
  supportSideForRole,
  supportThreadReference,
  type SupportCategory,
  type SupportPriority,
  type SupportSide,
  type SupportStatus,
} from "@/lib/support-thread"
import {
  EMPTY_SUPPORT_STATS,
  normalizeSupportStats,
  type SupportStats,
} from "@/lib/support-stats"
import { escapeLikePattern } from "@/lib/utils"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import {
  queueSupportMessageNotifications,
  queueSupportStatusNotifications,
  type QueuedSupportNotifications,
  type SupportThreadEvent,
} from "@/lib/server/support-notifications"

/**
 * Reading and writing support threads.
 *
 * The rules live in `lib/support-access.ts` and `lib/support-thread.ts`, which
 * are pure. This module is the part that needs Postgres: it turns a viewer's
 * visibility scope into a `where` clause, and it does every write inside a
 * transaction so a thread, its first message, its attachments and the
 * notifications about it either all land or none do.
 */

/** How long an uploaded attachment may sit unclaimed before a message may take it. */
export const ATTACHMENT_CLAIM_WINDOW_MS = 2 * 60 * 60 * 1000

export const SUPPORT_THREAD_PAGE_SIZE_DEFAULT = 20
export const SUPPORT_THREAD_PAGE_SIZE_MAX = 50

export type SupportServiceFailure = { message: string; status: number }

function failure(message: string, status: number): SupportServiceFailure {
  return { message, status }
}

/**
 * Turns a viewer's visibility scope into the tenant predicate every read
 * carries. Returns null when the viewer may see nothing at all, so a caller
 * that forgets to handle it produces an empty list rather than the whole table.
 */
export function supportScopeCondition(viewer: SupportViewer): SQL | null {
  const scope = supportThreadVisibilityScope(viewer)
  switch (scope.kind) {
    case "all":
      // Deliberately a tautology rather than `undefined`: an accidental
      // `and(...)` with nothing in it must not become "no filter" by accident
      // for some other scope.
      return sql`true`
    case "organization":
      return eq(supportThreads.organizationId, scope.organizationId)
    case "branch":
      return and(
        eq(supportThreads.organizationId, scope.organizationId),
        or(
          eq(supportThreads.branchId, scope.branchId),
          eq(supportThreads.createdByUserId, scope.userId),
        ),
      )!
    case "own":
      return and(
        eq(supportThreads.organizationId, scope.organizationId),
        eq(supportThreads.createdByUserId, scope.userId),
      )!
    default:
      return null
  }
}

/**
 * Matching a thread by the order it is about.
 *
 * An `EXISTS` rather than a predicate on the joined `orders` row, because the
 * list shares one `where` between a count that reads `support_threads` alone
 * and a row query that joins `orders` — naming `orders.tid` in the shared
 * predicate would drag the join into the count as well. Either way it is a
 * primary-key lookup.
 *
 * The term is escaped before it reaches the pattern, so a typed `%` searches
 * for a percent sign rather than turning the filter into "everything". A bare
 * number also matches the internal id, which is what an internal link carries.
 */
function supportOrderSearchCondition(term: string): SQL {
  const pattern = `%${escapeLikePattern(term)}%`
  const matches: SQL[] = [
    sql`exists (
      select 1 from ${orders}
      where ${orders.id} = ${supportThreads.orderId}
      and ${orders.tid} ilike ${pattern}
    )`,
  ]

  const orderId = supportOrderSearchId(term)
  if (orderId) matches.push(eq(supportThreads.orderId, orderId))

  return or(...matches)!
}

export type SupportThreadListItem = {
  id: number
  reference: string
  subject: string
  category: string
  status: string
  priority: string
  organizationId: number
  organizationName: string | null
  branchId: number | null
  branchName: string | null
  orderId: number | null
  orderTid: string | null
  productId: number | null
  /** The catalogue code, e.g. `KE-00421`. What people actually quote. */
  productCode: string | null
  /** The organization's own name for it, falling back to the catalogue name. */
  productName: string | null
  createdByUserId: string
  createdByName: string | null
  assignedToName: string | null
  messageCount: number
  lastMessageAt: Date
  lastMessageSide: string
  createdAt: Date | null
  unread: boolean
}

export type SupportThreadListFilters = {
  status?: SupportStatus
  category?: SupportCategory
  /** Apricart may narrow to one tenant; every other role is already narrowed. */
  organizationId?: number
  orderId?: number
  /** A reference the person typed, matched against the order the thread cites. */
  orderSearch?: string
  threadId?: number
  page?: number
  pageSize?: number
}

export async function listSupportThreads(
  viewer: SupportViewer,
  filters: SupportThreadListFilters = {},
): Promise<{ items: SupportThreadListItem[]; total: number; unreadCount: number; page: number; pageSize: number }> {
  const scopeCondition = supportScopeCondition(viewer)
  const pageSize = Math.min(
    Math.max(Math.floor(filters.pageSize || SUPPORT_THREAD_PAGE_SIZE_DEFAULT), 1),
    SUPPORT_THREAD_PAGE_SIZE_MAX,
  )
  const page = Math.max(Math.floor(filters.page || 1), 1)

  if (!scopeCondition) {
    return { items: [], total: 0, unreadCount: 0, page, pageSize }
  }

  const conditions: SQL[] = [scopeCondition]
  if (filters.status) conditions.push(eq(supportThreads.status, filters.status))
  if (filters.category) conditions.push(eq(supportThreads.category, filters.category))
  if (filters.organizationId) conditions.push(eq(supportThreads.organizationId, filters.organizationId))
  if (filters.orderId) conditions.push(eq(supportThreads.orderId, filters.orderId))
  // Pushed onto the same array the scope condition opens, so a search can only
  // ever narrow what the viewer could already read.
  if (filters.orderSearch) conditions.push(supportOrderSearchCondition(filters.orderSearch))
  if (filters.threadId) conditions.push(eq(supportThreads.id, filters.threadId))

  const where = and(...conditions)!

  const [{ total }] = await db
    .select({ total: count() })
    .from(supportThreads)
    .where(where)

  const rows = await db
    .select({
      id: supportThreads.id,
      subject: supportThreads.subject,
      category: supportThreads.category,
      status: supportThreads.status,
      priority: supportThreads.priority,
      organizationId: supportThreads.organizationId,
      organizationName: organizations.name,
      branchId: supportThreads.branchId,
      branchName: branches.name,
      orderId: supportThreads.orderId,
      orderTid: orders.tid,
      productId: supportThreads.productId,
      productCode: globalProducts.productCode,
      productName: sql<string | null>`coalesce(${organizationInventory.customName}, ${globalProducts.name})`,
      createdByUserId: supportThreads.createdByUserId,
      createdByName: users.fullName,
      messageCount: supportThreads.messageCount,
      lastMessageAt: supportThreads.lastMessageAt,
      lastMessageSide: supportThreads.lastMessageSide,
      createdAt: supportThreads.createdAt,
      lastReadAt: supportThreadReads.lastReadAt,
    })
    .from(supportThreads)
    .leftJoin(organizations, eq(organizations.id, supportThreads.organizationId))
    .leftJoin(branches, eq(branches.id, supportThreads.branchId))
    .leftJoin(orders, eq(orders.id, supportThreads.orderId))
    .leftJoin(globalProducts, eq(globalProducts.id, supportThreads.productId))
    // The tenant's own name for the product, when it has set one. Joined on the
    // thread's organization, never the viewer's — Apricart reads every tenant's
    // threads and must see each one's product named as that tenant names it.
    .leftJoin(
      organizationInventory,
      and(
        eq(organizationInventory.globalProductId, supportThreads.productId),
        eq(organizationInventory.organizationId, supportThreads.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, supportThreads.createdByUserId))
    .leftJoin(
      supportThreadReads,
      and(
        eq(supportThreadReads.threadId, supportThreads.id),
        eq(supportThreadReads.userId, viewer.userId),
      ),
    )
    .where(where)
    .orderBy(desc(supportThreads.lastMessageAt), desc(supportThreads.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)

  // The assignee is a second lookup rather than a second join on `users`, which
  // would need an alias and is only ever a handful of rows.
  const assigneeNames = await loadAssigneeNames(rows.map((row) => row.id))

  const items = rows.map((row) => ({
    id: row.id,
    reference: supportThreadReference(row.id),
    subject: row.subject,
    category: row.category,
    status: row.status,
    priority: row.priority,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    branchId: row.branchId,
    branchName: row.branchName,
    orderId: row.orderId,
    orderTid: row.orderTid,
    productId: row.productId,
    productCode: row.productCode,
    productName: row.productName,
    createdByUserId: row.createdByUserId,
    createdByName: row.createdByName,
    assignedToName: assigneeNames.get(row.id) ?? null,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
    lastMessageSide: row.lastMessageSide,
    createdAt: row.createdAt,
    unread: !row.lastReadAt || row.lastMessageAt > row.lastReadAt,
  }))

  const [{ unread }] = await db
    .select({ unread: count() })
    .from(supportThreads)
    .leftJoin(
      supportThreadReads,
      and(
        eq(supportThreadReads.threadId, supportThreads.id),
        eq(supportThreadReads.userId, viewer.userId),
      ),
    )
    .where(and(
      scopeCondition,
      or(
        isNull(supportThreadReads.lastReadAt),
        gt(supportThreads.lastMessageAt, supportThreadReads.lastReadAt),
      ),
    ))

  return { items, total, unreadCount: unread, page, pageSize }
}

/**
 * The figures behind the queue's KPI row.
 *
 * Deliberately built on the same `supportScopeCondition` the list uses, so the
 * counts cover exactly the threads the caller could open. A branch
 * administrator's "12 open" is twelve threads they can click; there is no
 * aggregate here that spans further than the list does.
 *
 * One pass over `support_threads` with filtered counts rather than a query per
 * tile: the joins and the predicate are identical for all of them, and the
 * scope columns are indexed. The read-state join is the same left join the list
 * uses for its unread count.
 *
 * Unfiltered by status or category on purpose — the row is the overview the
 * list's filters narrow against, not a second view of the current filter.
 */
export async function getSupportThreadStats(viewer: SupportViewer): Promise<SupportStats> {
  const scopeCondition = supportScopeCondition(viewer)
  if (!scopeCondition) return { ...EMPTY_SUPPORT_STATS }

  const live = sql`${supportThreads.status} IN ('OPEN', 'AWAITING_CUSTOMER')`

  const [row] = await db
    .select({
      total: count(),
      open: sql`count(*) filter (where ${supportThreads.status} = 'OPEN')`,
      awaitingCustomer: sql`count(*) filter (where ${supportThreads.status} = 'AWAITING_CUSTOMER')`,
      resolved: sql`count(*) filter (where ${supportThreads.status} = 'RESOLVED')`,
      closed: sql`count(*) filter (where ${supportThreads.status} = 'CLOSED')`,
      urgent: sql`count(*) filter (where ${live} and ${supportThreads.priority} IN ('HIGH', 'URGENT'))`,
      unanswered: sql`count(*) filter (where ${live} and ${supportThreads.firstResponseAt} is null)`,
      openedLast7Days: sql`count(*) filter (where ${supportThreads.createdAt} >= now() - interval '7 days')`,
      unread: sql`count(*) filter (where ${supportThreadReads.lastReadAt} is null or ${supportThreads.lastMessageAt} > ${supportThreadReads.lastReadAt})`,
      // Averaged in minutes here rather than in the client, and null when no
      // thread has been answered yet — `avg` ignores the unanswered rows.
      avgFirstResponseMinutes: sql`avg(extract(epoch from (${supportThreads.firstResponseAt} - ${supportThreads.createdAt})) / 60.0) filter (where ${supportThreads.firstResponseAt} is not null)`,
    })
    .from(supportThreads)
    .leftJoin(
      supportThreadReads,
      and(
        eq(supportThreadReads.threadId, supportThreads.id),
        eq(supportThreadReads.userId, viewer.userId),
      ),
    )
    .where(scopeCondition)

  // The driver hands bigint counts and a numeric average back as strings, so
  // the row goes through the same tolerant reader the client uses.
  return normalizeSupportStats(row)
}

async function loadAssigneeNames(threadIds: number[]): Promise<Map<number, string | null>> {
  const names = new Map<number, string | null>()
  if (threadIds.length === 0) return names

  const rows = await db
    .select({ threadId: supportThreads.id, fullName: users.fullName })
    .from(supportThreads)
    .innerJoin(users, eq(users.id, supportThreads.assignedToUserId))
    .where(and(inArray(supportThreads.id, threadIds), isNotNull(supportThreads.assignedToUserId)))

  for (const row of rows) names.set(row.threadId, row.fullName)
  return names
}

export type SupportThreadDetail = SupportThreadListItem & {
  assignedToUserId: string | null
  resolvedAt: Date | null
  closedAt: Date | null
  messages: Array<{
    id: number
    authorUserId: string
    authorName: string | null
    authorSide: string
    authorRole: string
    body: string
    createdAt: Date | null
    attachments: Array<{ id: number; fileName: string; contentType: string; sizeBytes: number }>
  }>
}

/**
 * Loads a thread the viewer may read, or null.
 *
 * Null covers both "no such thread" and "not yours" on purpose: the caller
 * answers 404 for either, so a thread id cannot be probed for existence.
 */
export async function getSupportThreadForViewer(
  viewer: SupportViewer,
  threadId: number,
): Promise<SupportThreadDetail | null> {
  const listed = await listSupportThreads(viewer, { threadId, pageSize: 1, page: 1 })
  const summary = listed.items[0]
  if (!summary) return null

  const [extra] = await db
    .select({
      assignedToUserId: supportThreads.assignedToUserId,
      resolvedAt: supportThreads.resolvedAt,
      closedAt: supportThreads.closedAt,
    })
    .from(supportThreads)
    .where(eq(supportThreads.id, threadId))
    .limit(1)

  const messageRows = await db
    .select({
      id: supportMessages.id,
      authorUserId: supportMessages.authorUserId,
      authorName: users.fullName,
      authorSide: supportMessages.authorSide,
      authorRole: supportMessages.authorRole,
      body: supportMessages.body,
      createdAt: supportMessages.createdAt,
    })
    .from(supportMessages)
    .leftJoin(users, eq(users.id, supportMessages.authorUserId))
    .where(eq(supportMessages.threadId, threadId))
    .orderBy(supportMessages.createdAt, supportMessages.id)

  const attachmentRows = messageRows.length === 0 ? [] : await db
    .select({
      id: supportAttachments.id,
      messageId: supportAttachments.messageId,
      fileName: supportAttachments.fileName,
      contentType: supportAttachments.contentType,
      sizeBytes: supportAttachments.sizeBytes,
    })
    .from(supportAttachments)
    .where(eq(supportAttachments.threadId, threadId))

  const byMessage = new Map<number, SupportThreadDetail["messages"][number]["attachments"]>()
  for (const attachment of attachmentRows) {
    if (attachment.messageId === null) continue
    const bucket = byMessage.get(attachment.messageId) || []
    bucket.push({
      id: attachment.id,
      fileName: attachment.fileName,
      contentType: attachment.contentType,
      sizeBytes: attachment.sizeBytes,
    })
    byMessage.set(attachment.messageId, bucket)
  }

  return {
    ...summary,
    assignedToUserId: extra?.assignedToUserId ?? null,
    resolvedAt: extra?.resolvedAt ?? null,
    closedAt: extra?.closedAt ?? null,
    messages: messageRows.map((message) => ({
      ...message,
      attachments: byMessage.get(message.id) || [],
    })),
  }
}

/** Records how far this viewer has read. Upsert, so it is safe to call on every open. */
export async function markSupportThreadRead(threadId: number, userId: string): Promise<void> {
  await db
    .insert(supportThreadReads)
    .values({ threadId, userId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [supportThreadReads.threadId, supportThreadReads.userId],
      set: { lastReadAt: new Date() },
    })
}

/**
 * Claims attachments for a message, inside the caller's transaction.
 *
 * Three conditions, all of them load-bearing: the row is still unclaimed, this
 * caller uploaded it, and it is recent. Without the uploader check, an id is
 * enough to staple somebody else's screenshot into your own thread.
 */
async function claimAttachments(tx: any, input: {
  attachmentIds: number[]
  uploaderUserId: string
  organizationId: number
  threadId: number
  messageId: number
}): Promise<number> {
  const ids = Array.from(new Set(input.attachmentIds.filter((id) => Number.isInteger(id) && id > 0)))
  if (ids.length === 0) return 0

  const claimed = await tx
    .update(supportAttachments)
    .set({ threadId: input.threadId, messageId: input.messageId })
    .where(and(
      inArray(supportAttachments.id, ids),
      eq(supportAttachments.uploadedByUserId, input.uploaderUserId),
      eq(supportAttachments.organizationId, input.organizationId),
      isNull(supportAttachments.messageId),
      gt(supportAttachments.createdAt, new Date(Date.now() - ATTACHMENT_CLAIM_WINDOW_MS)),
    ))
    .returning({ id: supportAttachments.id })

  return claimed.length
}

async function loadThreadEvent(tx: any, threadId: number): Promise<SupportThreadEvent | null> {
  const [row] = await tx
    .select({
      id: supportThreads.id,
      organizationId: supportThreads.organizationId,
      subject: supportThreads.subject,
      category: supportThreads.category,
      organizationName: organizations.name,
    })
    .from(supportThreads)
    .innerJoin(organizations, eq(organizations.id, supportThreads.organizationId))
    .where(eq(supportThreads.id, threadId))
    .limit(1)

  return row || null
}

export type SupportAuthor = {
  userId: string
  role: string
  fullName: string
  organizationId: number
  branchId: number | null
}

export type CreateSupportThreadInput = {
  author: SupportAuthor
  subject: string
  category: SupportCategory
  priority: SupportPriority
  orderId: number | null
  productId: number | null
  body: string
  attachmentIds: number[]
}

export type CreateSupportThreadResult =
  | { ok: true; threadId: number; reference: string; queued: QueuedSupportNotifications }
  | { ok: false; failure: SupportServiceFailure }

/**
 * Opens a thread and posts its first message.
 *
 * The order and product references are verified here, not in the route handler,
 * because each check needs its own row and must happen in the same transaction
 * that writes the thread — otherwise a caller could cite something they lost
 * access to between the check and the write.
 */
export async function createSupportThread(
  input: CreateSupportThreadInput,
): Promise<CreateSupportThreadResult> {
  const side = supportSideForRole(input.author.role)

  return db.transaction(async (tx) => {
    let orderId: number | null = null
    if (input.orderId !== null) {
      const verified = await verifyOrderReference(tx, input.author, input.orderId)
      if (!verified.ok) return { ok: false as const, failure: verified.failure }
      orderId = verified.orderId
    }

    let productId: number | null = null
    if (input.productId !== null) {
      const verified = await verifyProductReference(tx, input.author, input.productId)
      if (!verified.ok) return { ok: false as const, failure: verified.failure }
      productId = verified.productId
    }

    const now = new Date()
    const [thread] = await tx
      .insert(supportThreads)
      .values({
        organizationId: input.author.organizationId,
        branchId: input.author.branchId,
        orderId,
        productId,
        subject: input.subject,
        category: input.category,
        status: side === "APRICART" ? "AWAITING_CUSTOMER" : "OPEN",
        priority: input.priority,
        createdByUserId: input.author.userId,
        messageCount: 1,
        lastMessageAt: now,
        lastMessageSide: side,
        firstResponseAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: supportThreads.id })

    const [message] = await tx
      .insert(supportMessages)
      .values({
        threadId: thread.id,
        authorUserId: input.author.userId,
        authorSide: side,
        authorRole: input.author.role,
        body: input.body,
        createdAt: now,
      })
      .returning({ id: supportMessages.id })

    await claimAttachments(tx, {
      attachmentIds: input.attachmentIds,
      uploaderUserId: input.author.userId,
      organizationId: input.author.organizationId,
      threadId: thread.id,
      messageId: message.id,
    })

    // The author has read what they just wrote.
    await tx
      .insert(supportThreadReads)
      .values({ threadId: thread.id, userId: input.author.userId, lastReadAt: now })
      .onConflictDoNothing()

    const event = await loadThreadEvent(tx, thread.id)
    const queued = event
      ? await queueSupportMessageNotifications(tx, {
          thread: event,
          messageId: message.id,
          authorUserId: input.author.userId,
          authorSide: side,
          authorName: input.author.fullName,
          isFirstMessage: true,
        })
      : { eventKeys: [], recipientCount: 0 }

    // Inside the same transaction as the thread, so a rolled-back creation
    // never announces itself in the trail. The message body is deliberately
    // absent: it is the customer's own words, it can be long, and the trail
    // records that a channel was opened rather than duplicating its contents.
    await recordAuditEvent(tx, {
      action: "CREATE_SUPPORT_THREAD",
      entity: "support_thread",
      entityId: thread.id,
      actor: { id: input.author.userId, role: input.author.role },
      organizationId: input.author.organizationId,
      branchId: input.author.branchId,
      after: {
        reference: supportThreadReference(thread.id),
        subject: input.subject,
        category: input.category,
        priority: input.priority,
      },
      context: {
        authorSide: side,
        orderId,
        productId,
        attachmentCount: input.attachmentIds.length,
        notifiedRecipients: queued.recipientCount,
      },
    })

    return {
      ok: true as const,
      threadId: thread.id,
      reference: supportThreadReference(thread.id),
      queued,
    }
  })
}

async function verifyOrderReference(
  tx: any,
  author: SupportAuthor,
  orderId: number,
): Promise<{ ok: true; orderId: number } | { ok: false; failure: SupportServiceFailure }> {
  const [order] = await tx
    .select({
      id: orders.id,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      createdByUserId: orders.createdByUserId,
      groupOrderId: orders.groupOrderId,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)

  const scopedBranchIds = order
    ? await resolveScopedBranchIds(tx, author.userId).catch(() => [] as number[])
    : []

  const allowed = canReferenceOrderInSupportThread({
    viewer: {
      userId: author.userId,
      role: author.role,
      organizationId: author.organizationId,
      branchId: author.branchId,
    },
    order,
    scopedBranchIds,
  })

  // One answer for "no such order" and "not yours", so the field cannot be used
  // to discover which order ids exist.
  return allowed
    ? { ok: true, orderId: order.id }
    : { ok: false, failure: failure("That order could not be found.", 400) }
}

/**
 * May this author cite this product?
 *
 * The rule is one fact: the product is assigned to the author's **own**
 * organization, enabled, and not withdrawn from the catalogue. That is narrower
 * than the order rule deliberately — a catalogue entry is tenant-wide, so there
 * is no branch or ownership dimension to it, and an organization's assignment
 * row is exactly the statement "we carry this".
 *
 * That row is `organization_inventory`, which is what the Super Admin
 * assignment endpoint writes and what `/api/v1/branch/inventory` reads to build
 * the store. `organization_products` carries the same shape and is written by
 * nothing but the K-Electric sync, so joining it would refuse every product of
 * every tenant whose catalogue was assigned through the application.
 *
 * The organization comes from the author, which `resolveSupportAuthor` read
 * from the database. Nothing here trusts the request beyond the id itself.
 */
async function verifyProductReference(
  tx: any,
  author: SupportAuthor,
  productId: number,
): Promise<{ ok: true; productId: number } | { ok: false; failure: SupportServiceFailure }> {
  const [product] = await tx
    .select({ id: globalProducts.id })
    .from(globalProducts)
    .innerJoin(
      organizationInventory,
      and(
        eq(organizationInventory.globalProductId, globalProducts.id),
        eq(organizationInventory.organizationId, author.organizationId),
        eq(organizationInventory.isActive, true),
        isNull(organizationInventory.deletedAt),
      ),
    )
    .where(and(eq(globalProducts.id, productId), isNull(globalProducts.deletedAt)))
    .limit(1)

  // One answer for "no such product" and "not carried by your organization", so
  // the field cannot be used to enumerate another tenant's catalogue.
  return product
    ? { ok: true, productId: product.id }
    : { ok: false, failure: failure("That product could not be found.", 400) }
}

export type PostSupportMessageInput = {
  author: SupportAuthor
  threadId: number
  body: string
  attachmentIds: number[]
}

export type PostSupportMessageResult =
  | { ok: true; messageId: number; status: SupportStatus; queued: QueuedSupportNotifications }
  | { ok: false; failure: SupportServiceFailure }

/**
 * Posts a reply.
 *
 * The thread row is taken `FOR UPDATE` so two people replying at the same
 * moment cannot both compute the message count and the status from the same
 * stale read.
 */
export async function postSupportMessage(
  input: PostSupportMessageInput,
): Promise<PostSupportMessageResult> {
  const side = supportSideForRole(input.author.role)

  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select({
        id: supportThreads.id,
        organizationId: supportThreads.organizationId,
        branchId: supportThreads.branchId,
        createdByUserId: supportThreads.createdByUserId,
        status: supportThreads.status,
        messageCount: supportThreads.messageCount,
        firstResponseAt: supportThreads.firstResponseAt,
        lastMessageSide: supportThreads.lastMessageSide,
      })
      .from(supportThreads)
      .where(eq(supportThreads.id, input.threadId))
      .limit(1)
      .for("update")

    if (!thread) return { ok: false as const, failure: failure("Support request not found.", 404) }
    if (thread.status === "CLOSED") {
      return {
        ok: false as const,
        failure: failure("This request is closed. Raise a new one to take it further.", 409),
      }
    }

    const now = new Date()
    const [message] = await tx
      .insert(supportMessages)
      .values({
        threadId: thread.id,
        authorUserId: input.author.userId,
        authorSide: side,
        authorRole: input.author.role,
        body: input.body,
        createdAt: now,
      })
      .returning({ id: supportMessages.id })

    await claimAttachments(tx, {
      attachmentIds: input.attachmentIds,
      uploaderUserId: input.author.userId,
      organizationId: thread.organizationId,
      threadId: thread.id,
      messageId: message.id,
    })

    const nextStatus = nextSupportStatusAfterMessage(thread.status as SupportStatus, side)
    await tx
      .update(supportThreads)
      .set({
        status: nextStatus,
        messageCount: sql`${supportThreads.messageCount} + 1`,
        lastMessageAt: now,
        lastMessageSide: side,
        // The first time Apricart answers is the response time this feature
        // will eventually be measured on. Recorded once, never overwritten.
        firstResponseAt:
          side === "APRICART" && thread.firstResponseAt === null ? now : thread.firstResponseAt,
        // A reply always lands on OPEN or AWAITING_CUSTOMER, so a reply to a
        // resolved thread reopens it and its settlement stamps clear.
        resolvedAt: null,
        resolvedByUserId: null,
        updatedAt: now,
      })
      .where(eq(supportThreads.id, thread.id))

    await tx
      .insert(supportThreadReads)
      .values({ threadId: thread.id, userId: input.author.userId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [supportThreadReads.threadId, supportThreadReads.userId],
        set: { lastReadAt: now },
      })

    const event = await loadThreadEvent(tx, thread.id)
    const queued = event
      ? await queueSupportMessageNotifications(tx, {
          thread: event,
          messageId: message.id,
          authorUserId: input.author.userId,
          authorSide: side,
          authorName: input.author.fullName,
          isFirstMessage: false,
        })
      : { eventKeys: [], recipientCount: 0 }

    // The thread, not the message, is the record this names: `entity_id` holds
    // one id and a reader looking for a conversation looks for its thread. The
    // message id is in the metadata, and the body is not — see the note on
    // `createSupportThread`.
    await recordAuditEvent(tx, {
      action: "REPLY_SUPPORT_THREAD",
      entity: "support_thread",
      entityId: thread.id,
      actor: { id: input.author.userId, role: input.author.role },
      organizationId: thread.organizationId,
      branchId: thread.branchId,
      before: { status: thread.status },
      after: { status: nextStatus },
      context: {
        messageId: message.id,
        authorSide: side,
        attachmentCount: input.attachmentIds.length,
        notifiedRecipients: queued.recipientCount,
      },
    })

    return { ok: true as const, messageId: message.id, status: nextStatus, queued }
  })
}

export type UpdateSupportThreadInput = {
  actor: SupportAuthor
  threadId: number
  status?: SupportStatus
  priority?: SupportPriority
  /** `null` unassigns. Undefined leaves the assignment alone. */
  assignedToUserId?: string | null
}

export type UpdateSupportThreadResult =
  | { ok: true; status: SupportStatus; queued: QueuedSupportNotifications }
  | { ok: false; failure: SupportServiceFailure }

/**
 * Applies a hand-made change: resolve, close, reopen, reprioritise, assign.
 *
 * The transition itself is decided by `canTransitionSupportStatus`, which the
 * route handler has already consulted against the *claimed* status; it is
 * re-read here under a row lock and re-checked, because the status may have
 * moved between the two.
 */
export async function updateSupportThread(
  input: UpdateSupportThreadInput,
  canTransition: (from: SupportStatus, to: SupportStatus, side: SupportSide) => { ok: true } | { ok: false; reason: string },
): Promise<UpdateSupportThreadResult> {
  const side = supportSideForRole(input.actor.role)

  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select({
        id: supportThreads.id,
        status: supportThreads.status,
        priority: supportThreads.priority,
        // Carried so the audit row below can name the tenant this happened in.
        organizationId: supportThreads.organizationId,
        branchId: supportThreads.branchId,
        assignedToUserId: supportThreads.assignedToUserId,
      })
      .from(supportThreads)
      .where(eq(supportThreads.id, input.threadId))
      .limit(1)
      .for("update")

    if (!thread) return { ok: false as const, failure: failure("Support request not found.", 404) }

    const currentStatus = thread.status as SupportStatus
    const now = new Date()
    const changes: Record<string, unknown> = { updatedAt: now }

    const transition = planStatusTransition({
      currentStatus,
      requestedStatus: input.status,
      side,
      actorUserId: input.actor.userId,
      now,
      canTransition,
    })
    if (!transition.ok) return { ok: false as const, failure: transition.failure }

    const nextStatus = transition.nextStatus
    Object.assign(changes, transition.changes)

    if (input.priority) changes.priority = input.priority
    if (input.assignedToUserId !== undefined) {
      changes.assignedToUserId = await resolveAssignee(tx, input.assignedToUserId)
    }

    await tx.update(supportThreads).set(changes).where(eq(supportThreads.id, thread.id))

    // Written here, before the two returns below, so a reprioritise or a
    // reassignment is recorded as surely as a resolve or a close — those are
    // the ones that also send mail, and auditing only the noisy half would have
    // left the quiet changes invisible.
    await recordAuditEvent(tx, {
      action: "UPDATE_SUPPORT_THREAD",
      entity: "support_thread",
      entityId: thread.id,
      actor: { id: input.actor.userId, role: input.actor.role },
      organizationId: thread.organizationId,
      branchId: thread.branchId,
      before: {
        status: currentStatus,
        priority: thread.priority,
        assignedToUserId: thread.assignedToUserId,
      },
      after: {
        status: nextStatus,
        priority: input.priority ?? thread.priority,
        assignedToUserId:
          input.assignedToUserId === undefined
            ? thread.assignedToUserId
            : (changes.assignedToUserId as string | null),
      },
      context: { actorSide: side },
    })

    const settled = nextStatus === "RESOLVED" || nextStatus === "CLOSED"
    if (!settled || nextStatus === currentStatus) {
      return { ok: true as const, status: nextStatus, queued: { eventKeys: [], recipientCount: 0 } }
    }

    const event = await loadThreadEvent(tx, thread.id)
    const queued = event
      ? await queueSupportStatusNotifications(tx, {
          thread: event,
          template: nextStatus === "RESOLVED" ? "SUPPORT_THREAD_RESOLVED" : "SUPPORT_THREAD_CLOSED",
          // The transition's own timestamp: a thread can be resolved, reopened
          // and resolved again, and each of those is a distinct event.
          discriminator: now.getTime(),
          actorUserId: input.actor.userId,
          actorSide: side,
          actorName: input.actor.fullName,
        })
      : { eventKeys: [], recipientCount: 0 }

    return { ok: true as const, status: nextStatus, queued }
  })
}

/**
 * Works out what a requested status change means, or why it is refused.
 *
 * Separated from the transaction so the settlement stamps are decided in one
 * readable place: resolving records who resolved it, closing records who closed
 * it, and either one clears the other's stamps rather than leaving a thread
 * marked both.
 */
function planStatusTransition(input: {
  currentStatus: SupportStatus
  requestedStatus: SupportStatus | undefined
  side: SupportSide
  actorUserId: string
  now: Date
  canTransition: (from: SupportStatus, to: SupportStatus, side: SupportSide) => { ok: true } | { ok: false; reason: string }
}):
  | { ok: true; nextStatus: SupportStatus; changes: Record<string, unknown> }
  | { ok: false; failure: SupportServiceFailure } {
  const { currentStatus, requestedStatus, now, actorUserId } = input

  if (!requestedStatus || requestedStatus === currentStatus) {
    return { ok: true, nextStatus: currentStatus, changes: {} }
  }

  const verdict = input.canTransition(currentStatus, requestedStatus, input.side)
  if (!verdict.ok) return { ok: false, failure: failure(verdict.reason, 409) }

  const resolved = requestedStatus === "RESOLVED"
  const closed = requestedStatus === "CLOSED"

  return {
    ok: true,
    nextStatus: requestedStatus,
    changes: {
      status: requestedStatus,
      resolvedAt: resolved ? now : null,
      resolvedByUserId: resolved ? actorUserId : null,
      closedAt: closed ? now : null,
      closedByUserId: closed ? actorUserId : null,
    },
  }
}

/** An assignee must be an active Apricart account on the support queue, or nobody. */
async function resolveAssignee(tx: any, userId: string | null): Promise<string | null> {
  if (!userId) return null

  const [candidate] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(users.id, userId),
      inArray(roles.name, [...SUPPORT_APRICART_ROLES]),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)

  return candidate?.id ?? null
}

export { SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE as MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/support-thread"

/**
 * Resolves an attachment for reading, applying its thread's visibility rule.
 *
 * An unclaimed attachment belongs to nobody's thread yet, and is readable only
 * by the person who uploaded it.
 */
export async function getSupportAttachmentForViewer(
  viewer: SupportViewer,
  attachmentId: number,
): Promise<{ storageKey: string; contentType: string; fileName: string } | null> {
  const [attachment] = await db
    .select({
      id: supportAttachments.id,
      threadId: supportAttachments.threadId,
      uploadedByUserId: supportAttachments.uploadedByUserId,
      storageKey: supportAttachments.storageKey,
      contentType: supportAttachments.contentType,
      fileName: supportAttachments.fileName,
    })
    .from(supportAttachments)
    .where(eq(supportAttachments.id, attachmentId))
    .limit(1)

  if (!attachment) return null

  if (attachment.threadId === null) {
    return attachment.uploadedByUserId === viewer.userId
      ? {
          storageKey: attachment.storageKey,
          contentType: attachment.contentType,
          fileName: attachment.fileName,
        }
      : null
  }

  const scopeCondition = supportScopeCondition(viewer)
  if (!scopeCondition) return null

  // Re-uses the list's own predicate rather than restating the rule: if the
  // viewer cannot see the thread in their list, they cannot fetch its files.
  const [visible] = await db
    .select({ id: supportThreads.id })
    .from(supportThreads)
    .where(and(eq(supportThreads.id, attachment.threadId), scopeCondition))
    .limit(1)

  return visible
    ? {
        storageKey: attachment.storageKey,
        contentType: attachment.contentType,
        fileName: attachment.fileName,
      }
    : null
}

/** Removes unclaimed uploads that were never attached to a message. */
export async function purgeExpiredSupportUploads(): Promise<number> {
  const removed = await db
    .delete(supportAttachments)
    .where(and(
      isNull(supportAttachments.messageId),
      lt(supportAttachments.createdAt, new Date(Date.now() - ATTACHMENT_CLAIM_WINDOW_MS)),
    ))
    .returning({ id: supportAttachments.id })

  return removed.length
}

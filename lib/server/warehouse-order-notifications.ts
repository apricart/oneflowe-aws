import "server-only"

import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm"

import {
  apricartWarehouseMemberships,
  branches,
  emailOutbox,
  notifications,
  orders,
  organizations,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { db } from "@/lib/db"
import { sendWarehouseOrderEmail } from "@/lib/email/warehouse-order"
import { isValidEmailAddress } from "@/lib/validation/email"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"
import {
  isWarehouseOrderTemplate,
  parseWarehouseOrderPayload,
  WAREHOUSE_NOTIFICATION_ROLE,
  warehouseOrderCopy,
  warehouseOrderEventKey,
  warehouseOrderEventOf,
  warehouseOrderTemplate,
  type WarehouseOrderEvent,
  type WarehouseOrderPayload,
} from "@/lib/warehouse-order-notifications"
import { warehouseCityBranchOn, warehouseCityOrganizationOn } from "@/lib/server/warehouse-city-rule"
import {
  markFailedAttempt,
  markSent,
  markSkipped,
  type ClaimedOutboxRow,
  type DeliveryOutcome,
} from "@/lib/server/email-outbox-runtime"
import { isOrderInWarehouseReach } from "@/lib/server/warehouse-scope"
import { branchIdsWithoutWarehouse, loadMembershipAccountIdsServingBranches } from "@/lib/server/branch-warehouse"
import {
  WAREHOUSE_ORDER_OWNERSHIP,
  readsWarehouseMembership,
  type WarehouseOrderOwnershipMode,
} from "@/lib/warehouse-ownership-policy"

/**
 * Tell the warehouse users who serve an order's branch that the order reached
 * a stage. See plans/OF-WAREHOUSE-order-stage-notifications.md.
 *
 * Called inside the transaction that moves the order, so a change that rolls
 * back queues nothing. Each recipient gets one `notifications` row and one
 * `email_outbox` row under the same event key; the outbox scheduler sends the
 * email within a minute, re-checking the reach first.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export type WarehouseNotificationOrder = {
  id: number
  tid: string
  organizationId: number | null
  branchId: number
}

export type QueuedWarehouseNotifications = { eventKeys: string[]; recipientCount: number }

const NONE: QueuedWarehouseNotifications = { eventKeys: [], recipientCount: 0 }

export type WarehouseRecipient = { id: string; email: string }

/**
 * Every active warehouse user who works the order now. For an order Super Admin
 * transferred to a warehouse, that warehouse's operators. For any other, every
 * user whose reach covers its branch: assigned it one by one, or assigned its
 * city with its organization chosen — the same union `loadWarehouseReach`
 * computes, asked the other way round, by branch rather than by user.
 */
export async function loadWarehouseOrderRecipients(
  client: DbClient,
  orderId: number,
): Promise<WarehouseRecipient[]> {
  const [order] = await client
    .select({ branchId: orders.branchId, fulfillmentWarehouseId: orders.fulfillmentWarehouseId })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
  if (!order) return []
  const { branchId, fulfillmentWarehouseId } = order
  if (fulfillmentWarehouseId !== null) {
    return client
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(
        eq(roles.name, WAREHOUSE_ROLE),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        exists(
          client.select({ one: sql`1` })
            .from(apricartWarehouseMemberships)
            .where(and(
              eq(apricartWarehouseMemberships.userId, users.id),
              eq(apricartWarehouseMemberships.warehouseId, fulfillmentWarehouseId),
              eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR"),
            )),
        ),
      ))
  }
  return loadBranchWarehouseRecipients(client, branchId)
}

/**
 * Every active warehouse user whose branch reach covers the branch — who works
 * an order there that names no warehouse. Asked the way `loadWarehouseReach`
 * asks it for the mode in force: the account's own assignments in "branch",
 * warehouse membership in the membership modes (plus, in
 * "membership-fallback", the assignments when the branch is in no warehouse).
 */
export async function loadBranchWarehouseRecipients(
  client: DbClient,
  branchId: number,
  mode: WarehouseOrderOwnershipMode = WAREHOUSE_ORDER_OWNERSHIP,
): Promise<WarehouseRecipient[]> {
  const viaWarehouses = readsWarehouseMembership(mode) ? await loadMembershipAccountIdsServingBranches(client, [branchId]) : []
  const viaAssignments = mode === "branch"
    || (mode === "membership-fallback" && (await branchIdsWithoutWarehouse(client, [branchId])).length > 0)
  // Never an empty OR: that would drop the condition and match every warehouse user.
  if (!viaAssignments && viaWarehouses.length === 0) return []
  return client
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(roles.name, WAREHOUSE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
      or(
        viaAssignments
          ? exists(
            client.select({ one: sql`1` })
              .from(warehouseAssignments)
              .where(and(eq(warehouseAssignments.userId, users.id), eq(warehouseAssignments.branchId, branchId))),
          )
          : undefined,
        viaAssignments
          ? exists(
            client.select({ one: sql`1` })
              .from(warehouseCityAssignments)
              .innerJoin(branches, warehouseCityBranchOn())
              .innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())
              .where(and(eq(warehouseCityAssignments.userId, users.id), eq(branches.id, branchId))),
          )
          : undefined,
        viaWarehouses.length > 0 ? inArray(users.id, viaWarehouses) : undefined,
      ),
    ))
}

export async function queueWarehouseOrderNotifications(
  client: DbClient,
  input: {
    order: WarehouseNotificationOrder
    event: WarehouseOrderEvent
    /** Required for a recurring event: what distinguishes this occurrence (edit time, correction request, refund). */
    occurrence?: string | number | null
    /** CREATED only: the order was approved at creation. */
    approvedAtCreation?: boolean
    /**
     * Who to tell, when it is not "whoever works the order now" — a transfer
     * tells the accounts that lost it and the ones that gained it apart.
     */
    recipients?: WarehouseRecipient[]
  },
): Promise<QueuedWarehouseNotifications> {
  const { order, event } = input
  if (!order.organizationId) return NONE

  const [context] = await client
    .select({ organizationName: organizations.name, branchName: branches.name })
    .from(branches)
    .innerJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(and(eq(branches.id, order.branchId), eq(branches.organizationId, order.organizationId)))
    .limit(1)
  if (!context) return NONE

  const recipients = input.recipients ?? await loadWarehouseOrderRecipients(client, order.id)
  if (recipients.length === 0) return NONE

  const payload: WarehouseOrderPayload = {
    orderId: order.id,
    tid: order.tid,
    organizationName: context.organizationName,
    branchName: context.branchName,
    ...(event === "CREATED" ? { approvedAtCreation: input.approvedAtCreation === true } : {}),
  }
  const template = warehouseOrderTemplate(event)
  const { message } = warehouseOrderCopy(event, payload)
  const rows = recipients.map((recipient) => ({
    recipient,
    eventKey: warehouseOrderEventKey({ event, orderId: order.id, recipientUserId: recipient.id, occurrence: input.occurrence }),
  }))

  await client.insert(notifications).values(rows.map(({ recipient, eventKey }) => ({
    userId: recipient.id,
    organizationId: order.organizationId,
    branchId: order.branchId,
    orderId: order.id,
    eventKey,
    type: template,
    targetRole: WAREHOUSE_NOTIFICATION_ROLE,
    message,
  }))).onConflictDoNothing()

  await client.insert(emailOutbox).values(rows.map(({ recipient, eventKey }) => ({
    eventKey,
    recipientUserId: recipient.id,
    recipientEmail: recipient.email,
    recipientRole: WAREHOUSE_NOTIFICATION_ROLE,
    organizationId: order.organizationId as number,
    branchId: order.branchId,
    orderId: order.id,
    template,
    payload,
  }))).onConflictDoNothing()

  return { eventKeys: rows.map((row) => row.eventKey), recipientCount: rows.length }
}

async function isActiveWarehouseUser(userId: string): Promise<boolean> {
  const [account] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), eq(roles.name, WAREHOUSE_ROLE), eq(users.isActive, true), isNull(users.deletedAt)))
    .limit(1)
  return Boolean(account)
}

export function isWarehouseEmailTemplate(template: string): boolean {
  return isWarehouseOrderTemplate(template)
}

/**
 * Send one claimed warehouse email, or retire it if the recipient no longer
 * works the order (its branch, or for a transferred order its warehouse), is no
 * longer an active warehouse user, or the order is no longer at that branch of
 * that tenant. A "moved to another warehouse" email is the one exception: it
 * goes to a user who no longer works the order, and is retired if the order
 * has come back to it since.
 */
export async function deliverClaimedWarehouseEmail(row: ClaimedOutboxRow): Promise<DeliveryOutcome> {
  const payload = parseWarehouseOrderPayload(row.payload)
  if (!isWarehouseOrderTemplate(row.template) || !payload || row.recipientRole !== WAREHOUSE_NOTIFICATION_ROLE) {
    await markSkipped(row.id, "Invalid warehouse email template or payload")
    return "skipped"
  }
  if (row.orderId === null || row.branchId === null || row.orderId !== payload.orderId) {
    await markSkipped(row.id, "Warehouse email is missing its order scope")
    return "skipped"
  }

  const [recipient] = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(orders, eq(orders.id, row.orderId))
    .where(and(
      eq(users.id, row.recipientUserId),
      eq(orders.organizationId, row.organizationId),
      eq(orders.branchId, row.branchId),
    ))
    .limit(1)
  // The reach checks re-read the account too: a deactivated, deleted or
  // re-roled user reaches nothing, and is no active warehouse user.
  const movedAway = warehouseOrderEventOf(row.template) === "TRANSFERRED_OUT"
  const stillRelevant = recipient !== undefined && (movedAway
    ? await isActiveWarehouseUser(row.recipientUserId) && !await isOrderInWarehouseReach(row.recipientUserId, row.orderId)
    : await isOrderInWarehouseReach(row.recipientUserId, row.orderId))
  if (!recipient || !stillRelevant || !isValidEmailAddress(recipient.email)) {
    await markSkipped(row.id, "Recipient no longer works this order")
    return "skipped"
  }

  try {
    const providerMessageId = await sendWarehouseOrderEmail({ to: recipient.email, template: row.template, payload })
    await markSent(row.id, { recipientEmail: recipient.email, providerMessageId })
    return "sent"
  } catch (error) {
    return markFailedAttempt(row, error)
  }
}

import "server-only"

import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm"

import {
  auditLogs,
  branchDeliveryAddresses,
  branches,
  legacyOrderImports,
  orders,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { canReadDeliveryDashboard } from "@/lib/apricart-executive-access"
import { branchRegionLabel } from "@/lib/branch-region"
import { db } from "@/lib/db"
import {
  DELIVERY_DASHBOARD_MAX_ROWS,
  UNKNOWN_REGION_FILTER,
  buildDeliveryDashboard,
  type DeliveryDashboardFilters,
  type DeliveryOrderRow,
} from "@/lib/delivery-dashboard"
import {
  DELIVERY_DASHBOARD_CUTOFF_AT,
  DELIVERY_HEALTH_LABELS,
  assessDelivery,
  destinationCity,
  karachiDayEnd,
  karachiDayStart,
  placeKey,
} from "@/lib/delivery-sla"
import { FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { FULFILLED_ORDER_STATUSES } from "@/lib/order-delivery-status"

/**
 * The management delivery dashboard's reads. See
 * plans/OF-DELIVERY-management-delivery-dashboard.md.
 *
 * The readers are Super Admin and Apricart Executive, and both read **every
 * organization** by design — that is the role. So there is no tenant fence to
 * apply; what is fenced instead is *which orders and which fields*: only the
 * dashboard's population (approved since the cutoff, never a legacy import),
 * and never an amount or a person.
 */

const orderStatus = sql`UPPER(${orders.status})`
const stage = sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED'))`
const fulfilledStatuses = sql.join(FULFILLED_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `)

/** Not a legacy import. Imported timestamps are import times, not delivery times. */
const notImported = sql`NOT EXISTS (
  SELECT 1 FROM ${legacyOrderImports} WHERE ${legacyOrderImports.orderId} = ${orders.id}
)`

/** The dashboard's population, before any filter: real delivery work approved since the cutoff. */
function populationCondition(): SQL {
  return and(
    gte(orders.approvedAt, DELIVERY_DASHBOARD_CUTOFF_AT),
    sql`(${orderStatus} = 'APPROVED' OR ${orderStatus} IN (${fulfilledStatuses}))`,
    // The branch row must belong to the order's own tenant, as everywhere else.
    eq(branches.organizationId, orders.organizationId),
    notImported,
  )!
}

/** Open orders always; delivered ones only when delivered inside the range. */
function openOrDeliveredInRange(filters: DeliveryDashboardFilters): SQL {
  const delivered = sql`(${stage} = 'DELIVERED' OR ${orderStatus} IN (${fulfilledStatuses}))`
  return sql`(
    (${orderStatus} = 'APPROVED' AND NOT ${delivered})
    OR (${delivered} AND ${orders.deliveredAt} >= ${karachiDayStart(filters.deliveredFrom)}
      AND ${orders.deliveredAt} <= ${karachiDayEnd(filters.deliveredTo)})
  )`
}

function filterConditions(filters: DeliveryDashboardFilters): SQL[] {
  const conditions: SQL[] = [populationCondition(), openOrDeliveredInRange(filters)]
  if (filters.organizationId !== null) conditions.push(eq(orders.organizationId, filters.organizationId))
  // `parseDeliveryDashboardQuery` only admits a branch together with an
  // organization; both predicates apply, so a branch of another tenant reads empty.
  if (filters.branchId !== null) conditions.push(eq(orders.branchId, filters.branchId))
  if (filters.region === UNKNOWN_REGION_FILTER) conditions.push(isNull(branches.region))
  else if (filters.region !== null) conditions.push(eq(branches.region, filters.region))
  if (filters.fulfillmentStatus !== null) conditions.push(sql`${stage} = ${filters.fulfillmentStatus}`)
  return conditions
}

const rowColumns = {
  id: orders.id,
  tid: orders.tid,
  organizationId: sql<number>`${orders.organizationId}`.mapWith(Number),
  organizationName: organizations.name,
  branchId: orders.branchId,
  branchName: branches.name,
  branchCity: branches.city,
  branchRegion: branches.region,
  deliveryAddressCity: branchDeliveryAddresses.city,
  status: orders.status,
  fulfillmentStatus: orders.fulfillmentStatus,
  approvedAt: orders.approvedAt,
  deliveredAt: orders.deliveredAt,
}

async function loadDeliveryRows(filters: DeliveryDashboardFilters): Promise<{ rows: DeliveryOrderRow[]; truncated: boolean }> {
  const rows = await db
    .select(rowColumns)
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .innerJoin(organizations, eq(organizations.id, orders.organizationId))
    // Only the order's own approved address, of its own branch, contributes a city.
    .leftJoin(branchDeliveryAddresses, and(
      eq(branchDeliveryAddresses.id, orders.deliveryAddressId),
      eq(branchDeliveryAddresses.branchId, orders.branchId),
    ))
    .where(and(...filterConditions(filters)))
    .orderBy(asc(orders.approvedAt), asc(orders.id))
    .limit(DELIVERY_DASHBOARD_MAX_ROWS + 1)

  const truncated = rows.length > DELIVERY_DASHBOARD_MAX_ROWS
  return { rows: (truncated ? rows.slice(0, DELIVERY_DASHBOARD_MAX_ROWS) : rows) as DeliveryOrderRow[], truncated }
}

async function loadFilterOptions(organizationId: number | null) {
  const organizationRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .orderBy(asc(organizations.name))
    .limit(500)
  const branchRows = organizationId === null
    ? []
    : await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.organizationId, organizationId))
      .orderBy(asc(branches.name))
      .limit(2000)
  return { organizations: organizationRows, branches: branchRows }
}

export async function loadDeliveryDashboard(filters: DeliveryDashboardFilters, now: Date) {
  const [{ rows, truncated }, options] = await Promise.all([
    loadDeliveryRows(filters),
    loadFilterOptions(filters.organizationId),
  ])
  return buildDeliveryDashboard({ rows, filters, now, truncated, ...options })
}

/**
 * The account behind a dashboard request, re-read from `users`: active, not
 * deleted, and still holding the role its session names. The route's
 * `requireApiRole` checked the session; this checks the database, so a role or
 * account withdrawn mid-session stops reading at once.
 */
export async function isActiveDeliveryDashboardReader(userId: string, sessionRole: string): Promise<boolean> {
  const [actor] = await db
    .select({ role: roles.name })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), eq(users.isActive, true), isNull(users.deletedAt)))
    .limit(1)
  return Boolean(actor && actor.role === sessionRole && canReadDeliveryDashboard(actor.role))
}

// ---------------------------------------------------------------------------
// One order's journey
// ---------------------------------------------------------------------------

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super Admin",
  HEAD_OFFICE: "Head Office",
  BRANCH_ADMIN: "Branch Admin",
  GROUP_USER: "Group User",
  ORDER_PORTAL: "Order Portal",
  GROUP_ORDER_PORTAL: "Group Order Portal",
  ORDER_DESK: "Order Desk",
}

function roleLabel(role: string | null | undefined): string | null {
  return role ? ROLE_LABELS[role] ?? null : null
}

export type DeliveryTimelineEvent = {
  key: string
  label: string
  at: string
  /** The role that acted, never the person. */
  by: string | null
}

/**
 * The timeline for one order inside the dashboard's population, or null.
 *
 * Built from the order row and the audit trail. The stage moves are the
 * progress route's `ORDER_FULFILLMENT_STATUS_UPDATE` rows, which it records
 * with entity `Order` (capitalised); both spellings are read. An order outside
 * the population — before the cutoff, imported, pending, rejected — reads as
 * not found, so this cannot be pointed at an arbitrary order.
 */
export async function loadDeliveryTimeline(orderId: number, now: Date) {
  const [order] = await db
    .select({
      ...rowColumns,
      createdAt: orders.createdAt,
      fulfilledAt: orders.fulfilledAt,
      createdByRole: orders.createdByRole,
    })
    .from(orders)
    .innerJoin(branches, eq(branches.id, orders.branchId))
    .innerJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branchDeliveryAddresses, and(
      eq(branchDeliveryAddresses.id, orders.deliveryAddressId),
      eq(branchDeliveryAddresses.branchId, orders.branchId),
    ))
    .where(and(eq(orders.id, orderId), populationCondition()))
    .limit(1)
  if (!order) return null

  const assessment = assessDelivery(order, now)
  if (!assessment) return null

  const trail = await db
    .select({
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
      actorRole: roles.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      inArray(auditLogs.entity, ["order", "Order"]),
      eq(auditLogs.entityId, String(order.id)),
      or(eq(auditLogs.action, "ORDER_APPROVED"), eq(auditLogs.action, "ORDER_FULFILLMENT_STATUS_UPDATE")),
      // Never another tenant's row that happens to share the id.
      or(isNull(auditLogs.organizationId), eq(auditLogs.organizationId, order.organizationId)),
    ))
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(50)

  const approval = trail.find((entry) => entry.action === "ORDER_APPROVED")
  const events: DeliveryTimelineEvent[] = []
  if (order.createdAt) {
    events.push({ key: "placed", label: "Placed", at: new Date(order.createdAt).toISOString(), by: roleLabel(order.createdByRole) })
  }
  events.push({
    key: "approved",
    label: approval ? "Approved" : "Approved (automatically or by policy)",
    at: assessment.approvedAt.toISOString(),
    by: approval ? roleLabel(approval.actorRole) : null,
  })
  for (const entry of trail) {
    if (entry.action !== "ORDER_FULFILLMENT_STATUS_UPDATE" || !entry.createdAt) continue
    const to = normalizeFulfillmentStatus(String((entry.metadata as { to?: unknown } | null)?.to ?? ""))
    events.push({
      key: `stage-${to}-${new Date(entry.createdAt).getTime()}`,
      label: FULFILLMENT_STATUS_LABELS[to],
      at: new Date(entry.createdAt).toISOString(),
      by: roleLabel(entry.actorRole),
    })
  }
  if (order.fulfilledAt) {
    events.push({ key: "acknowledged", label: "Receipt acknowledged", at: new Date(order.fulfilledAt).toISOString(), by: null })
  }
  events.sort((a, b) => a.at.localeCompare(b.at))

  return {
    order: {
      id: order.id,
      tid: order.tid,
      organizationName: order.organizationName,
      branchName: order.branchName,
      region: branchRegionLabel(order.branchRegion),
      city: placeKey(destinationCity({ deliveryAddressCity: order.deliveryAddressCity, branchCity: order.branchCity })).label,
      stage: assessment.stage,
      stageLabel: FULFILLMENT_STATUS_LABELS[assessment.stage],
    },
    delivery: {
      health: assessment.health,
      healthLabel: DELIVERY_HEALTH_LABELS[assessment.health],
      approvedAt: assessment.approvedAt.toISOString(),
      promisedAt: assessment.promisedAt.toISOString(),
      deliveredAt: assessment.deliveredAt?.toISOString() ?? null,
      hoursRemaining: assessment.hoursRemaining,
      hoursOverdue: assessment.hoursOverdue,
      deliveryHours: assessment.deliveryHours,
    },
    events,
  }
}

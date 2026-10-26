import "server-only"

import { randomUUID } from "node:crypto"
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm"
import {
  branches,
  orderItems,
  orders,
  organizations,
  riderDepots,
  riderOrderAssignments,
  riderPodImages,
  riderProfiles,
  type RiderAssignmentStatus,
} from "@/db/schema"
import { db } from "@/lib/db"
import { verifyApprovalToken } from "@/lib/approval-token"
import {
  canApprovePod,
  canRejectPod,
  canSubmitPod,
  canVerifyFulfillmentToken,
  distanceMeters,
  isValidLatLng,
  riderMayStartDelivery,
} from "@/lib/rider/assignment-status"
import { karachiDay } from "@/lib/delivery-sla"
import { fetchDrivingGeometry } from "@/lib/rider/osrm-route"
import { isAssignmentDelivered, isAssignmentOverdue } from "@/lib/rider/same-day"
import {
  buildRoutePayload,
  liveRouteWaypoints,
  plannedRouteWaypoints,
  type RouteLatLng,
  type RouteStop,
} from "@/lib/rider/route"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { isImageStorageConfigured, putImage } from "@/lib/server/image-storage"
import { fulfillApprovedOrder } from "@/lib/server/order-fulfillment"
import { progressOrderFulfillment } from "@/lib/server/order-fulfillment-progress"
import {
  queueRiderOverdueDeliveryNotifications,
  queueRiderPodSubmittedNotifications,
} from "@/lib/server/rider-notifications"
import { isOrderBranchInWarehouseReach } from "@/lib/server/warehouse-scope"
import { recordAuditEvent } from "@/lib/server/activity-audit"

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function mapAssignmentStatusToMobile(status: string, orderStatus: string): string {
  if (String(orderStatus).toUpperCase() === "CANCELLED") return "cancelled"
  switch (status) {
    case "ASSIGNED":
      return "assigned"
    case "OUT_FOR_DELIVERY":
      return "in_transit"
    case "POD_SUBMITTED":
      return "awaiting_admin_verification"
    case "POD_REJECTED":
      return "in_transit"
    case "POD_APPROVED":
    case "FULFILLMENT_PENDING":
    case "FULFILLMENT_COMPLETED":
      return "delivered"
    default:
      return "assigned"
  }
}

async function loadOrderItems(orderId: number) {
  return db
    .select({
      name: orderItems.productName,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
}

export async function listRiderAssignments(riderUserId: string) {
  return db
    .select({
      assignment: riderOrderAssignments,
      order: {
        id: orders.id,
        tid: orders.tid,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        paymentStatus: orders.paymentStatus,
        totalCents: orders.totalCents,
        organizationId: orders.organizationId,
        branchId: orders.branchId,
        createdAt: orders.createdAt,
        deliveredAt: orders.deliveredAt,
      },
      orgName: organizations.name,
      branchName: branches.name,
      branchAddress: branches.address,
      
    })
    .from(riderOrderAssignments)
    .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
    .leftJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branches, eq(branches.id, orders.branchId))
    .where(eq(riderOrderAssignments.riderUserId, riderUserId))
    .orderBy(asc(riderOrderAssignments.deliverySequence))
}

export async function findRiderAssignmentByOrderRef(
  riderUserId: string,
  orderRef: string,
) {
  const asId = Number(orderRef)
  const byTid = await db
    .select({
      assignment: riderOrderAssignments,
      order: orders,
      orgName: organizations.name,
      branchName: branches.name,
      branchAddress: branches.address,
      
    })
    .from(riderOrderAssignments)
    .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
    .leftJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branches, eq(branches.id, orders.branchId))
    .where(
      and(
        eq(riderOrderAssignments.riderUserId, riderUserId),
        Number.isSafeInteger(asId) && asId > 0
          ? eq(orders.id, asId)
          : eq(orders.tid, orderRef),
      ),
    )
    .limit(1)
  return byTid[0] ?? null
}

export async function toMobileOrder(row: {
  assignment: typeof riderOrderAssignments.$inferSelect
  order: {
    id: number
    tid: string
    status: string
    paymentStatus: string
    totalCents: number
    deliveredAt: Date | null
  }
  orgName: string | null
  branchName: string | null
  branchAddress: string | null
}) {
  const items = await loadOrderItems(row.order.id)
  const images = await db
    .select({ storageKey: riderPodImages.storageKey })
    .from(riderPodImages)
    .where(eq(riderPodImages.assignmentId, row.assignment.id))

  const [depot] = await db
    .select()
    .from(riderDepots)
    .where(eq(riderDepots.warehouseUserId, row.assignment.assignedByUserId ?? ""))
    .limit(1)

  const overdue = isAssignmentOverdue(row.assignment.assignedAt, row.assignment.status)
  const delivered = isAssignmentDelivered(row.assignment.status)

  return {
    id: row.order.tid,
    customerName: row.orgName ?? row.branchName ?? "Customer",
    status: mapAssignmentStatusToMobile(row.assignment.status, row.order.status),
    assignedAt: row.assignment.assignedAt?.toISOString?.() ?? new Date(row.assignment.assignedAt).toISOString(),
    deliveredAt:
      row.assignment.podApprovedAt?.toISOString?.() ??
      row.order.deliveredAt?.toISOString?.() ??
      null,
    overdue,
    delivered,
    serviceDay: karachiDay(new Date(row.assignment.assignedAt)),
    timeSlot: null,
    paymentType: row.order.paymentStatus === "PAID" ? "prepaid" : "cod",
    amount: Math.round(Number(row.order.totalCents) / 100),
    items: items.map((i) => ({
      name: i.name ?? "Item",
      quantity: Number(i.quantity) || 0,
    })),
    pickup: {
      name: depot?.name ?? row.branchName ?? "Warehouse",
      address: depot?.address ?? row.branchAddress ?? "",
      phone: null,
      area: null,
      location:
        depot != null
          ? { latitude: depot.latitude, longitude: depot.longitude }
          : null,
    },
    delivery: {
      name: row.branchName ?? "Delivery",
      address: row.assignment.deliveryAddressText ?? row.branchAddress ?? "",
      phone: null,
      area: null,
      location: {
        latitude: row.assignment.deliveryLat,
        longitude: row.assignment.deliveryLng,
      },
    },
    acknowledgmentToken: null,
    proofImageUrls: images.map((i) => i.storageKey),
    assignmentId: row.assignment.id,
    deliverySequence: row.assignment.deliverySequence,
    assignmentStatus: row.assignment.status,
  }
}

export async function getRiderRoute(
  riderUserId: string,
  warehouseUserId?: string | null,
  /**
   * When the rider app sends live GPS, geometry is recalculated from here →
   * remaining stops so the travelled polyline disappears.
   */
  currentLocation?: RouteLatLng | null,
) {
  const now = new Date()
  const serviceDay = karachiDay(now)
  const rows = await listRiderAssignments(riderUserId)

  const [profile] = await db
    .select({
      code: riderProfiles.code,
      cityKey: riderProfiles.cityKey,
      warehouseUserId: riderProfiles.warehouseUserId,
    })
    .from(riderProfiles)
    .where(eq(riderProfiles.userId, riderUserId))
    .limit(1)

  // Today's assignments (incl. delivered flags) + overdue undelivered carry-overs.
  const onRoute = rows.filter((r) => {
    const day = karachiDay(new Date(r.assignment.assignedAt))
    if (day === serviceDay) return true
    return isAssignmentOverdue(r.assignment.assignedAt, r.assignment.status, now)
  })

  // Notify once for each overdue stop (warehouse + rider).
  for (const r of onRoute) {
    if (!isAssignmentOverdue(r.assignment.assignedAt, r.assignment.status, now)) continue
    if (r.order.branchId == null) continue
    await queueRiderOverdueDeliveryNotifications(db, {
      orderId: r.order.id,
      orderTid: r.order.tid,
      branchId: r.order.branchId,
      organizationId: r.order.organizationId,
      assignmentId: r.assignment.id,
      riderUserId,
      riderCode: profile?.code ?? "rider",
      warehouseUserId: profile?.warehouseUserId ?? null,
      customerName: r.orgName ?? r.branchName ?? r.order.tid,
    })
  }

  const stops: RouteStop[] = onRoute.map((r) => ({
    sequence: r.assignment.deliverySequence,
    assignmentId: r.assignment.id,
    orderId: r.order.id,
    orderTid: r.order.tid,
    customerName: r.orgName ?? r.branchName ?? null,
    latitude: r.assignment.deliveryLat,
    longitude: r.assignment.deliveryLng,
    address: r.assignment.deliveryAddressText,
    status: r.assignment.status,
    delivered: isAssignmentDelivered(r.assignment.status),
    overdue: isAssignmentOverdue(r.assignment.assignedAt, r.assignment.status, now),
  }))

  let depot = null

  if (profile?.cityKey) {
    const [byCity] = await db
      .select()
      .from(riderDepots)
      .where(eq(riderDepots.cityKey, profile.cityKey))
      .limit(1)
    if (byCity) {
      depot = {
        name: byCity.name,
        latitude: byCity.latitude,
        longitude: byCity.longitude,
        address: byCity.address,
      }
    }
  }

  if (!depot) {
    const depotOwner =
      warehouseUserId ?? profile?.warehouseUserId ?? onRoute[0]?.assignment.assignedByUserId
    if (depotOwner) {
      const [d] = await db
        .select()
        .from(riderDepots)
        .where(eq(riderDepots.warehouseUserId, depotOwner))
        .limit(1)
      if (d) {
        depot = {
          name: d.name,
          latitude: d.latitude,
          longitude: d.longitude,
          address: d.address,
        }
      }
    }
  }

  const remaining = stops
    .filter((s) => !s.delivered)
    .sort((a, b) => a.sequence - b.sequence)
  const nextStop = remaining[0] ?? null

  // Live: from current GPS → remaining stops (drops path already ridden).
  // Planned: warehouse depot → remaining (initial map / no GPS yet).
  const live = currentLocation != null && isValidLatLng(currentLocation.latitude, currentLocation.longitude)
  const waypoints = live
    ? liveRouteWaypoints(currentLocation, remaining)
    : plannedRouteWaypoints(depot, remaining)
  const geometry =
    waypoints.length >= 2 ? await fetchDrivingGeometry(waypoints) : null

  return buildRoutePayload({
    depot,
    stops,
    geometry,
    geometryMode: live ? "live" : "planned",
    nextStop,
    serviceDay,
  })
}

export async function createAssignments(input: {
  actorUserId: string
  actorRole: string
  riderUserId: string
  items: Array<{
    orderId: number
    deliverySequence: number
    deliveryLat: number
    deliveryLng: number
    deliveryAddressText?: string | null
  }>
}) {
  const [profile] = await db
    .select({ userId: riderProfiles.userId })
    .from(riderProfiles)
    .where(eq(riderProfiles.userId, input.riderUserId))
    .limit(1)
  if (!profile) return { kind: "rider_not_found" as const }

  for (const item of input.items) {
    if (!isValidLatLng(item.deliveryLat, item.deliveryLng)) {
      return { kind: "invalid_coords" as const, orderId: item.orderId }
    }
  }

  return db.transaction(async (tx) => {
    const created: number[] = []
    for (const item of input.items) {
      const [order] = await tx
        .select({
          id: orders.id,
          status: orders.status,
          fulfillmentStatus: orders.fulfillmentStatus,
          organizationId: orders.organizationId,
          branchId: orders.branchId,
        })
        .from(orders)
        .where(eq(orders.id, item.orderId))
        .limit(1)

      if (!order) return { kind: "order_not_found" as const, orderId: item.orderId }
      if (String(order.status).toUpperCase() !== "APPROVED") {
        return { kind: "order_not_eligible" as const, orderId: item.orderId, reason: "not_approved" }
      }
      if (String(order.fulfillmentStatus).toUpperCase() !== "OUT_FOR_DELIVERY") {
        return {
          kind: "order_not_eligible" as const,
          orderId: item.orderId,
          reason: "not_out_for_delivery",
        }
      }

      if (input.actorRole === "WAREHOUSE") {
        const inReach = await isOrderBranchInWarehouseReach(input.actorUserId, order, {
          client: tx,
          lock: true,
        })
        if (!inReach) return { kind: "order_not_found" as const, orderId: item.orderId }
      }

      const [existing] = await tx
        .select({ id: riderOrderAssignments.id })
        .from(riderOrderAssignments)
        .where(
          and(
            eq(riderOrderAssignments.orderId, item.orderId),
            ne(riderOrderAssignments.status, "FULFILLMENT_COMPLETED"),
          ),
        )
        .limit(1)
      if (existing) {
        return { kind: "already_assigned" as const, orderId: item.orderId }
      }

      const [row] = await tx
        .insert(riderOrderAssignments)
        .values({
          orderId: item.orderId,
          riderUserId: input.riderUserId,
          assignedByUserId: input.actorUserId,
          deliverySequence: item.deliverySequence,
          deliveryLat: item.deliveryLat,
          deliveryLng: item.deliveryLng,
          deliveryAddressText: item.deliveryAddressText ?? null,
          status: "ASSIGNED",
        })
        .returning({ id: riderOrderAssignments.id })
      created.push(row.id)
    }

    await recordAuditEvent(tx, {
      actor: { id: input.actorUserId, role: input.actorRole },
      action: "ASSIGN_RIDER_ORDERS",
      entity: "RiderOrderAssignment",
      entityId: String(input.riderUserId),
      context: { assignmentIds: created, orderIds: input.items.map((i) => i.orderId) },
    })

    return { kind: "ok" as const, assignmentIds: created }
  })
}

export async function updateAssignmentPin(input: {
  actorUserId: string
  actorRole: string
  assignmentId: number
  deliveryLat: number
  deliveryLng: number
  deliveryAddressText?: string | null
}) {
  if (!isValidLatLng(input.deliveryLat, input.deliveryLng)) {
    return { kind: "invalid_coords" as const }
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: riderOrderAssignments.id,
        orderId: riderOrderAssignments.orderId,
        riderUserId: riderOrderAssignments.riderUserId,
        status: riderOrderAssignments.status,
        organizationId: orders.organizationId,
        branchId: orders.branchId,
      })
      .from(riderOrderAssignments)
      .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
      .where(eq(riderOrderAssignments.id, input.assignmentId))
      .limit(1)
      .for("update", { of: riderOrderAssignments })

    if (!row) return { kind: "not_found" as const }
    if (row.status === "FULFILLMENT_COMPLETED") {
      return { kind: "conflict" as const, status: row.status }
    }

    if (input.actorRole === "WAREHOUSE") {
      const inReach = await isOrderBranchInWarehouseReach(
        input.actorUserId,
        { organizationId: row.organizationId, branchId: row.branchId },
        { client: tx, lock: true },
      )
      if (!inReach) return { kind: "not_found" as const }

      const [owned] = await tx
        .select({ userId: riderProfiles.userId })
        .from(riderProfiles)
        .where(
          and(
            eq(riderProfiles.userId, row.riderUserId),
            eq(riderProfiles.warehouseUserId, input.actorUserId),
          ),
        )
        .limit(1)
      if (!owned) return { kind: "not_found" as const }
    }

    await tx
      .update(riderOrderAssignments)
      .set({
        deliveryLat: input.deliveryLat,
        deliveryLng: input.deliveryLng,
        ...(input.deliveryAddressText !== undefined
          ? { deliveryAddressText: input.deliveryAddressText }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(riderOrderAssignments.id, input.assignmentId))

    await recordAuditEvent(tx, {
      actor: { id: input.actorUserId, role: input.actorRole },
      action: "UPDATE_RIDER_ASSIGNMENT_PIN",
      entity: "RiderOrderAssignment",
      entityId: String(input.assignmentId),
      context: {
        orderId: row.orderId,
        deliveryLat: input.deliveryLat,
        deliveryLng: input.deliveryLng,
      },
    })

    return { kind: "ok" as const }
  })
}

export async function reorderSequences(input: {
  actorUserId: string
  actorRole: string
  riderUserId: string
  orderedAssignmentIds: number[]
}) {
  if (input.actorRole === "WAREHOUSE") {
    const [owned] = await db
      .select({ userId: riderProfiles.userId })
      .from(riderProfiles)
      .where(
        and(
          eq(riderProfiles.userId, input.riderUserId),
          eq(riderProfiles.warehouseUserId, input.actorUserId),
        ),
      )
      .limit(1)
    if (!owned) return { kind: "not_found" as const, assignmentId: input.orderedAssignmentIds[0] ?? 0 }
  }

  return db.transaction(async (tx) => {
    let seq = 1
    for (const id of input.orderedAssignmentIds) {
      const updated = await tx
        .update(riderOrderAssignments)
        .set({ deliverySequence: seq, updatedAt: new Date() })
        .where(
          and(
            eq(riderOrderAssignments.id, id),
            eq(riderOrderAssignments.riderUserId, input.riderUserId),
            ne(riderOrderAssignments.status, "FULFILLMENT_COMPLETED"),
          ),
        )
        .returning({ id: riderOrderAssignments.id })
      if (!updated.length) {
        return { kind: "not_found" as const, assignmentId: id }
      }
      seq += 1
    }
    await recordAuditEvent(tx, {
      actor: { id: input.actorUserId, role: input.actorRole },
      action: "REORDER_RIDER_ASSIGNMENTS",
      entity: "RiderOrderAssignment",
      entityId: String(input.riderUserId),
      context: { orderedAssignmentIds: input.orderedAssignmentIds },
    })
    return { kind: "ok" as const }
  })
}

export async function startRiderDelivery(riderUserId: string, orderRef: string) {
  const row = await findRiderAssignmentByOrderRef(riderUserId, orderRef)
  if (!row) return { kind: "not_found" as const }
  if (!riderMayStartDelivery(row.assignment.status)) {
    return { kind: "conflict" as const, status: row.assignment.status }
  }
  await db
    .update(riderOrderAssignments)
    .set({
      status: "OUT_FOR_DELIVERY",
      outForDeliveryAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(riderOrderAssignments.id, row.assignment.id))
  return { kind: "ok" as const, assignmentId: row.assignment.id }
}

export async function recordArrival(input: {
  riderUserId: string
  orderRef: string
  latitude: number
  longitude: number
}) {
  if (!isValidLatLng(input.latitude, input.longitude)) {
    return { kind: "invalid" as const }
  }
  const row = await findRiderAssignmentByOrderRef(input.riderUserId, input.orderRef)
  if (!row) return { kind: "not_found" as const }

  const dist = distanceMeters(
    input.latitude,
    input.longitude,
    row.assignment.deliveryLat,
    row.assignment.deliveryLng,
  )

  await db
    .update(riderOrderAssignments)
    .set({
      arrivedAt: new Date(),
      arrivalLat: input.latitude,
      arrivalLng: input.longitude,
      updatedAt: new Date(),
    })
    .where(eq(riderOrderAssignments.id, row.assignment.id))

  const { riderLocationEvents } = await import("@/db/schema")
  await db.insert(riderLocationEvents).values({
    riderUserId: input.riderUserId,
    assignmentId: row.assignment.id,
    kind: "ARRIVAL",
    latitude: input.latitude,
    longitude: input.longitude,
    distanceMeters: dist,
  })

  return { kind: "ok" as const, distanceMeters: dist }
}

export async function submitPod(input: {
  riderUserId: string
  orderRef: string
  files: File[]
}) {
  const row = await findRiderAssignmentByOrderRef(input.riderUserId, input.orderRef)
  if (!row) return { kind: "not_found" as const }
  if (!canSubmitPod(row.assignment.status)) {
    return { kind: "conflict" as const, status: row.assignment.status }
  }
  if (input.files.length < 1 || input.files.length > 3) {
    return { kind: "validation" as const, message: "Provide 1–3 images" }
  }
  if (!isImageStorageConfigured()) {
    return { kind: "storage" as const }
  }

  const uploaded: Array<{ key: string; contentType: string; sizeBytes: number }> = []
  for (const file of input.files) {
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      return { kind: "validation" as const, message: "Each image must be 1 byte–5 MB" }
    }
    const raw = Buffer.from(await file.arrayBuffer())
    const declaredMime = file.type || "image/jpeg"
    const sanitized = await sanitizeRasterUpload({ buffer: raw, declaredMime })
    if (!sanitized.ok) {
      return { kind: "validation" as const, message: sanitized.error }
    }
    const ext = sanitized.image.extension
    // S3 "folder" for proof-of-delivery photos (bucket from S3_UPLOADS_*).
    const key = `proof-of-delivery/${randomUUID()}.${ext}`
    await putImage({
      key,
      body: sanitized.buffer,
      contentType: sanitized.image.mime,
    })
    uploaded.push({
      key,
      contentType: sanitized.image.mime,
      sizeBytes: sanitized.buffer.length,
    })
  }

  await db.transaction(async (tx) => {
    await tx.delete(riderPodImages).where(eq(riderPodImages.assignmentId, row.assignment.id))
    for (const image of uploaded) {
      await tx.insert(riderPodImages).values({
        assignmentId: row.assignment.id,
        storageKey: image.key,
        contentType: image.contentType,
        sizeBytes: image.sizeBytes,
        uploadedByUserId: input.riderUserId,
      })
    }
    await tx
      .update(riderOrderAssignments)
      .set({
        status: "POD_SUBMITTED",
        podSubmittedAt: new Date(),
        podRejectedAt: null,
        podRejectReason: null,
        updatedAt: new Date(),
      })
      .where(eq(riderOrderAssignments.id, row.assignment.id))

    await queueRiderPodSubmittedNotifications(tx, {
      orderId: row.order.id,
      orderTid: row.order.tid,
      branchId: row.order.branchId,
      organizationId: row.order.organizationId,
      assignmentId: row.assignment.id,
      riderUserId: input.riderUserId,
    })
  })

  return { kind: "ok" as const, storageKeys: uploaded.map((u) => u.key) }
}

export async function approvePod(input: {
  actorUserId: string
  actorRole: string
  assignmentId: number
}) {
  const [row] = await db
    .select({
      assignment: riderOrderAssignments,
      orderId: orders.id,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
      fulfillmentStatus: orders.fulfillmentStatus,
    })
    .from(riderOrderAssignments)
    .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
    .where(eq(riderOrderAssignments.id, input.assignmentId))
    .limit(1)

  if (!row) return { kind: "not_found" as const }
  if (!canApprovePod(row.assignment.status)) {
    return { kind: "conflict" as const, status: row.assignment.status }
  }

  if (input.actorRole === "WAREHOUSE") {
    const inReach = await isOrderBranchInWarehouseReach(input.actorUserId, {
      organizationId: row.organizationId,
      branchId: row.branchId,
    })
    if (!inReach) return { kind: "not_found" as const }
  }

  // Advance fulfillment to DELIVERED if not already (may already be OUT_FOR_DELIVERY).
  const current = String(row.fulfillmentStatus || "").toUpperCase()
  if (current !== "DELIVERED") {
    if (current !== "OUT_FOR_DELIVERY") {
      return { kind: "conflict" as const, status: current }
    }
    const outcome = await progressOrderFulfillment({
      orderId: row.orderId,
      nextStatus: "DELIVERED",
      deliveryChallanId: null,
      challanRequired: false,
      actor: { id: input.actorUserId, role: input.actorRole },
      authorize: async (order) =>
        input.actorRole === "SUPER_ADMIN" ||
        (await isOrderBranchInWarehouseReach(input.actorUserId, order)),
      guardInTransaction:
        input.actorRole === "WAREHOUSE"
          ? (tx, order) =>
              isOrderBranchInWarehouseReach(input.actorUserId, order, { client: tx, lock: true })
          : undefined,
    })
    if (outcome.kind !== "updated") {
      return { kind: "progress_failed" as const, outcome: outcome.kind }
    }
  }

  await db
    .update(riderOrderAssignments)
    .set({
      status: "POD_APPROVED",
      podApprovedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(riderOrderAssignments.id, input.assignmentId))

  // Move to fulfillment pending immediately after approve.
  await db
    .update(riderOrderAssignments)
    .set({ status: "FULFILLMENT_PENDING", updatedAt: new Date() })
    .where(eq(riderOrderAssignments.id, input.assignmentId))

  await recordAuditEvent(db, {
    actor: { id: input.actorUserId, role: input.actorRole },
    action: "APPROVE_RIDER_POD",
    entity: "RiderOrderAssignment",
    entityId: String(input.assignmentId),
    context: { orderId: row.orderId },
  })

  return { kind: "ok" as const }
}

export async function rejectPod(input: {
  actorUserId: string
  actorRole: string
  assignmentId: number
  reason: string
}) {
  const [row] = await db
    .select({
      assignment: riderOrderAssignments,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
    })
    .from(riderOrderAssignments)
    .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
    .where(eq(riderOrderAssignments.id, input.assignmentId))
    .limit(1)

  if (!row) return { kind: "not_found" as const }
  if (!canRejectPod(row.assignment.status)) {
    return { kind: "conflict" as const, status: row.assignment.status }
  }
  if (input.actorRole === "WAREHOUSE") {
    const inReach = await isOrderBranchInWarehouseReach(input.actorUserId, {
      organizationId: row.organizationId,
      branchId: row.branchId,
    })
    if (!inReach) return { kind: "not_found" as const }
  }

  await db
    .update(riderOrderAssignments)
    .set({
      status: "POD_REJECTED",
      podRejectedAt: new Date(),
      podRejectReason: input.reason,
      updatedAt: new Date(),
    })
    .where(eq(riderOrderAssignments.id, input.assignmentId))

  await recordAuditEvent(db, {
    actor: { id: input.actorUserId, role: input.actorRole },
    action: "REJECT_RIDER_POD",
    entity: "RiderOrderAssignment",
    entityId: String(input.assignmentId),
    context: { reason: input.reason },
  })

  return { kind: "ok" as const }
}

export async function verifyRiderFulfillmentToken(input: {
  riderUserId: string
  orderRef: string
  token: string
}) {
  const row = await findRiderAssignmentByOrderRef(input.riderUserId, input.orderRef)
  if (!row) return { kind: "not_found" as const }
  if (!canVerifyFulfillmentToken(row.assignment.status)) {
    return { kind: "conflict" as const, status: row.assignment.status }
  }

  const [ord] = await db
    .select({
      id: orders.id,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      approvalTokenHash: orders.approvalTokenHash,
      organizationId: orders.organizationId,
      branchId: orders.branchId,
    })
    .from(orders)
    .where(eq(orders.id, row.order.id))
    .limit(1)

  if (!ord?.approvalTokenHash) return { kind: "no_token" as const }
  if (String(ord.fulfillmentStatus).toUpperCase() !== "DELIVERED") {
    return { kind: "not_delivered" as const }
  }

  const valid = await verifyApprovalToken(input.token, ord.approvalTokenHash)
  if (!valid) return { kind: "invalid_token" as const }

  const outcome = await fulfillApprovedOrder({
    orderId: ord.id,
    fulfilledByUserId: input.riderUserId,
    organizationId: ord.organizationId,
    branchId: ord.branchId,
  })

  if (outcome !== "fulfilled") {
    return { kind: "fulfill_failed" as const, outcome }
  }

  await db
    .update(riderOrderAssignments)
    .set({
      status: "FULFILLMENT_COMPLETED",
      fulfilledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(riderOrderAssignments.id, row.assignment.id))

  return { kind: "ok" as const }
}

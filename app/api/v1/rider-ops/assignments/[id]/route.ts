import { eq } from "drizzle-orm"
import { z } from "zod"
import {
  branches,
  orderItems,
  orders,
  organizations,
  riderOrderAssignments,
  riderPodImages,
  riderProfiles,
  users,
} from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { updateAssignmentPin } from "@/lib/server/rider-assignments"

const pinSchema = z
  .object({
    deliveryLat: z.number(),
    deliveryLng: z.number(),
    deliveryAddressText: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()

export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const id = Number((await props.params).id)
    if (!Number.isSafeInteger(id) || id <= 0) return error("Not found", 404)

    const [row] = await db
      .select({
        assignment: riderOrderAssignments,
        orderId: orders.id,
        orderTid: orders.tid,
        orderStatus: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
        paymentStatus: orders.paymentStatus,
        totalCents: orders.totalCents,
        subtotalCents: orders.subtotalCents,
        taxCents: orders.taxCents,
        approvedAt: orders.approvedAt,
        notes: orders.notes,
        riderCode: riderProfiles.code,
        riderPhone: riderProfiles.phone,
        riderVehicle: riderProfiles.vehicleNumber,
        riderFullName: users.fullName,
        riderEmail: users.email,
        customerName: organizations.name,
        organizationCode: organizations.code,
        branchName: branches.name,
        branchCity: branches.city,
        branchAddress: branches.address,
      })
      .from(riderOrderAssignments)
      .innerJoin(orders, eq(orders.id, riderOrderAssignments.orderId))
      .innerJoin(organizations, eq(organizations.id, orders.organizationId))
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(eq(riderOrderAssignments.id, id))
      .limit(1)

    if (!row) return error("Assignment not found", 404)
    if (user.role === "WAREHOUSE") {
      const [owned] = await db
        .select({ warehouseUserId: riderProfiles.warehouseUserId })
        .from(riderProfiles)
        .where(eq(riderProfiles.userId, row.assignment.riderUserId))
        .limit(1)
      if (!owned || owned.warehouseUserId !== user.id) {
        return error("Assignment not found", 404)
      }
    }

    const [placer] = await db
      .select({ fullName: users.fullName })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.createdByUserId))
      .where(eq(orders.id, row.orderId))
      .limit(1)

    const lineItems = await db
      .select({
        productName: orderItems.productName,
        productCode: orderItems.productCode,
        quantity: orderItems.quantity,
        unit: orderItems.unit,
        priceCents: orderItems.priceCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, row.orderId))

    const images = await db
      .select({
        id: riderPodImages.id,
        storageKey: riderPodImages.storageKey,
        uploadedAt: riderPodImages.uploadedAt,
        uploadedByUserId: riderPodImages.uploadedByUserId,
      })
      .from(riderPodImages)
      .where(eq(riderPodImages.assignmentId, id))

    const proofImages = images.map((image) => ({
      id: image.id,
      uploadedAt: image.uploadedAt,
      fileUrl: `/api/v1/rider-ops/assignments/${id}/pod/${image.id}/file`,
    }))

    return ok({
      assignment: row.assignment,
      orderTid: row.orderTid,
      orderStatus: row.orderStatus,
      fulfillmentStatus: row.fulfillmentStatus,
      paymentStatus: row.paymentStatus,
      totalCents: row.totalCents,
      subtotalCents: row.subtotalCents,
      taxCents: row.taxCents,
      approvedAt: row.approvedAt,
      notes: row.notes,
      customerName: row.customerName,
      organizationCode: row.organizationCode,
      branchName: row.branchName,
      branchCity: row.branchCity,
      branchAddress: row.branchAddress,
      placerName: placer?.fullName ?? null,
      rider: {
        code: row.riderCode,
        fullName: row.riderFullName,
        email: row.riderEmail,
        phone: row.riderPhone,
        vehicleNumber: row.riderVehicle,
      },
      // Flat fields kept for older UI readers
      riderCode: row.riderCode,
      riderFullName: row.riderFullName,
      items: lineItems.map((item) => ({
        name: item.productName,
        code: item.productCode,
        quantity: Number(item.quantity) || 0,
        unit: item.unit,
        priceCents: item.priceCents,
      })),
      proofImages,
    })
  } catch (err) {
    console.error("[rider-ops/assignments/:id]", err)
    return error("Failed to load assignment", 500)
  }
}

/** Set / move the drop pin for one assignment (Plan route). */
export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", user.id)
    if (limited) return limited

    const id = Number((await props.params).id)
    if (!Number.isSafeInteger(id) || id <= 0) return error("Not found", 404)

    const parsed = pinSchema.safeParse(await readJson(req))
    if (!parsed.success) return error("Invalid body", 400)

    const result = await updateAssignmentPin({
      actorUserId: user.id,
      actorRole: user.role,
      assignmentId: id,
      deliveryLat: parsed.data.deliveryLat,
      deliveryLng: parsed.data.deliveryLng,
      deliveryAddressText: parsed.data.deliveryAddressText,
    })

    if (result.kind === "not_found") return error("Assignment not found", 404)
    if (result.kind === "invalid_coords") return error("Invalid delivery coordinates", 400)
    if (result.kind === "conflict") {
      return error(`Assignment cannot be moved (${result.status})`, 409)
    }

    return ok({ updated: true })
  } catch (err) {
    console.error("[rider-ops/assignments/:id PATCH]", err)
    return error("Failed to update assignment pin", 500)
  }
}

import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import { branches, groups } from "@/db/schema"
import { and, eq, ne, sql } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { branchUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (err) return err
  const params = await props.params
  const { id } = params
  const [item] = await db.select().from(branches).where(eq(branches.id, Number(id)))
  if (!item) return error("Not found", 404)

  // BOLA Protection: verify user has access to this branch's organization
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(item.organizationId, item.id)
  if (!hasAccess) return error("Forbidden: You do not have access to this branch", 403)

  return ok({ item })
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = branchUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const body = parsedBody.data
  try {
    const params = await props.params
    const { id } = params

    const scope = await getRequestScope()

    const [currentBranch] = await db
      .select({ organizationId: branches.organizationId })
      .from(branches)
      .where(eq(branches.id, Number(id)))
    if (!currentBranch) return error("Not found", 404)

    if (scope?.role === "HEAD_OFFICE") {
      if (!scope.organizationId || scope.organizationId !== currentBranch.organizationId) {
        return error("Forbidden", 403)
      }
    }

    if (body.name !== undefined) {
      const newName = String(body.name).trim()
      if (newName) {
        const [duplicate] = await db
          .select({ id: branches.id })
          .from(branches)
          .where(and(
            eq(branches.organizationId, currentBranch.organizationId),
            sql`lower(${branches.name}) = ${newName.toLowerCase()}`,
            ne(branches.id, Number(id))
          ))
          .limit(1)
        if (duplicate) {
          return error("A branch with this name already exists in this organization.", 409)
        }
      }
    }

    if (body.groupId) {
      const [group] = await db
        .select({ id: groups.id })
        .from(groups)
        .where(and(
          eq(groups.id, body.groupId),
          eq(groups.organizationId, currentBranch.organizationId),
          ne(groups.status, "deleted"),
        ))
        .limit(1)
      if (!group) return error("Group does not belong to this organization", 400)
    }

    const patch: any = {}
    if (body.name !== undefined) patch.name = String(body.name)
    if (body.province !== undefined) {
      const province = String(body.province || "").trim()
      if (province && (province.length < 2 || province.length > 100)) {
        return error("Branch province must be between 2 and 100 characters", 400)
      }
      patch.province = province || null
    }
    if (body.city !== undefined) {
      const city = String(body.city || "").trim()
      if (city && (city.length < 2 || city.length > 100)) {
        return error("Branch city must be between 2 and 100 characters", 400)
      }
      patch.city = city || null
    }
    if (body.address !== undefined) {
      const address = String(body.address || "").trim()
      if (address && (address.length < 5 || address.length > 500)) {
        return error("Branch address must be between 5 and 500 characters", 400)
      }
      patch.address = address || null
    }
    if (body.costCenterId !== undefined) {
      const costCenterId = String(body.costCenterId || "").trim()
      if (costCenterId.length > 128) {
        return error("Cost center ID must be 128 characters or less", 400)
      }
      patch.costCenterId = costCenterId || null
    }
    if (body.status !== undefined) {
      const normalized = String(body.status).toLowerCase()
      const validStatuses = ['active', 'inactive', 'suspended']
      if (!validStatuses.includes(normalized)) {
        return error(`Status must be one of: ${validStatuses.join(', ')}`, 400)
      }
      patch.status = normalized
    }
    if (body.groupId !== undefined) patch.groupId = body.groupId === null ? null : Number(body.groupId)
    patch.updatedAt = new Date()
    const [item] = await db.update(branches).set(patch).where(eq(branches.id, Number(id))).returning()

    // Invalidate branches and groups cache so GET returns fresh data immediately
    await invalidateByPrefix('branches')
    await invalidateByPrefix('groups')

    return ok({ item })
  } catch (e: any) {
    console.error("Update branch failed:", e)
    return error("Update failed", 400)
  }
}

export async function DELETE(
  _: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN"])
  if (err) return err
  const params = await props.params
  const { id } = params
  const branchId = Number(id)

  try {
    // 0. Check if exists
    const [existing] = await db.select().from(branches).where(eq(branches.id, branchId))
    if (!existing) return error("Branch not found", 404)

    // Already inactive
    if (existing.status === 'inactive') {
      return error("Branch is already inactive", 400)
    }

    // Soft-delete: mark as inactive instead of hard-deleting
    // All historical data (budgets, orders, audit logs, etc.) is preserved
    const [updated] = await db.update(branches)
      .set({
        status: 'inactive',
        updatedAt: new Date(),
      })
      .where(eq(branches.id, branchId))
      .returning()

    // Invalidate caches
    await invalidateByPrefix('branches')

    return ok({
      ok: true,
      message: "Branch deactivated successfully. All historical data has been preserved.",
      item: updated
    })

  } catch (e: any) {
    console.error("Delete branch failed:", e)
    return error("Failed to deactivate branch", 500)
  }
}


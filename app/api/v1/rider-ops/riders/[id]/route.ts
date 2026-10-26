import { and, eq, isNull } from "drizzle-orm"
import { z } from "zod"
import { riderProfiles, users } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders } from "@/lib/rider-access"
import { recordAuditEvent } from "@/lib/server/activity-audit"

const patchSchema = z
  .object({
    fullName: z.string().trim().min(1).max(255).optional(),
    phone: z.string().trim().min(5).max(32).nullable().optional(),
    vehicleNumber: z.string().trim().max(64).nullable().optional(),
    isActive: z.boolean().optional(),
    isOnDuty: z.boolean().optional(),
  })
  .strict()

export async function GET(
  _req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const actor = await getCurrentUser()
    if (!actor || !canManageRiders(actor.role)) return error("Forbidden", 403)

    const { id } = await props.params
    const [row] = await db
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        isActive: users.isActive,
        code: riderProfiles.code,
        phone: riderProfiles.phone,
        vehicleNumber: riderProfiles.vehicleNumber,
        isOnDuty: riderProfiles.isOnDuty,
        avatarUrl: riderProfiles.avatarUrl,
      })
      .from(riderProfiles)
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1)

    if (!row) return error("Rider not found", 404)
    return ok({ rider: row })
  } catch (err) {
    console.error("[rider-ops/riders/:id GET]", err)
    return error("Failed to load rider", 500)
  }
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> },
) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const actor = await getCurrentUser()
    if (!actor || !canManageRiders(actor.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("write", actor.id)
    if (limited) return limited

    const parsed = patchSchema.safeParse(await readJson(req))
    if (!parsed.success) return error("Invalid body", 400)

    const { id } = await props.params
    const [existing] = await db
      .select({ userId: riderProfiles.userId })
      .from(riderProfiles)
      .where(eq(riderProfiles.userId, id))
      .limit(1)
    if (!existing) return error("Rider not found", 404)

    await db.transaction(async (tx) => {
      if (parsed.data.fullName !== undefined || parsed.data.isActive !== undefined) {
        await tx
          .update(users)
          .set({
            ...(parsed.data.fullName !== undefined ? { fullName: parsed.data.fullName } : {}),
            ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
            updatedAt: new Date(),
          })
          .where(eq(users.id, id))
      }
      await tx
        .update(riderProfiles)
        .set({
          ...(parsed.data.phone !== undefined ? { phone: parsed.data.phone } : {}),
          ...(parsed.data.vehicleNumber !== undefined
            ? { vehicleNumber: parsed.data.vehicleNumber }
            : {}),
          ...(parsed.data.isOnDuty !== undefined ? { isOnDuty: parsed.data.isOnDuty } : {}),
          updatedAt: new Date(),
        })
        .where(eq(riderProfiles.userId, id))

      await recordAuditEvent(tx, {
        actor: { id: actor.id, role: actor.role },
        action: "UPDATE_RIDER",
        entity: "RiderProfile",
        entityId: id,
        after: parsed.data,
      })
    })

    return ok({ updated: true })
  } catch (err) {
    console.error("[rider-ops/riders/:id PATCH]", err)
    return error("Failed to update rider", 500)
  }
}

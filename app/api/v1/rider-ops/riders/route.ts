import { z } from "zod"
import { asc, eq, isNull } from "drizzle-orm"
import { riderProfiles, roles, users } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders, riderUserShapeError } from "@/lib/rider-access"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { assertUniqueUserFields } from "@/lib/user-uniqueness"

const createSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/, "code must be alphanumeric"),
    email: z.string().trim().email().max(255),
    password: z.string().min(12).max(128),
    fullName: z.string().trim().min(1).max(255),
    phone: z.string().trim().min(5).max(32).optional().nullable(),
    vehicleNumber: z.string().trim().max(64).optional().nullable(),
  })
  .strict()

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user || !canManageRiders(user.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("search", user.id)
    if (limited) return limited

    const rows = await db
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
        createdAt: riderProfiles.createdAt,
      })
      .from(riderProfiles)
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(isNull(users.deletedAt))
      .orderBy(asc(riderProfiles.code))

    return ok({ items: rows })
  } catch (err) {
    console.error("[rider-ops/riders GET]", err)
    return error("Failed to list riders", 500)
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN", "WAREHOUSE"])
    if (roleError) return roleError
    const actor = await getCurrentUser()
    if (!actor || !canManageRiders(actor.role)) return error("Forbidden", 403)

    const limited = await withRateLimit("sensitive", actor.id)
    if (limited) return limited

    const parsed = createSchema.safeParse(await readJson(req))
    if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid body", 400)

    const shape = riderUserShapeError(null, null)
    if (shape) return error(shape, 400)

    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "RIDER")).limit(1)
    if (!role) return error("RIDER role is not seeded — apply migration 20261021180000", 503)

    const code = parsed.data.code.toUpperCase()
    const [codeTaken] = await db
      .select({ userId: riderProfiles.userId })
      .from(riderProfiles)
      .where(eq(riderProfiles.code, code))
      .limit(1)
    if (codeTaken) return error("Rider code already exists", 409)

    try {
      await assertUniqueUserFields({ email: parsed.data.email })
    } catch (e: any) {
      return error(e?.message ?? "Email already in use", 409)
    }

    const passwordHash = await hashPassword(parsed.data.password)

    const created = await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email: parsed.data.email.toLowerCase(),
          passwordHash,
          roleId: role.id,
          fullName: parsed.data.fullName,
          phone: parsed.data.phone ?? null,
          organizationId: null,
          branchId: null,
          isActive: true,
          mustChangePassword: true,
        })
        .returning({ id: users.id, email: users.email, fullName: users.fullName })

      await tx.insert(riderProfiles).values({
        userId: user.id,
        code,
        phone: parsed.data.phone ?? null,
        vehicleNumber: parsed.data.vehicleNumber ?? null,
        isOnDuty: false,
        createdByUserId: actor.id,
      })

      await recordAuditEvent(tx, {
        actor: { id: actor.id, role: actor.role },
        action: "CREATE_RIDER",
        entity: "RiderProfile",
        entityId: user.id,
        after: { code, email: user.email },
      })

      return user
    })

    return ok(
      {
        id: created.id,
        code,
        email: created.email,
        fullName: created.fullName,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error("[rider-ops/riders POST]", err)
    return error("Failed to create rider", 500)
  }
}

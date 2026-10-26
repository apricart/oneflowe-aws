import { z } from "zod"
import { and, asc, eq, isNull } from "drizzle-orm"
import { riderProfiles, roles, users } from "@/db/schema"
import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { withRateLimit } from "@/lib/rate-limiter"
import { canManageRiders, riderUserShapeError } from "@/lib/rider-access"
import { resolveRiderCity } from "@/lib/rider/city-depots"
import { recordAuditEvent } from "@/lib/server/activity-audit"
import { ensureCityDepotForWarehouse } from "@/lib/server/rider-city-depot"
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
    /** Pakistan city name — required; links rider to the warehouse for that city. */
    city: z.string().trim().min(1).max(120),
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
        cityKey: riderProfiles.cityKey,
        cityLabel: riderProfiles.cityLabel,
        warehouseUserId: riderProfiles.warehouseUserId,
        createdAt: riderProfiles.createdAt,
      })
      .from(riderProfiles)
      .innerJoin(users, eq(users.id, riderProfiles.userId))
      .where(
        and(
          isNull(users.deletedAt),
          user.role === "WAREHOUSE" ? eq(riderProfiles.warehouseUserId, user.id) : undefined,
        ),
      )
      .orderBy(asc(riderProfiles.code))

    return ok({ items: rows })
  } catch (err) {
    console.error("[rider-ops/riders GET]", err)
    return error("Failed to list riders", 500)
  }
}

export async function POST(req: Request) {
  try {
    // Create Rider is warehouse-only: the creating account becomes the city warehouse.
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const actor = await getCurrentUser()
    if (!actor || actor.role !== "WAREHOUSE" || !canManageRiders(actor.role)) {
      return error("Forbidden", 403)
    }

    const limited = await withRateLimit("sensitive", actor.id)
    if (limited) return limited

    const parsed = createSchema.safeParse(await readJson(req))
    if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Invalid body", 400)

    const city = resolveRiderCity(parsed.data.city)
    if (!city) return error("Pick a city from the Pakistan list", 400)

    const warehouseUserId = actor.id

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

    type Outcome =
      | { kind: "ok"; id: string; email: string; fullName: string }
      | { kind: "city_taken" }
      | { kind: "warehouse_other_city"; cityLabel: string }
      | { kind: "no_coords" }

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const depot = await ensureCityDepotForWarehouse(tx, {
        warehouseUserId,
        cityKey: city.cityKey,
        cityLabel: city.cityLabel,
      })
      if (depot.kind === "city_taken") return { kind: "city_taken" }
      if (depot.kind === "warehouse_other_city") {
        return { kind: "warehouse_other_city", cityLabel: depot.cityLabel }
      }
      if (depot.kind === "no_coords") return { kind: "no_coords" }

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
        cityKey: city.cityKey,
        cityLabel: city.cityLabel,
        warehouseUserId,
        createdByUserId: actor.id,
      })

      await recordAuditEvent(tx, {
        actor: { id: actor.id, role: actor.role },
        action: "CREATE_RIDER",
        entity: "RiderProfile",
        entityId: user.id,
        after: { code, email: user.email, city: city.cityLabel, warehouseUserId },
      })

      return {
        kind: "ok",
        id: user.id,
        email: user.email ?? parsed.data.email.toLowerCase(),
        fullName: user.fullName ?? parsed.data.fullName,
      }
    })

    if (outcome.kind === "city_taken") {
      return error("Another warehouse already serves this city", 409)
    }
    if (outcome.kind === "warehouse_other_city") {
      return error(
        `Your warehouse is set to ${outcome.cityLabel}. Create riders for that city only.`,
        409,
      )
    }
    if (outcome.kind === "no_coords") {
      return error(
        "No warehouse start pin for this city yet. Karachi is pre-set; other cities need a depot first.",
        409,
      )
    }

    return ok(
      {
        id: outcome.id,
        code,
        email: outcome.email,
        fullName: outcome.fullName,
        city: city.cityLabel,
        cityKey: city.cityKey,
      },
      { status: 201 },
    )
  } catch (err) {
    console.error("[rider-ops/riders POST]", err)
    return error("Failed to create rider", 500)
  }
}

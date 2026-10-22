import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage, warehouseCityAssignmentUpdateSchema } from "@/lib/server/mutation-validation"
import { setWarehouseCity } from "@/lib/server/warehouse-team"
import { WAREHOUSE_CITY_MAX_PER_USER } from "@/lib/warehouse-access"

/**
 * Assign or withdraw one whole city for one warehouse user: every branch in
 * the city, in the organizations chosen for the user (`../city-organizations`),
 * now and opened later. Super Admin only. A user who is not a warehouse account
 * is 404, so this cannot probe other accounts. The audit row is written by
 * `lib/server/warehouse-team.ts`, inside the change. See
 * plans/OF-WAREHOUSE-city-assignments.md and
 * plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */

const userIdSchema = z.uuid()

export async function PUT(req: Request, props: { params: Promise<{ userId: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const { userId } = await props.params
    if (!userIdSchema.safeParse(userId).success) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const parsed = warehouseCityAssignmentUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await setWarehouseCity({
      userId,
      city: parsed.data.city,
      assigned: parsed.data.assigned,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "limit") {
      return NextResponse.json(
        { error: `A warehouse user can be assigned at most ${WAREHOUSE_CITY_MAX_PER_USER} cities` },
        { status: 409 },
      )
    }
    return NextResponse.json({
      item: { userId, city: outcome.city, assigned: outcome.assigned, branchCount: outcome.branchCount },
    })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/warehouse-team/[userId]/cities")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

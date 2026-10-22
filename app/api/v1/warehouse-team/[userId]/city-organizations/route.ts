import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage, warehouseCityOrganizationUpdateSchema } from "@/lib/server/mutation-validation"
import { setWarehouseCityOrganization } from "@/lib/server/warehouse-team"
import { WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER } from "@/lib/warehouse-access"

/**
 * Choose or withdraw one organization a warehouse user's cities apply to: its
 * cities reach the branches of the chosen organizations only. Super Admin
 * only. A user who is not a warehouse account is 404, so this cannot probe
 * other accounts. The audit row is written by `lib/server/warehouse-team.ts`,
 * inside the change. See plans/OF-WAREHOUSE-city-assignments-by-organization.md.
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

    const parsed = warehouseCityOrganizationUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await setWarehouseCityOrganization({
      userId,
      organizationId: parsed.data.organizationId,
      assigned: parsed.data.assigned,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "limit") {
      return NextResponse.json(
        { error: `A warehouse user's cities can apply to at most ${WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER} organizations` },
        { status: 409 },
      )
    }
    return NextResponse.json({
      item: {
        userId,
        organizationId: outcome.organizationId,
        assigned: outcome.assigned,
        organizationIds: outcome.organizationIds,
      },
    })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/warehouse-team/[userId]/city-organizations")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

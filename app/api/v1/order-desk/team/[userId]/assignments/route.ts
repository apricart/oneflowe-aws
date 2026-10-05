import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderDeskAssignmentsUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { replaceDeskAssignments } from "@/lib/server/order-desk-team"

/**
 * Replace which managed organizations, or single branches, one Order Desk user
 * may order for. Super Admin only. Refuses anything not managed, and any user
 * who is not an Order Desk account (404, so it cannot probe other users). The
 * audit row is written by `lib/server/order-desk-team.ts`, inside the change.
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

    const parsed = orderDeskAssignmentsUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await replaceDeskAssignments({
      userId,
      organizationIds: parsed.data.organizationIds,
      branchIds: parsed.data.branchIds,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    return NextResponse.json({
      item: { userId, organizationIds: outcome.organizationIds, branchIds: outcome.branchIds },
    })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/order-desk/team/[userId]/assignments")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

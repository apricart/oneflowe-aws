import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { warehouseBranchAssignmentsUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { replaceWarehouseBranches } from "@/lib/server/warehouse-team"

/**
 * Replace the branches one warehouse user serves in one organization. Super
 * Admin only. A user who is not a warehouse account is 404, so this cannot
 * probe other accounts. The audit row is written by
 * `lib/server/warehouse-team.ts`, inside the change.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
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

    const parsed = warehouseBranchAssignmentsUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await replaceWarehouseBranches({
      userId,
      organizationId: parsed.data.organizationId,
      branchIds: parsed.data.branchIds,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    return NextResponse.json({
      item: { userId, organizationId: parsed.data.organizationId, branchIds: outcome.branchIds },
    })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/warehouse-team/[userId]/branches")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

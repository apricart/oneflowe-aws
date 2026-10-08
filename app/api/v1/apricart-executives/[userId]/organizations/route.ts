import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { replaceExecutiveAssignments } from "@/lib/server/apricart-executive-team"
import { apricartExecutiveAssignmentsUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Replace the organizations one Apricart Executive approves Order Desk orders
 * for. Super Admin only. A user who is not an executive is 404, so this
 * cannot probe other accounts. The audit row is written by
 * `lib/server/apricart-executive-team.ts`, inside the change.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
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

    const parsed = apricartExecutiveAssignmentsUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await replaceExecutiveAssignments({
      userId,
      organizationIds: parsed.data.organizationIds,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    return NextResponse.json({ item: { userId, organizationIds: outcome.organizationIds } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/apricart-executives/[userId]/organizations")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

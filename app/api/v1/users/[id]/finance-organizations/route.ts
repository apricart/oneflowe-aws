import { NextResponse } from "next/server"
import { z } from "zod"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { handleError } from "@/lib/error-handler"
import { FINANCE_MANAGER_ROLES } from "@/lib/finance-access"
import { withRateLimit } from "@/lib/rate-limiter"
import type { Role } from "@/lib/rbac"
import { replaceFinanceOrganizations } from "@/lib/server/finance-scope"
import { financeOrganizationsUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Replace the organizations one Finance account reads. Super Admin only. A
 * user who is not a Finance account is 404, so this cannot probe other
 * accounts. The audit row (`UPDATE_FINANCE_ORGANIZATIONS`) is written inside
 * the change by `lib/server/finance-scope.ts`.
 * See plans/OF-FINANCE-finance-role.md.
 */

const userIdSchema = z.uuid()

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole([...FINANCE_MANAGER_ROLES] as Role[])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const { id } = await props.params
    if (!userIdSchema.safeParse(id).success) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const parsed = financeOrganizationsUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await replaceFinanceOrganizations({
      userId: id,
      organizationIds: parsed.data.organizationIds,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    if (outcome.kind === "not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })

    await invalidateByPrefix("users")
    return NextResponse.json({ item: { userId: id, organizationIds: outcome.organizationIds } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/users/[id]/finance-organizations")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

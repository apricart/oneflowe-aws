import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { parseWarehouseId } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { replaceBranchFulfillmentRoutes } from "@/lib/server/apricart-warehouses"
import { branchFulfillmentRoutesUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Replace the branches **of one organization** whose new orders will default
 * to this Apricart warehouse. Super Admin only. A listed branch routed to
 * another warehouse moves here; an inactive warehouse takes no new branch
 * (409). A route is a default only — no order and no account's reach reads it
 * yet. The audit row is written by `lib/server/apricart-warehouses.ts`, inside
 * the change. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const warehouseId = parseWarehouseId((await props.params).id)
    if (warehouseId === null) return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })

    const parsed = branchFulfillmentRoutesUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await replaceBranchFulfillmentRoutes({
      warehouseId,
      organizationId: parsed.data.organizationId,
      branchIds: parsed.data.branchIds,
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "not-found") return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "conflict") return NextResponse.json({ error: outcome.message }, { status: 409 })
    return NextResponse.json({
      item: { warehouseId, organizationId: parsed.data.organizationId, branchIds: outcome.branchIds, moved: outcome.moved },
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/apricart-warehouses/[id]/branches")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

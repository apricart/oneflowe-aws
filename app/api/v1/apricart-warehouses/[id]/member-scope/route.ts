import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { parseWarehouseId } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { setWarehouseMemberScope } from "@/lib/server/apricart-warehouses"
import { apricartWarehouseMemberScopeSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Which of an Apricart warehouse's branches one operator works: all of them,
 * or — one organization at a time — a selection, every branch of which must be
 * in this warehouse now. Super Admin only. An account that is not a member is
 * 404; an executive member is always all (400). While membership decides who
 * works an order, a change that would leave branches nobody works is refused
 * (409). The audit row is written by `lib/server/apricart-warehouses.ts`,
 * inside the change. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
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

    const parsed = apricartWarehouseMemberScopeSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await setWarehouseMemberScope({
      warehouseId,
      userId: parsed.data.userId,
      scope: parsed.data.scope,
      ...(parsed.data.scope === "SELECTED"
        ? { organizationId: parsed.data.organizationId, branchIds: parsed.data.branchIds }
        : {}),
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "not-found") return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })
    if (outcome.kind === "member-not-found") return NextResponse.json({ error: "Member not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "conflict") return NextResponse.json({ error: outcome.message }, { status: 409 })
    return NextResponse.json({
      item: {
        warehouseId,
        userId: outcome.userId,
        branchScope: outcome.branchScope,
        selectedBranchIds: outcome.selectedBranchIds,
        changed: outcome.changed,
      },
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/apricart-warehouses/[id]/member-scope")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { parseWarehouseId } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { updateApricartWarehouse } from "@/lib/server/apricart-warehouses"
import { apricartWarehouseUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Change one Apricart warehouse's name, location, contact or status. Super
 * Admin only. The code is permanent. Deactivating is refused (409) while any
 * branch still routes to it. The audit row is written by
 * `lib/server/apricart-warehouses.ts`, inside the change.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

export async function PATCH(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const warehouseId = parseWarehouseId((await props.params).id)
    if (warehouseId === null) return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })

    const parsed = apricartWarehouseUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await updateApricartWarehouse({
      warehouseId,
      patch: parsed.data,
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "not-found") return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })
    if (outcome.kind === "conflict") return NextResponse.json({ error: outcome.message }, { status: 409 })
    return NextResponse.json({ item: outcome.warehouse }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "PATCH /api/v1/apricart-warehouses/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

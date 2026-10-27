import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { WAREHOUSE_ROUTE_RULE_MAX, parseWarehouseId } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { setWarehouseRouteRule } from "@/lib/server/apricart-warehouses"
import { validationMessage, warehouseRouteRuleUpdateSchema } from "@/lib/server/mutation-validation"

/**
 * Put every branch of one organization — or of one organization in one city —
 * in an Apricart warehouse, or take that rule away. Super Admin only. A rule
 * another warehouse held moves here. The rule is evaluated whenever a branch's
 * warehouse is read, never copied, so branches created or re-citied later
 * follow it. While membership decides who works an order, a change that would
 * leave branches nobody works is refused (409). The audit row is written by
 * `lib/server/apricart-warehouses.ts`, inside the change.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
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

    const parsed = warehouseRouteRuleUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await setWarehouseRouteRule({
      warehouseId,
      organizationId: parsed.data.organizationId,
      city: parsed.data.city,
      assigned: parsed.data.assigned,
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "not-found") return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "conflict") return NextResponse.json({ error: outcome.message }, { status: 409 })
    if (outcome.kind === "limit") {
      return NextResponse.json({ error: `At most ${WAREHOUSE_ROUTE_RULE_MAX} warehouse rules can exist` }, { status: 409 })
    }
    return NextResponse.json({
      item: { ...outcome.rule, assigned: outcome.assigned, changed: outcome.changed, movedFromWarehouseId: outcome.movedFromWarehouseId },
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/apricart-warehouses/[id]/rules")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

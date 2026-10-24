import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { APRICART_WAREHOUSE_MEMBER_MAX, parseWarehouseId } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { setApricartWarehouseMember } from "@/lib/server/apricart-warehouses"
import { apricartWarehouseMemberUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Add or remove one account at an Apricart warehouse. Super Admin only. The
 * account must be a `WAREHOUSE` or `APRICART_EXECUTIVE` account — any other is
 * 404, so this cannot probe other accounts — and its responsibility follows
 * its role, never the body. Membership as an operator makes the orders
 * transferred to the warehouse this account's work, so removing the last
 * active operator of one with open transferred orders is refused (409). The audit row is
 * written by `lib/server/apricart-warehouses.ts`, inside the change.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
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

    const parsed = apricartWarehouseMemberUpdateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await setApricartWarehouseMember({
      warehouseId,
      userId: parsed.data.userId,
      assigned: parsed.data.assigned,
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "not-found") return NextResponse.json({ error: "Warehouse not found" }, { status: 404 })
    if (outcome.kind === "account-not-found") return NextResponse.json({ error: "User not found" }, { status: 404 })
    if (outcome.kind === "invalid") return NextResponse.json({ error: outcome.message }, { status: 400 })
    if (outcome.kind === "conflict") return NextResponse.json({ error: outcome.message }, { status: 409 })
    if (outcome.kind === "limit") {
      return NextResponse.json(
        { error: `A warehouse can have at most ${APRICART_WAREHOUSE_MEMBER_MAX} members` },
        { status: 409 },
      )
    }
    return NextResponse.json({
      item: { warehouseId, userId: outcome.userId, responsibility: outcome.responsibility, assigned: outcome.assigned },
    }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/apricart-warehouses/[id]/members")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

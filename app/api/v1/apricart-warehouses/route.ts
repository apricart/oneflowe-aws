import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { APRICART_WAREHOUSE_MAX } from "@/lib/apricart-warehouses"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { createApricartWarehouse, loadApricartWarehouseConfiguration } from "@/lib/server/apricart-warehouses"
import { apricartWarehouseCreateSchema, validationMessage } from "@/lib/server/mutation-validation"

/**
 * Super Admin's Apricart warehouses: the list with members, branch routes and
 * the coverage report (GET), and creating one (POST). Super Admin only — every
 * other role is refused by the role check, and the Apricart staff roles before
 * that by their proxy allowlists. Configuration only: nothing here changes
 * what any account may see. The audit row is written by
 * `lib/server/apricart-warehouses.ts`, inside the change.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET() {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("search", user.id)
    if (rateLimit) return rateLimit

    return NextResponse.json(await loadApricartWarehouseConfiguration(), { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/apricart-warehouses")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function POST(req: Request) {
  try {
    const roleError = await requireApiRole(["SUPER_ADMIN"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("write", user.id)
    if (rateLimit) return rateLimit

    const parsed = apricartWarehouseCreateSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await createApricartWarehouse({
      ...parsed.data,
      actor: { id: user.id, role: user.role, email: user.email },
    })
    if (outcome.kind === "conflict") {
      return NextResponse.json({ error: "A warehouse with this code already exists" }, { status: 409 })
    }
    if (outcome.kind === "limit") {
      return NextResponse.json({ error: `At most ${APRICART_WAREHOUSE_MAX} warehouses can be created` }, { status: 409 })
    }
    return NextResponse.json({ item: outcome.warehouse }, { status: 201, headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/apricart-warehouses")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

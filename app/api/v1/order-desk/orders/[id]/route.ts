import { NextResponse } from "next/server"

import { readJson, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { roundQuantity } from "@/lib/quantity"
import { withRateLimit } from "@/lib/rate-limiter"
import { orderDeskEditSchema, validationMessage } from "@/lib/server/mutation-validation"
import { editDeskOrder } from "@/lib/server/order-desk-edit"

/**
 * Edit an Order Desk order that is Active and not yet delivered: its lines,
 * notes and PO number. Re-priced, stock and budget re-checked, all under lock
 * (`lib/server/order-desk-edit.ts`, which also writes the audit row). An order
 * outside the desk user's reach is 404; a delivered or settled one is 409.
 */
export async function PUT(req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["ORDER_DESK"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const rateLimit = await withRateLimit("order", user.id)
    if (rateLimit) return rateLimit

    const orderId = Number((await props.params).id)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
    }

    const parsed = orderDeskEditSchema.safeParse(await readJson<unknown>(req))
    if (!parsed.success) return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })

    const outcome = await editDeskOrder({
      orderId,
      items: parsed.data.items.map((item) => ({
        organizationInventoryId: item.organizationInventoryId,
        quantity: roundQuantity(Number(item.quantity)),
      })),
      notes: parsed.data.notes,
      poNumber: parsed.data.poNumber,
      actor: { id: user.id, role: user.role, email: user.email },
    })

    switch (outcome.kind) {
      case "updated":
        return NextResponse.json({ message: "Order updated", totalCents: outcome.totalCents })
      case "not-found":
        return NextResponse.json({ error: "Order not found" }, { status: 404 })
      case "target-unavailable":
        return NextResponse.json({ error: "You are not assigned to order for this branch" }, { status: 403 })
      case "not-editable":
        return NextResponse.json({
          error: outcome.delivered
            ? "A delivered order cannot be edited"
            : `Cannot edit an order in ${outcome.status} state`,
        }, { status: 409 })
      case "invalid":
        return NextResponse.json({ error: outcome.message }, { status: 400 })
      case "conflict":
        return NextResponse.json({ error: "The order was changed by another request; reload and try again" }, { status: 409 })
    }
  } catch (error) {
    const handled = handleError(error, "PUT /api/v1/order-desk/orders/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

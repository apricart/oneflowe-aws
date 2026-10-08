import { NextResponse } from "next/server"
import { eq } from "drizzle-orm"

import { orders } from "@/db/schema"
import { error, requireApiRole } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { isInvoiceAvailableForOrder } from "@/lib/invoice-availability"
import { withRateLimit } from "@/lib/rate-limiter"
import { buildInvoiceDocument } from "@/lib/server/invoice-document"
import { loadWarehouseOrderInReach } from "@/lib/server/warehouse-scope"
import { parseRouteId } from "@/lib/warehouse-orders"

export const dynamic = "force-dynamic"

/**
 * The invoice PDF of one order at a branch this warehouse user serves — the
 * same document the customer downloads (`buildInvoiceDocument`), so it can
 * travel with the goods. Authorized by the branch reach, never by the tenant
 * invoice policy, which this role has no organization for. Out of reach is
 * 404; an order with no invoice yet is 409, as for every other reader.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  try {
    const roleError = await requireApiRole(["WAREHOUSE"])
    if (roleError) return roleError
    const user = await getCurrentUser()
    if (!user) return error("Unauthorized", 401)

    const orderId = parseRouteId((await props.params).id)
    if (orderId === null) return error("Order not found", 404)

    const rateLimited = await withRateLimit("api", user.id)
    if (rateLimited) return rateLimited

    if (!await loadWarehouseOrderInReach(db, user.id, orderId)) return error("Order not found", 404)

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1)
    if (!order) return error("Order not found", 404)
    if (!isInvoiceAvailableForOrder(order)) return error("Invoice is available after the order is approved", 409)
    if (!order.receiptData) return error("Invoice not found", 404)

    const { pdf, fileName } = await buildInvoiceDocument(order)
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (caught) {
    const handled = handleError(caught, "GET /api/v1/warehouse/orders/[id]/invoice")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

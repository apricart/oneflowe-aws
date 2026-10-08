import { NextRequest, NextResponse } from "next/server"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { authorizeInvoiceRequest } from "@/lib/server/invoice-access"
import { buildInvoiceDocument } from "@/lib/server/invoice-document"

export async function GET(
    req: NextRequest,
    props: { params: Promise<{ orderId: string }> }
) {
    try {
        const params = await props.params
        const orderId = Number.parseInt(params.orderId)
        if (Number.isNaN(orderId)) {
            return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
        }

        // Single authority for authentication, tenant isolation, role access,
        // per-user ownership, and invoice availability.
        const access = await authorizeInvoiceRequest(orderId)
        if (!access.ok) {
            return NextResponse.json({ error: access.denial.error }, { status: access.denial.status })
        }
        const { order, role: userRole } = access

        const pricesHidden = await shouldHidePricesForRole(userRole, order.organizationId)
        if (pricesHidden) {
            return NextResponse.json({ error: "Invoice download is unavailable while prices are hidden" }, { status: 403 })
        }

        // The document itself is shared with the warehouse's download, so the
        // two can never print different invoices for one order.
        const { pdf, fileName } = await buildInvoiceDocument(order)

        return new NextResponse(pdf, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="${fileName}"`,
                // An invoice is per-user tenant data, and a stale copy must
                // never be replayed from a browser or proxy cache.
                "Cache-Control": "no-store",
            },
        })
    } catch (e: any) {
        console.error("Invoice generation error:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

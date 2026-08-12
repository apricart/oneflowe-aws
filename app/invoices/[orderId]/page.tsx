import { ReceiptContent } from "@/components/receipts/receipt-content"

export default async function InvoicePage({ params }: Readonly<{ params: Promise<{ orderId: string }> }>) {
    const { orderId: orderIdParam } = await params
    const orderId = Number.parseInt(orderIdParam)

    if (Number.isNaN(orderId)) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-lg font-semibold text-slate-600">Invalid Order ID</p>
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-slate-100 p-4 md:p-8">
            <div className="max-w-[850px] mx-auto">
                <ReceiptContent orderId={orderId} standalone={true} />
            </div>
        </div>
    )
}

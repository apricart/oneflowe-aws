"use client"

import { format } from "date-fns"
import { ChevronUp, Loader2, Package } from "lucide-react"
import type { ReactNode } from "react"
import useSWR from "swr"

import type { OrderDetailLine } from "@/components/orders/order-detail-panel"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { calculateLineCents, formatQuantity } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

/** The fields of `GET /api/v1/orders/[id]` this panel reads. */
export type OrderReportDetail = {
    id: number
    tid: string
    createdAt: string
    approvedAt?: string | null
    fulfilledAt?: string | null
    deliveredAt?: string | null
    rejectedAt?: string | null
    refundedAt?: string | null
    subtotalCents: number | null
    taxCents: number | null
    totalCents: number | null
    refundAmountCents: number | null
    poNumber?: string | null
    notes?: string | null
    rejectionReason?: string | null
    refundReason?: string | null
    branchName?: string | null
    creatorName?: string | null
    creatorEmployeeId?: string | null
    orderItems?: OrderDetailLine[]
    pricesHidden?: boolean
}

async function fetchOrderDetail(url: string): Promise<OrderReportDetail> {
    const response = await fetch(url)
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
        throw new Error(typeof data?.error === "string" ? data.error : "Unable to load order details")
    }
    if (!data?.item) throw new Error("Order details are unavailable")
    return data.item as OrderReportDetail
}

const formatDateTime = (value?: string | null) =>
    value ? format(new Date(value), "dd MMM yyyy, p") : "—"

type SummaryField = { label: string; value: ReactNode; wide?: boolean }

function summaryFields(detail: OrderReportDetail, pricesHidden: boolean): SummaryField[] {
    const placedBy = [detail.creatorName, detail.creatorEmployeeId ? `#${detail.creatorEmployeeId}` : null]
        .filter(Boolean)
        .join(" · ")
    const fields: SummaryField[] = [
        { label: "Order ID", value: `#${detail.id}` },
        { label: "Placed By", value: placedBy || "—" },
        { label: "Branch", value: detail.branchName || "—" },
        { label: "Placed On", value: formatDateTime(detail.createdAt) },
        { label: "Approved On", value: formatDateTime(detail.approvedAt) },
        { label: "Delivered On", value: formatDateTime(detail.deliveredAt) },
        { label: "Fulfilled On", value: formatDateTime(detail.fulfilledAt) },
    ]
    if (detail.rejectedAt) fields.push({ label: "Rejected On", value: formatDateTime(detail.rejectedAt) })
    if (detail.refundedAt) fields.push({ label: "Refunded On", value: formatDateTime(detail.refundedAt) })
    if (detail.poNumber) fields.push({ label: "PO Number", value: detail.poNumber })
    if (!pricesHidden) {
        const refundCents = Number(detail.refundAmountCents || 0)
        fields.push(
            { label: "Subtotal", value: formatPKR(Number(detail.subtotalCents || 0) / 100) },
            { label: "Tax", value: formatPKR(Number(detail.taxCents || 0) / 100) },
            { label: "Total", value: formatPKR(Number(detail.totalCents || 0) / 100) },
            { label: "Refunded", value: refundCents > 0 ? `-${formatPKR(refundCents / 100)}` : "—" },
            { label: "Net Value", value: formatPKR((Number(detail.totalCents || 0) - refundCents) / 100) },
        )
    }
    if (detail.notes) fields.push({ label: "Notes", value: detail.notes, wide: true })
    if (detail.rejectionReason) fields.push({ label: "Rejection Reason", value: detail.rejectionReason, wide: true })
    if (detail.refundReason) fields.push({ label: "Refund Reason", value: detail.refundReason, wide: true })
    return fields
}

/**
 * The expanded body of one Order Report row: the order's details and its line
 * items, read from the same order endpoint the Orders page uses. That endpoint
 * enforces the caller's branch and tenant scope and blanks prices for a viewer
 * who may not see them, so nothing shown here is wider than the order itself.
 */
export function OrderReportRowDetails({
    orderId,
    tid,
    columnCount,
    onCollapse,
}: Readonly<{
    orderId: number
    tid: string
    /** How many columns the report currently shows, so the row spans them all. */
    columnCount: number
    onCollapse: () => void
}>) {
    const { data, error, isLoading, mutate } = useSWR(`/api/v1/orders/${orderId}`, fetchOrderDetail, {
        revalidateOnFocus: false,
    })
    const pricesHidden = data?.pricesHidden === true || data?.totalCents === null
    const lines = data?.orderItems ?? []
    const totalQuantity = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0)
    const totalRefunded = lines.reduce((sum, line) => sum + Number(line.quantityRefunded || 0), 0)
    const linesTotalCents = lines.reduce(
        (sum, line) => sum + (line.priceCents === null ? 0 : calculateLineCents(line.priceCents, line.quantity)),
        0,
    )

    let body: ReactNode
    if (isLoading) {
        body = (
            <div className="flex min-h-32 items-center justify-center gap-2 text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                <span className="text-[10px] font-bold uppercase tracking-wider">Loading order details</span>
            </div>
        )
    } else if (error || !data) {
        body = (
            <div role="alert" className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl bg-rose-50/60 px-4 text-center dark:bg-rose-950/20">
                <p className="text-xs font-semibold text-rose-600 dark:text-rose-300">
                    {error instanceof Error ? error.message : "Unable to load order details"}
                </p>
                <Button type="button" variant="outline" size="sm" onClick={() => mutate()} className="h-8 rounded-xl text-[10px] font-bold uppercase tracking-wider">
                    Try Again
                </Button>
            </div>
        )
    } else {
        body = (
            <div className="space-y-5">
                <section aria-label={`Order ${tid} details`}>
                    <h4 className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Order Details</h4>
                    <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border border-slate-200 bg-white md:grid-cols-4 dark:border-slate-800 dark:bg-slate-950">
                        {summaryFields(data, pricesHidden).map((field) => (
                            <div
                                key={field.label}
                                className={`border-b border-r border-slate-100 px-4 py-3 dark:border-slate-800 ${field.wide ? "col-span-2 md:col-span-4" : ""}`}
                            >
                                <dt className="text-[9px] font-black uppercase tracking-widest text-slate-400">{field.label}</dt>
                                <dd className="mt-1 whitespace-normal break-words text-[12px] font-bold text-slate-800 dark:text-slate-100">{field.value}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section aria-label={`Order ${tid} items`}>
                    <h4 className="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-500">
                        Items ({lines.length})
                    </h4>
                    {lines.length === 0 ? (
                        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-xs font-medium text-slate-400 dark:border-slate-800 dark:bg-slate-950">
                            No product lines are available for this order.
                        </p>
                    ) : (
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
                            <Table aria-label={`Items in order ${tid}`}>
                                <TableHeader>
                                    <TableRow className="bg-slate-50 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-900">
                                        <TableHead className="w-12 px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">#</TableHead>
                                        <TableHead className="px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Product</TableHead>
                                        <TableHead className="px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Code</TableHead>
                                        <TableHead className="px-4 text-[10px] font-black uppercase tracking-widest text-slate-500">Unit</TableHead>
                                        <TableHead className="px-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Qty</TableHead>
                                        <TableHead className="px-4 text-right text-[10px] font-black uppercase tracking-widest text-rose-500">Qty Refunded</TableHead>
                                        {!pricesHidden && <TableHead className="px-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Unit Price</TableHead>}
                                        {!pricesHidden && <TableHead className="px-4 text-right text-[10px] font-black uppercase tracking-widest text-slate-500">Line Total</TableHead>}
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {lines.map((line, index) => (
                                        <TableRow key={line.id}>
                                            <TableCell className="px-4 py-3 text-[11px] font-bold text-slate-400 tabular-nums">{index + 1}</TableCell>
                                            <TableCell className="px-4 py-3 whitespace-normal break-words text-[12px] font-bold text-slate-900 dark:text-white">{line.productName}</TableCell>
                                            <TableCell className="px-4 py-3 font-mono text-[11px] text-slate-500">{line.productCode || "—"}</TableCell>
                                            <TableCell className="px-4 py-3 text-[11px] text-slate-500">{line.unit || "—"}</TableCell>
                                            <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-bold tabular-nums">{formatQuantity(line.quantity)}</TableCell>
                                            <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-bold tabular-nums text-rose-500">
                                                {Number(line.quantityRefunded || 0) > 0 ? formatQuantity(line.quantityRefunded) : "—"}
                                            </TableCell>
                                            {!pricesHidden && (
                                                <TableCell className="px-4 py-3 text-right font-mono text-[12px] tabular-nums">
                                                    {line.priceCents === null ? "—" : formatPKR(line.priceCents / 100)}
                                                </TableCell>
                                            )}
                                            {!pricesHidden && (
                                                <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-bold tabular-nums text-indigo-600 dark:text-indigo-400">
                                                    {line.priceCents === null ? "—" : formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)}
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    ))}
                                </TableBody>
                                <TableFooter>
                                    <TableRow className="hover:bg-transparent">
                                        <TableCell colSpan={4} className="px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-500">Total</TableCell>
                                        <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-black tabular-nums">{formatQuantity(totalQuantity)}</TableCell>
                                        <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-black tabular-nums text-rose-500">
                                            {totalRefunded > 0 ? formatQuantity(totalRefunded) : "—"}
                                        </TableCell>
                                        {!pricesHidden && <TableCell className="px-4 py-3" />}
                                        {!pricesHidden && (
                                            <TableCell className="px-4 py-3 text-right font-mono text-[12px] font-black tabular-nums text-indigo-600 dark:text-indigo-400">
                                                {formatPKR(linesTotalCents / 100)}
                                            </TableCell>
                                        )}
                                    </TableRow>
                                </TableFooter>
                            </Table>
                        </div>
                    )}
                </section>
            </div>
        )
    }

    return (
        <TableRow className="border-b border-indigo-100 bg-indigo-50/40 hover:bg-indigo-50/40 dark:border-indigo-900/40 dark:bg-indigo-950/10 dark:hover:bg-indigo-950/10">
            <TableCell colSpan={columnCount} className="p-0">
                {/* Pinned to the visible part of the 2100px report while it scrolls sideways. */}
                <div id={`order-report-details-${orderId}`} className="sticky left-0 w-full max-w-6xl space-y-4 px-5 py-5 whitespace-normal">
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex min-w-0 items-center gap-2">
                            <Package className="h-4 w-4 shrink-0 text-indigo-500" />
                            <span className="text-[11px] font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Order</span>
                            <span className="truncate font-mono text-[12px] font-black text-indigo-600 dark:text-indigo-400">{tid}</span>
                        </div>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={onCollapse}
                            aria-controls={`order-report-details-${orderId}`}
                            className="h-8 gap-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider"
                        >
                            <ChevronUp className="h-3.5 w-3.5" />
                            Collapse
                        </Button>
                    </div>
                    {body}
                </div>
            </TableCell>
        </TableRow>
    )
}

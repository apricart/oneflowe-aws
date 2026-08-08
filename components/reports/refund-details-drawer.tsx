"use client"

import { Drawer } from "vaul"
import {
    Building2,
    CalendarDays,
    CircleDollarSign,
    Clock3,
    PackageOpen,
    ReceiptText,
    RotateCcw,
    ShoppingBag,
    UsersRound,
    X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

interface RefundDetailLine {
    orderItemId: number
    productName: string
    productCode: string | null
    unit: string
    quantity: number
    amountCents: number | null
}

export interface RefundDetailsRecord {
    refundNumber: string
    status: string
    refundType: "FULL" | "PARTIAL"
    reason: string | null
    createdAt: string
    updatedAt: string
    tid: string
    orderStatus: string
    statusAtRefund: string | null
    paymentStatus: string
    orderCreatedAt: string
    organizationName: string | null
    groupName: string | null
    branchName: string | null
    requestedByName: string | null
    requestedByEmail: string | null
    requestedByEmployeeId: string | null
    processedByName: string | null
    processedByEmail: string | null
    amountCents: number | null
    taxRefundCents: number | null
    itemRefundCents: number | null
    orderTotalCents: number | null
    quantityRefunded: number
    itemCount: number
    items: RefundDetailLine[]
}

interface RefundDetailsDrawerProps {
    open: boolean
    onClose: () => void
    refund: RefundDetailsRecord | null
    pricesHidden: boolean
}

const money = (cents: number | null | undefined) => formatPKR(Number(cents || 0) / 100)

const statusStyles: Record<string, string> = {
    PENDING: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
    COMPLETED: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
    CANCELLED: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
    SUPERSEDED: "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

function DetailValue({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div className="min-w-0">
            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">{label}</p>
            <div className={cn("break-words text-sm font-bold text-slate-800 dark:text-slate-100", mono && "font-mono text-xs")}>{value}</div>
        </div>
    )
}

function DetailGroup({
    icon: Icon,
    title,
    children,
    className,
}: {
    icon: React.ElementType
    title: string
    children: React.ReactNode
    className?: string
}) {
    return (
        <section className={cn("rounded-3xl border border-slate-200/80 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900/70", className)}>
            <div className="mb-5 flex items-center gap-2.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300">
                    <Icon className="h-4 w-4" />
                </span>
                <h3 className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-800 dark:text-slate-100">{title}</h3>
            </div>
            {children}
        </section>
    )
}

export function RefundDetailsDrawer({ open, onClose, refund, pricesHidden }: RefundDetailsDrawerProps) {
    if (!refund) return null

    const requestedBy = refund.requestedByName || refund.requestedByEmail || "System generated"
    const processedBy = refund.processedByName || refund.processedByEmail || "Not processed"
    const status = refund.status.toUpperCase()

    return (
        <Drawer.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()} direction="right">
            <Drawer.Portal>
                <Drawer.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
                <Drawer.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col rounded-l-[2rem] border-l border-slate-200 bg-slate-50 shadow-2xl outline-none dark:border-slate-800 dark:bg-slate-950">
                    <header className="relative overflow-hidden border-b border-slate-200 bg-white px-6 py-6 dark:border-slate-800 dark:bg-slate-950 sm:px-8">
                        <div className="pointer-events-none absolute -right-12 -top-16 h-40 w-40 rounded-full bg-rose-500/10 blur-3xl" />
                        <div className="relative flex items-start justify-between gap-5">
                            <div className="min-w-0">
                                <div className="mb-3 flex flex-wrap items-center gap-2">
                                    <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 to-orange-500 text-white shadow-lg shadow-rose-500/20">
                                        <RotateCcw className="h-5 w-5" />
                                    </span>
                                    <Badge variant="outline" className={cn("rounded-xl px-2.5 py-1 text-[9px] font-black uppercase tracking-wider", statusStyles[status])}>{refund.status}</Badge>
                                    <Badge variant="outline" className="rounded-xl border-violet-200 bg-violet-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300">{refund.refundType} refund</Badge>
                                </div>
                                <Drawer.Title className="break-all font-mono text-xl font-black tracking-tight text-slate-900 dark:text-white">{refund.refundNumber}</Drawer.Title>
                                <Drawer.Description className="mt-1.5 flex items-center gap-2 text-xs font-semibold text-slate-400">
                                    <ShoppingBag className="h-3.5 w-3.5" /> Order {refund.tid}
                                </Drawer.Description>
                            </div>
                            <Button variant="ghost" size="icon" onClick={onClose} className="shrink-0 rounded-2xl text-slate-400 hover:text-slate-900 dark:hover:text-white" aria-label="Close refund details">
                                <X className="h-5 w-5" />
                            </Button>
                        </div>
                    </header>

                    <div className="flex-1 space-y-5 overflow-y-auto p-5 sm:p-7">
                        <section className="rounded-3xl border border-rose-200/80 bg-gradient-to-br from-rose-50 to-orange-50 p-5 dark:border-rose-900/60 dark:from-rose-950/35 dark:to-orange-950/20">
                            <div className="mb-2 flex items-center gap-2 text-rose-600 dark:text-rose-300">
                                <ReceiptText className="h-4 w-4" />
                                <h3 className="text-[10px] font-black uppercase tracking-[0.18em]">Refund reason</h3>
                            </div>
                            <p className="whitespace-pre-wrap break-words text-sm font-bold leading-6 text-slate-800 dark:text-slate-100">
                                {refund.reason || "No reason was recorded for this refund."}
                            </p>
                        </section>

                        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <Clock3 className="mb-3 h-4 w-4 text-amber-500" />
                                <DetailValue label="Status" value={refund.status} />
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <PackageOpen className="mb-3 h-4 w-4 text-violet-500" />
                                <DetailValue label="Type" value={`${refund.refundType} refund`} />
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <CalendarDays className="mb-3 h-4 w-4 text-blue-500" />
                                <DetailValue label="Requested" value={new Date(refund.createdAt).toLocaleDateString()} />
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                                <RotateCcw className="mb-3 h-4 w-4 text-rose-500" />
                                <DetailValue label="Quantity" value={formatQuantity(refund.quantityRefunded)} />
                            </div>
                        </section>

                        <div className="grid gap-5 md:grid-cols-2">
                            <DetailGroup icon={ShoppingBag} title="Order">
                                <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                                    <DetailValue label="Transaction ID" value={refund.tid} mono />
                                    <DetailValue label="Order status" value={refund.orderStatus} />
                                    <DetailValue label="Status at refund" value={refund.statusAtRefund || "Not yet applied"} />
                                    <DetailValue label="Payment" value={refund.paymentStatus} />
                                    <DetailValue label="Ordered on" value={new Date(refund.orderCreatedAt).toLocaleDateString()} />
                                    <DetailValue label="Updated" value={new Date(refund.updatedAt).toLocaleDateString()} />
                                </div>
                            </DetailGroup>

                            <DetailGroup icon={Building2} title="Location">
                                <div className="grid grid-cols-2 gap-x-5 gap-y-5">
                                    <DetailValue label="Organization" value={refund.organizationName || "-"} />
                                    <DetailValue label="Group" value={refund.groupName || "-"} />
                                    <div className="col-span-2"><DetailValue label="Branch" value={refund.branchName || "-"} /></div>
                                </div>
                            </DetailGroup>

                            <DetailGroup icon={UsersRound} title="People" className="md:col-span-2">
                                <div className="grid gap-5 sm:grid-cols-3">
                                    <DetailValue label="Requested by" value={requestedBy} />
                                    <DetailValue label="Employee number" value={refund.requestedByEmployeeId ? `#${refund.requestedByEmployeeId}` : "-"} mono />
                                    <DetailValue label="Processed by" value={processedBy} />
                                </div>
                            </DetailGroup>
                        </div>

                        {!pricesHidden && (
                            <DetailGroup icon={CircleDollarSign} title="Financial breakdown">
                                <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
                                    <DetailValue label="Item refund" value={money(refund.itemRefundCents)} mono />
                                    <DetailValue label="Tax refund" value={money(refund.taxRefundCents)} mono />
                                    <DetailValue label="Total refund" value={<span className="text-rose-500">{money(refund.amountCents)}</span>} mono />
                                    <DetailValue label="Order total" value={money(refund.orderTotalCents)} mono />
                                </div>
                            </DetailGroup>
                        )}

                        <DetailGroup icon={PackageOpen} title={`Refunded items (${refund.itemCount})`}>
                            {refund.items.length > 0 ? (
                                <div className="overflow-hidden rounded-2xl border border-slate-200 dark:border-slate-800">
                                    <div className={cn("grid gap-3 bg-slate-50 px-4 py-2.5 text-[9px] font-black uppercase tracking-wider text-slate-400 dark:bg-slate-950/70", pricesHidden ? "grid-cols-[1fr_90px]" : "grid-cols-[1fr_90px_120px]")}>
                                        <span>Product</span><span className="text-right">Quantity</span>{!pricesHidden && <span className="text-right">Amount</span>}
                                    </div>
                                    {refund.items.map((item) => (
                                        <div key={item.orderItemId} className={cn("grid items-center gap-3 border-t border-slate-100 px-4 py-3 dark:border-slate-800", pricesHidden ? "grid-cols-[1fr_90px]" : "grid-cols-[1fr_90px_120px]")}>
                                            <div className="min-w-0">
                                                <p className="break-words text-xs font-black text-slate-800 dark:text-slate-100">{item.productName}</p>
                                                <p className="mt-1 font-mono text-[9px] font-semibold text-slate-400">{item.productCode || "No product code"}</p>
                                            </div>
                                            <p className="text-right font-mono text-xs font-black text-slate-700 dark:text-slate-200">{formatQuantity(item.quantity)} {item.unit}</p>
                                            {!pricesHidden && <p className="text-right font-mono text-xs font-black text-rose-500">{money(item.amountCents)}</p>}
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="rounded-2xl border border-dashed border-slate-200 p-5 text-center text-xs font-semibold text-slate-400 dark:border-slate-800">No item-level breakdown is available.</div>
                            )}
                        </DetailGroup>
                    </div>

                    <footer className="border-t border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950 sm:px-8">
                        <Button onClick={onClose} className="h-11 w-full rounded-2xl bg-slate-900 font-bold text-white hover:bg-black dark:bg-white dark:text-slate-900 dark:hover:bg-slate-100">Close details</Button>
                    </footer>
                </Drawer.Content>
            </Drawer.Portal>
        </Drawer.Root>
    )
}

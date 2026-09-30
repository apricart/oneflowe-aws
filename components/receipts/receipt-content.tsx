"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Download, LifeBuoy, X, Printer } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import useSWR from "swr"
import Image from "next/image"
import { getReceiptItemQuantity, toDisplayNameCase } from "@/lib/receipt-display"
import { INVOICE_ISSUER } from "@/lib/invoice-issuer"
import { normalizePaymentStatus } from "@/lib/payment-status"
import { formatInvoiceDisplayDate, INVOICE_SYSTEM_GENERATED_NOTE } from "@/lib/invoice-format"
import { formatQuantity } from "@/lib/quantity"
import {
    buildInvoiceLines,
    buildInvoiceTotals,
    formatInvoiceMoney,
    formatInvoiceQuantity,
    formatInvoiceTaxPercent,
} from "@/lib/invoice-lines"
import { safeFilenamePart } from "@/lib/security"

const fetcher = async (url: string) => {
    const response = await fetch(url)
    const body = await response.json()

    if (!response.ok) {
        throw new Error(body?.error || "Failed to load invoice")
    }

    return body
}

function getStatusBadgeClass(statusKey: string) {
    if (statusKey === "fulfilled") return "text-emerald-600 bg-emerald-50"
    if (statusKey === "partially_fulfilled" || statusKey === "partially_refunded") return "text-indigo-600 bg-indigo-50"
    if (statusKey === "approved") return "text-blue-600 bg-blue-50"
    if (statusKey === "pending") return "text-amber-600 bg-amber-50"
    return "text-rose-600 bg-rose-50"
}

interface ReceiptContentProps {
    orderId: number
    standalone?: boolean
    onClose?: () => void
}

export function ReceiptContent({ orderId, standalone = false, onClose }: Readonly<ReceiptContentProps>) {
    const { toast } = useToast()
    const [isDownloading, setIsDownloading] = useState(false)

    const { data, error, isLoading } = useSWR(
        `/api/v1/receipts/${orderId}`,
        fetcher
    )

    const handleDownload = async () => {
        setIsDownloading(true)
        try {
            const response = await fetch(`/api/v1/receipts/${orderId}/download`)
            if (!response.ok) throw new Error("Failed to download invoice")

            const blob = await response.blob()
            const url = window.URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = `invoice-${safeFilenamePart(data?.receiptData?.invoiceNumber, String(orderId))}.pdf`
            document.body.appendChild(a)
            a.click()
            window.URL.revokeObjectURL(url)
            a.remove()

            toast({ title: "Success", description: "Invoice downloaded successfully" })
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.message || "Failed to download invoice",
                variant: "destructive",
            })
        } finally {
            setIsDownloading(false)
        }
    }

    const handlePrint = () => {
        window.print()
    }

    const receiptData = data?.receiptData
    const pricesHidden = Boolean(data?.pricesHidden)

    if (isLoading) {
        return (
            <div className="flex flex-col items-center justify-center py-24">
                <div className="relative">
                    <div className="h-10 w-10 rounded-full border-2 border-slate-100" />
                    <div className="absolute inset-0 h-10 w-10 animate-spin rounded-full border-2 border-transparent border-t-slate-800" />
                </div>
                <p className="text-sm text-slate-400 mt-4 font-medium">Loading official invoice...</p>
            </div>
        )
    }

    if (error || !receiptData) {
        return (
            <div className="flex flex-col items-center justify-center py-24">
                <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center mb-3">
                    <X className="h-5 w-5 text-red-400" />
                </div>
                <p className="text-sm text-slate-600 font-medium">Invoice Not Available</p>
                <p className="text-xs text-slate-400 mt-1">
                    {error instanceof Error ? error.message : "Check your connection or order ID."}
                </p>
            </div>
        )
    }

    const itemQuantity = getReceiptItemQuantity(receiptData.items)
    const refundedItems = Array.isArray(receiptData.refundedItems) ? receiptData.refundedItems : []
    const refundAmount = Number(receiptData.refund || 0)
    const invoiceLines = buildInvoiceLines(receiptData)
    const invoiceTotals = buildInvoiceTotals(receiptData, invoiceLines, refundAmount)
    const statusKey = String(receiptData.statusKey || receiptData.status || "PENDING").toLowerCase()
    const isPaid = normalizePaymentStatus(receiptData.paymentStatus) === "PAID"
    const orderReference = receiptData.orderId || data?.orderId || orderId || "N/A"

    return (
        <div className={`receipt-container ${standalone ? 'py-8 px-4' : 'p-2'}`}>
            {/* Professional Styles */}
            <style>{`
                .official-invoice {
                    font-family: var(--font-geist-sans), Arial, sans-serif;
                    background: white;
                    border: 1px solid #e2e8f0;
                    padding: 40px;
                    max-width: 850px;
                    margin: 0 auto;
                    box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.1);
                    position: relative;
                }

                /* Masthead: issuer identity on the left, document title on the right */
                .invoice-masthead {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 24px;
                    padding-bottom: 20px;
                }

                .masthead-identity {
                    display: flex;
                    align-items: flex-start;
                    gap: 18px;
                }

                .issuer-name {
                    font-size: 15px;
                    font-weight: 800;
                    color: #0f172a;
                    letter-spacing: -0.01em;
                    margin: 0 0 4px;
                }

                .issuer-line {
                    font-size: 10.5px;
                    color: #64748b;
                    line-height: 1.5;
                    margin: 0;
                }

                .masthead-title {
                    font-size: 30px;
                    font-weight: 300;
                    letter-spacing: 0.08em;
                    color: #334155;
                    white-space: nowrap;
                    padding-top: 4px;
                    text-align: right;
                }

                /* Printed only for an invoice the order records as settled. */
                .paid-stamp {
                    display: inline-block;
                    margin-top: 14px;
                    padding: 4px 18px;
                    border: 3px double #15803d;
                    border-radius: 4px;
                    color: #15803d;
                    font-size: 20px;
                    font-weight: 800;
                    letter-spacing: 0.18em;
                    line-height: 1.1;
                    transform: rotate(-8deg);
                }

                /* Bordered party grid: invoice meta, then Bill To / Delivery To */
                .invoice-parties {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    border: 1px solid #cbd5e1;
                    border-bottom: none;
                    margin-bottom: 24px;
                }

                .party-cell {
                    padding: 10px 12px;
                    border-bottom: 1px solid #cbd5e1;
                }

                .party-head {
                    background: #f1f5f9;
                    padding: 6px 12px;
                    border-bottom: 1px solid #cbd5e1;
                    font-size: 10px;
                    font-weight: 800;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                    color: #475569;
                }

                .party-right {
                    border-left: 1px solid #cbd5e1;
                }

                .meta-line {
                    display: grid;
                    grid-template-columns: 104px 10px 1fr;
                    align-items: baseline;
                    font-size: 11.5px;
                    margin-bottom: 4px;
                }

                .meta-key {
                    color: #64748b;
                    font-weight: 600;
                }

                .meta-value {
                    color: #0f172a;
                    font-weight: 700;
                    overflow-wrap: anywhere;
                }

                .party-name {
                    font-size: 13px;
                    font-weight: 700;
                    color: #0f172a;
                    margin: 0 0 4px;
                }

                .party-line {
                    font-size: 11px;
                    color: #334155;
                    line-height: 1.6;
                    margin: 0;
                    overflow-wrap: anywhere;
                }

                .party-label {
                    color: #64748b;
                    font-weight: 600;
                }

                /* Enhanced Table Styles */
                .items-table {
                    width: 100%;
                    border-collapse: collapse;
                    margin-bottom: 24px;
                }

                .items-table th {
                    background: #0f172a;
                    color: white;
                    text-align: left;
                    padding: 10px 12px;
                    font-size: 11px;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                }

                .items-table td {
                    padding: 8px 12px;
                    font-size: 12px;
                    border-bottom: 1px solid #f1f5f9;
                    vertical-align: top;
                }

                /*
                 * A long product name wraps within its column and the row
                 * grows, rather than being cut short or pushing the money
                 * columns off the page. Breaking anywhere also wraps an
                 * unbroken product code, which has no space to break at.
                 */
                .items-table .item-description {
                    overflow-wrap: anywhere;
                    word-break: break-word;
                }

                .summary-block {
                    display: flex;
                    justify-content: flex-end;
                    margin-top: 24px;
                }

                .summary-table {
                    width: 280px;
                }

                .summary-row {
                    display: flex;
                    justify-content: space-between;
                    padding: 6px 0;
                    font-size: 12px;
                    border-bottom: 1px dashed #e2e8f0;
                }

                .payable-hightlight {
                    background: #0f172a;
                    color: white;
                    margin-top: 12px;
                    padding: 12px 16px;
                    border-radius: 8px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }

                .payable-label {
                    font-size: 12px;
                    font-weight: 700;
                    text-transform: uppercase;
                }

                .payable-value {
                    font-size: 20px;
                    font-weight: 800;
                }

                @media print {
                    .print-hidden { display: none !important; }
                    .official-invoice {
                        box-shadow: none;
                        border: none;
                        padding: 0;
                    }
                    body { -webkit-print-color-adjust: exact; }
                }
            `}</style>

            {/* Action Bar */}
            <div className="flex justify-end gap-2 mb-6 print-hidden max-w-[850px] mx-auto">
                {/* The client's route to Apricart about this exact invoice. The
                    order travels as a query parameter; whether this person may
                    cite it is decided on the server against the order row. */}
                <Button asChild variant="outline" size="sm" className="gap-2 h-9 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700 font-semibold shadow-sm">
                    <Link href={`/support?orderId=${orderId}&orderTid=${encodeURIComponent(String(orderReference))}`}>
                        <LifeBuoy className="h-4 w-4" /> Raise a Query
                    </Link>
                </Button>
                <Button onClick={handlePrint} variant="outline" size="sm" className="gap-2 h-9 border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700 font-semibold shadow-sm">
                    <Printer className="h-4 w-4" /> Print Invoice
                </Button>
                {!pricesHidden && (
                    <Button onClick={handleDownload} disabled={isDownloading} size="sm" className="gap-2 h-9 bg-primary hover:bg-primary/90 text-white font-semibold shadow-md">
                        <Download className="h-4 w-4" /> {isDownloading ? "Generating..." : "Download PDF"}
                    </Button>
                )}
                {onClose && (
                    <Button onClick={onClose} variant="ghost" size="sm" className="h-9 w-9 p-0">
                        <X className="h-4 w-4 text-slate-400" />
                    </Button>
                )}
            </div>

            {/* Official Invoice Content */}
            <div className="official-invoice">
                {/* Masthead */}
                <div className="invoice-masthead">
                    <div className="masthead-identity">
                        <Image
                            src="/apricart-logo-blue.png"
                            alt={INVOICE_ISSUER.name}
                            width={150}
                            height={42}
                            className="object-contain shrink-0"
                            priority
                        />
                        <div>
                            <p className="issuer-name">{INVOICE_ISSUER.name}</p>
                            {INVOICE_ISSUER.addressLines.map((line) => (
                                <p key={line} className="issuer-line">{line}</p>
                            ))}
                            <p className="issuer-line">NTN: {INVOICE_ISSUER.ntn}</p>
                            <p className="issuer-line">STRN: {INVOICE_ISSUER.strn}</p>
                        </div>
                    </div>
                    <div className="masthead-title">
                        <div>INVOICE</div>
                        {isPaid && <div className="paid-stamp">PAID</div>}
                    </div>
                </div>

                {/* Invoice meta and parties */}
                <div className="invoice-parties">
                    <div className="party-cell">
                        <div className="meta-line">
                            <span className="meta-key">Invoice#</span>
                            <span className="meta-key">:</span>
                            <span className="meta-value">{receiptData.invoiceNumber || "N/A"}</span>
                        </div>
                        <div className="meta-line">
                            <span className="meta-key">Invoice Date</span>
                            <span className="meta-key">:</span>
                            <span className="meta-value">{formatInvoiceDisplayDate(receiptData.date) || "N/A"}</span>
                        </div>
                        <div className="meta-line">
                            <span className="meta-key">Order ID</span>
                            <span className="meta-key">:</span>
                            <span className="meta-value">{orderReference}</span>
                        </div>
                    </div>

                    <div className="party-cell party-right">
                        <div className="meta-line">
                            <span className="meta-key">Status</span>
                            <span className="meta-key">:</span>
                            <span>
                                <span className={`inline-block rounded px-1.5 text-[10px] font-bold uppercase ${getStatusBadgeClass(statusKey)}`}>
                                    {receiptData.status || "PENDING"}
                                </span>
                            </span>
                        </div>
                        <div className="meta-line">
                            <span className="meta-key">Total Items</span>
                            <span className="meta-key">:</span>
                            <span className="meta-value">{itemQuantity}</span>
                        </div>
                    </div>

                    <div className="party-head">Bill To</div>
                    <div className="party-head party-right">Delivery To</div>

                    <div className="party-cell">
                        <p className="party-name">{receiptData.organizationName || receiptData.buyerName || "N/A"}</p>
                        {receiptData.organizationNtn && (
                            <p className="party-line">NTN: {receiptData.organizationNtn}</p>
                        )}
                    </div>

                    <div className="party-cell party-right">
                        <p className="party-name">{receiptData.buyerName || "N/A"}</p>
                        {receiptData.organizationName && (
                            <p className="party-line">{receiptData.organizationName}</p>
                        )}
                        {/* `buyerAddress` already is the chosen delivery address
                            when the order named one. The label is shown beside
                            it so a reader can tell which of the branch's
                            addresses the goods went to. */}
                        {receiptData.deliveryAddressLabel && (
                            <p className="party-line">
                                <span className="party-label">Deliver to:</span>{" "}
                                {toDisplayNameCase(receiptData.deliveryAddressLabel)}
                            </p>
                        )}
                        <p className="party-line">
                            <span className="party-label">Address:</span>{" "}
                            {toDisplayNameCase(receiptData.buyerAddress || "—")}
                        </p>
                        <p className="party-line">
                            <span className="party-label">Phone:</span>{" "}
                            {receiptData.placedByPhone || receiptData.buyerPhone || "N/A"}
                        </p>
                        <p className="party-line">
                            <span className="party-label">Initiator:</span>{" "}
                            {toDisplayNameCase(receiptData.placedByName || "N/A")}
                        </p>
                        <p className="party-line">
                            <span className="party-label">Approver:</span>{" "}
                            {toDisplayNameCase(receiptData.approvedByName || "N/A")}
                        </p>
                        <p className="party-line">
                            <span className="party-label">Fulfiller:</span>{" "}
                            {toDisplayNameCase(receiptData.fulfilledByName || "N/A")}
                        </p>
                    </div>
                </div>

                {/* Items */}
                <table className="items-table">
                    <thead>
                        <tr>
                            <th className="w-10 text-center">#</th>
                            <th>Item &amp; Description</th>
                            <th className="text-center w-24">Qty</th>
                            {!pricesHidden && <th className="text-right w-24">Rate</th>}
                            {!pricesHidden && <th className="text-right w-16">Tax %</th>}
                            {!pricesHidden && <th className="text-right w-24">Tax</th>}
                            {!pricesHidden && <th className="text-right w-28">Amount</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {invoiceLines.map((line) => (
                            <tr key={`${line.serial}-${line.description}`}>
                                <td className="text-center text-slate-400 font-medium">{line.serial}</td>
                                <td className="item-description text-slate-800 font-medium">{line.description}</td>
                                <td className="text-center tabular-nums text-slate-600">
                                    {formatInvoiceQuantity(line.quantity)}
                                </td>
                                {!pricesHidden && <td className="text-right tabular-nums text-slate-600">{formatInvoiceMoney(line.rate)}</td>}
                                {!pricesHidden && <td className="text-right tabular-nums text-slate-500">{formatInvoiceTaxPercent(line.taxPercent)}</td>}
                                {!pricesHidden && <td className="text-right tabular-nums text-slate-600">{formatInvoiceMoney(line.tax)}</td>}
                                {!pricesHidden && <td className="text-right tabular-nums font-bold text-slate-900">{formatInvoiceMoney(line.amount)}</td>}
                            </tr>
                        ))}
                    </tbody>
                </table>

                {/* Summary & Payable */}
                {!pricesHidden && <div className="summary-block">
                    <div className="summary-table">
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">Sub Total</span>
                            <span className="font-bold text-slate-700">{formatInvoiceMoney(invoiceTotals.subTotal)}</span>
                        </div>
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">{invoiceTotals.taxLabel}</span>
                            <span className="font-bold text-slate-700">{formatInvoiceMoney(invoiceTotals.taxAmount)}</span>
                        </div>
                        {invoiceTotals.discount > 0 && (
                            <div className="summary-row">
                                <span className="text-slate-400 font-medium">Platform Discount</span>
                                <span className="font-bold text-red-500">-{formatInvoiceMoney(invoiceTotals.discount)}</span>
                            </div>
                        )}
                        {invoiceTotals.deliveryCharges > 0 && (
                            <div className="summary-row">
                                <span className="text-slate-400 font-medium">Delivery Charges</span>
                                <span className="font-bold text-slate-700">{formatInvoiceMoney(invoiceTotals.deliveryCharges)}</span>
                            </div>
                        )}
                        {refundAmount > 0 && (
                            <div className="summary-row">
                                <span className="text-slate-400 font-medium">Refunded</span>
                                <span className="font-bold text-red-500">-{formatInvoiceMoney(refundAmount)}</span>
                            </div>
                        )}
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">Rounding</span>
                            <span className="font-bold text-slate-700">{formatInvoiceMoney(invoiceTotals.rounding)}</span>
                        </div>
                        {refundedItems.length > 0 && (
                            <div className="mt-3 rounded-md border border-red-100 bg-red-50/60 p-3">
                                <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-red-500">Refunded Items</p>
                                <div className="space-y-1.5">
                                    {refundedItems.map((item: any, index: number) => (
                                        <div key={`${item.productName}-${index}`} className="flex justify-between gap-3 text-[11px]">
                                            <span className="font-semibold text-slate-600">{formatQuantity(item.quantity)}x {item.productName}</span>
                                            <span className="font-bold text-red-500">-PKR {Number(item.amount || 0).toLocaleString()}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="payable-hightlight">
                            <span className="payable-label">Total</span>
                            <span className="payable-value">PKR {formatInvoiceMoney(invoiceTotals.total)}</span>
                        </div>
                    </div>
                </div>}

                {/* Footer */}
                <div className="invoice-note mt-16 pt-8 border-t border-slate-100 text-center">
                    <p className="text-[10px] font-medium text-slate-500">{INVOICE_SYSTEM_GENERATED_NOTE}</p>
                    <p className="mt-1 text-[9px] text-slate-300">Generated on: {new Date().toLocaleString()}</p>
                </div>
            </div>
        </div>
    )
}

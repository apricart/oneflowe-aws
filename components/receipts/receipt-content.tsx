"use client"

import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Download, X, Printer, FileText, CheckCircle2, ChevronRight } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import useSWR from "swr"
import Image from "next/image"
import { getReceiptItemQuantity, toDisplayNameCase } from "@/lib/receipt-display"
import { formatQuantity } from "@/lib/quantity"
import { safeFilenamePart } from "@/lib/security"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface ReceiptContentProps {
    orderId: number
    standalone?: boolean
    onClose?: () => void
}

export function ReceiptContent({ orderId, standalone = false, onClose }: ReceiptContentProps) {
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
            document.body.removeChild(a)

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
                <p className="text-xs text-slate-400 mt-1">Check your connection or order ID.</p>
            </div>
        )
    }

    let serialCounter = 0
    const itemQuantity = getReceiptItemQuantity(receiptData.items)
    const refundedItems = Array.isArray(receiptData.refundedItems) ? receiptData.refundedItems : []
    const refundAmount = Number(receiptData.refund || 0)
    const statusKey = String(receiptData.statusKey || receiptData.status || "PENDING").toLowerCase()

    return (
        <div className={`receipt-container ${standalone ? 'py-8 px-4' : 'p-2'}`}>
            {/* Professional Styles */}
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');
                
                .official-invoice {
                    font-family: 'Outfit', sans-serif;
                    background: white;
                    border: 1px solid #e2e8f0;
                    padding: 40px;
                    max-width: 850px;
                    margin: 0 auto;
                    box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.1);
                    position: relative;
                }

                .official-header {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    align-items: flex-start;
                    border-bottom: 2px solid #e2e8f0;
                    padding-bottom: 24px;
                    margin-bottom: 30px;
                }

                .org-info {
                    text-align: right;
                    font-size: 11px;
                    color: #64748b;
                    line-height: 1.6;
                }

                .invoice-meta {
                    text-align: right;
                    font-family: 'Outfit', sans-serif;
                }

                .invoice-meta h1 {
                    font-size: 22px;
                    font-weight: 800;
                    color: #0f172a;
                    margin-bottom: 4px;
                    letter-spacing: -0.02em;
                }

                .meta-item {
                    font-size: 13px;
                    color: #1e293b;
                    margin-bottom: 2px;
                }

                .meta-label {
                    font-weight: 700;
                    text-transform: uppercase;
                    color: #64748b;
                    margin-right: 8px;
                    font-size: 11px;
                }

                .detail-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr 1fr;
                    gap: 16px;
                    margin-bottom: 24px;
                }

                .detail-section {
                    border: 1px solid #f1f5f9;
                    background: #fbfcfd;
                    border-radius: 8px;
                    padding: 12px;
                }

                .section-title {
                    font-size: 10px;
                    font-weight: 800;
                    text-transform: uppercase;
                    color: #64748b;
                    border-bottom: 1px solid #e2e8f0;
                    margin-bottom: 8px;
                    padding-bottom: 4px;
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }

                .detail-row {
                    display: flex;
                    justify-content: space-between;
                    font-size: 11px;
                    margin-bottom: 4px;
                }

                .detail-label {
                    color: #94a3b8;
                    font-weight: 500;
                }

                .detail-value {
                    color: #1e293b;
                    font-weight: 700;
                }

                .billed-to-section .detail-value {
                    text-align: right;
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
                }

                .cat-row td {
                    background: #f8fafc;
                    font-weight: 800;
                    font-size: 10px;
                    text-transform: uppercase;
                    color: #475569;
                    border-top: 1px solid #e2e8f0;
                    letter-spacing: 0.1em;
                }

                .subcat-row td {
                    font-weight: 600;
                    font-size: 10px;
                    color: #94a3b8;
                    padding-left: 24px;
                    background: #fafbfc;
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
                {/* Header */}
                <div className="official-header">
                    <div className="col-span-2 flex justify-center">
                        <Image
                            src="/apricart-logo-blue.png"
                            alt="OneFlowe Logo"
                            width={180}
                            height={50}
                            className="object-contain"
                            priority
                        />
                    </div>
                    <div className="mt-4">
                        <p className="text-[11px] font-bold text-slate-800 uppercase tracking-tight">From:</p>
                        <p className="text-[12px] font-medium text-slate-600">{"Apricart E-Store Pvt Ltd"}</p>
                    </div>

                    {/* <div className="invoice-meta">
                        <h1>INVOICE#: {receiptData.invoiceNumber}</h1>
                        <div className="meta-item">
                            <span className="meta-label">DATE:</span>
                            <span className="font-semibold">{receiptData.date}</span>
                        </div>
                        <div className="meta-item">
                            <span className="meta-label">Contact No:</span>
                            <span className="font-semibold">{receiptData.organizationContact || "0333-3182410"}</span>
                        </div>

                        <div className="mt-6">
                            <div className="meta-item">
                                <span className="meta-label">BUYER NAME:</span>
                                <span className="font-bold uppercase">{receiptData.buyerName}</span>
                            </div>
                            <div className="meta-item flex justify-end gap-1 max-w-[300px] ml-auto">
                                <span className="meta-label whitespace-nowrap">Deliver to:</span>
                                <span className="font-medium text-[11px] leading-tight text-slate-600">
                                    {receiptData.buyerAddress || "—"}
                                </span>
                            </div>
                        </div>
                    </div> */}
                </div>

                {/* Detail Grid */}
                <div className="detail-grid">
                    <div className="detail-section billed-to-section">
                        <div className="section-title">
                            <FileText className="h-3 w-3" /> Billed To
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Name:</span>
                            <span className="detail-value">{receiptData.buyerName}</span>
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Address:</span>
                            <span className="detail-value max-w-[140px]">{toDisplayNameCase(receiptData.buyerAddress || "—")}</span>
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Created By:</span>
                            <span className="detail-value truncate max-w-[140px]">
                                {toDisplayNameCase(receiptData.placedByName || "N/A")}
                            </span>
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Phone:</span>
                            <span className="detail-value">{receiptData.placedByPhone || receiptData.buyerPhone || "N/A"}</span>
                        </div>
                    </div>

                    <div className="detail-section">
                        <div className="section-title">
                            <CheckCircle2 className="h-3 w-3" /> Order Details
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Invoice #:</span>
                            <span className="detail-value">{receiptData.invoiceNumber}</span>
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Date:</span>
                            <span className="detail-value">{receiptData.date}</span>
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Status:</span>
                            <span className={`detail-value px-1.5 rounded text-[10px] uppercase ${
                                statusKey === "fulfilled" 
                                    ? "text-emerald-600 bg-emerald-50" 
                                    : statusKey === "partially_fulfilled" || statusKey === "partially_refunded"
                                    ? "text-indigo-600 bg-indigo-50"
                                    : statusKey === "approved"
                                    ? "text-blue-600 bg-blue-50"
                                    : statusKey === "pending"
                                    ? "text-amber-600 bg-amber-50"
                                    : "text-rose-600 bg-rose-50"
                            }`}>
                                {receiptData.status || "PENDING"}
                            </span>
                        </div>
                    </div>

                    <div className="detail-section">
                        <div className="section-title">
                            <FileText className="h-3 w-3" /> Quick Summary
                        </div>
                        <div className="detail-row">
                            <span className="detail-label">Items:</span>
                            <span className="detail-value">{itemQuantity}</span>
                        </div>
                        {!pricesHidden && <div className="detail-row">
                            <span className="detail-label">Subtotal:</span>
                            <span className="detail-value">PKR {Number(receiptData.subtotal).toLocaleString()}</span>
                        </div>}

                    </div>
                </div>

                {/* Items Table with Categories */}
                <table className="items-table">
                    <thead>
                        <tr>
                            <th className="w-12 text-center">#</th>
                            <th>Description</th>
                            <th className="text-center w-20">Qty</th>
                            {!pricesHidden && <th className="text-right w-24">Price</th>}
                            {!pricesHidden && <th className="text-right w-28">Total</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {receiptData?.items?.map((cat: any, i: number) => (
                            <React.Fragment key={i}>
                                <tr className="cat-row">
                                    <td colSpan={pricesHidden ? 3 : 5}>{cat.mainCategoryName || cat.categoryName}</td>
                                </tr>
                                {(cat.subCategories || [{ subCategoryName: "", items: cat.items }]).map((sub: any, si: number) => (
                                    <React.Fragment key={`${i}-${si}`}>
                                        {sub.subCategoryName && (
                                            <tr className="subcat-row">
                                                <td colSpan={pricesHidden ? 3 : 5}><ChevronRight className="inline h-3 w-3 mr-1" /> {sub.subCategoryName}</td>
                                            </tr>
                                        )}
                                        {sub.items?.map((item: any, ii: number) => {
                                            serialCounter++
                                            return (
                                                <tr key={`${i}-${si}-${ii}`}>
                                                    <td className="text-center text-slate-400 font-medium">{serialCounter}</td>
                                                    <td className="text-slate-800 font-medium">{item.description}</td>
                                                    <td className="text-center tabular-nums text-slate-600">{formatQuantity(item.quantity)}</td>
                                                    {!pricesHidden && <td className="text-right tabular-nums text-slate-600">{Number(item.rate).toLocaleString()}</td>}
                                                    {!pricesHidden && <td className="text-right tabular-nums font-bold text-slate-900">{Number(item.total).toLocaleString()}</td>}
                                                </tr>
                                            )
                                        })}
                                    </React.Fragment>
                                ))}
                            </React.Fragment>
                        ))}
                    </tbody>
                </table>

                {/* Summary & Payable */}
                {!pricesHidden && <div className="summary-block">
                    <div className="summary-table">
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">Subtotal Amount</span>
                            <span className="font-bold text-slate-700">PKR {Number(receiptData.subtotal).toLocaleString()}</span>
                        </div>
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">Tax & Processing</span>
                            <span className="font-bold text-slate-700">PKR {Number(receiptData.tax).toLocaleString()}</span>
                        </div>
                        <div className="summary-row">
                            <span className="text-slate-400 font-medium">Platform Discount</span>
                            <span className="font-bold text-red-500">-PKR {Number(receiptData.discount).toLocaleString()}</span>
                        </div>
                        {receiptData.deliveryCharges > 0 && (
                            <div className="summary-row">
                                <span className="text-slate-400 font-medium">Delivery Charges</span>
                                <span className="font-bold text-slate-700">PKR {Number(receiptData.deliveryCharges).toLocaleString()}</span>
                            </div>
                        )}
                        {refundAmount > 0 && (
                            <div className="summary-row">
                                <span className="text-slate-400 font-medium">Refunded</span>
                                <span className="font-bold text-red-500">-PKR {refundAmount.toLocaleString()}</span>
                            </div>
                        )}
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
                            <span className="payable-label">Total Payable</span>
                            <span className="payable-value">PKR {Number(receiptData.totalAmount).toLocaleString()}</span>
                        </div>
                    </div>
                </div>}

                {/* Footer */}
                <div className="mt-16 pt-8 border-t border-slate-100 flex justify-between items-end">
                    <div className="space-y-1">
                        <p className="text-[10px] text-slate-400 font-medium uppercase tracking-widest">Authentication</p>
                        <p className="text-[9px] text-slate-300">Generated on: {new Date().toLocaleString()}</p>
                        <p className="text-[9px] text-slate-300">Authorized by OneFlowe ERP System</p>
                    </div>
                    <div className="flex gap-16">
                        <div className="text-center">
                            <div className="w-32 border-t border-slate-300 pt-2">
                                <p className="text-[9px] font-bold text-slate-400 uppercase">Accountant</p>
                            </div>
                        </div>
                        <div className="text-center">
                            <div className="w-32 border-t border-slate-300 pt-2">
                                <p className="text-[9px] font-bold text-slate-400 uppercase">Authorized Sign</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

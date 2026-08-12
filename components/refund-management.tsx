"use client"

import { useState,useMemo } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle,Clock,CheckCircle } from "lucide-react"
import { Checkbox } from "@/components/ui/checkbox"
import { calculateLineCents,formatQuantity,parseQuantity,roundQuantity,sanitizeQuantityStep } from "@/lib/quantity"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { isOrderPortalRefundEligible } from "@/lib/business-rules"

interface RefundManagementProps {
    orderId: number
    orderTotalCents: number | null
    orderStatus: string
    orderFulfillmentStatus?: string | null
    createdAt: string // Order creation date for refund window validation
    requesterRole?: string
    allowRefundRequest?: boolean
    pricesHidden?: boolean
    initialOrderItems?: any[]
    refundAmountCents?: number | null
    refundedAt?: string | null
    refundReason?: string | null
    onRefundSuccess?: () => void
}

const fetcher = (url: string) => fetch(url).then(r => r.json())

type RefundAvailabilityInput = {
    pricesHidden: boolean
    quantityOnlyRefundAvailable: boolean
    remainingQuantity: number
    remainingAmount: number
    orderStatus: string
    orderItemCount: number
    totalApproved: number
    orderTotalCents: number | null
    requesterRole?: string
    orderFulfillmentStatus?: string | null
    allowRefundRequest: boolean
    isWithinRefundWindow: boolean
}

const getHasRefundCapacity = (input: RefundAvailabilityInput) => (
    input.pricesHidden
        ? input.quantityOnlyRefundAvailable && input.remainingQuantity > 0
        : input.remainingAmount > 0
)

const getFullyRefundedState = (input: RefundAvailabilityInput) => (
    input.pricesHidden
        ? input.orderStatus.toUpperCase() === "REFUNDED"
            || (input.orderItemCount > 0 && input.remainingQuantity <= 0)
        : input.orderTotalCents !== null && input.totalApproved >= input.orderTotalCents
)

const getRefundAvailability = (input: RefundAvailabilityInput) => {
    const isOrderApproved = ["APPROVED", "FULFILLED", "REFUNDED"].includes(input.orderStatus.toUpperCase())
    const isOrderPortal = input.requesterRole === "ORDER_PORTAL"
    const meetsOrderPortalDeliveryRequirement = !isOrderPortal
        || isOrderPortalRefundEligible(input.orderStatus, input.orderFulfillmentStatus)
    const hasRefundCapacity = getHasRefundCapacity(input)
    return {
        quantityOnlyRefundAvailable: input.quantityOnlyRefundAvailable,
        hasRefundCapacity,
        isFullyRefunded: getFullyRefundedState(input),
        isOrderApproved,
        isOrderPortal,
        meetsOrderPortalDeliveryRequirement,
        canRefund: input.allowRefundRequest
            && isOrderApproved
            && meetsOrderPortalDeliveryRequirement
            && hasRefundCapacity
            && input.isWithinRefundWindow,
    }
}

export function RefundManagement({
    orderId,
    orderTotalCents,
    orderStatus,
    orderFulfillmentStatus,
    createdAt,
    requesterRole,
    allowRefundRequest = false,
    pricesHidden = false,
    initialOrderItems = [],
    refundAmountCents,
    refundedAt,
    refundReason,
    onRefundSuccess
}: Readonly<RefundManagementProps>) {
    const { toast } = useToast()
    const [reason, setReason] = useState("")
    const [reasonError, setReasonError] = useState("")
    const [processing, setProcessing] = useState(false)
    const [showForm, setShowForm] = useState(false)

    // Validate refund window (must be same month/year)
    // "it can only make request wihtnig that mo th"
    const isWithinRefundWindow = useMemo(() => {
        if (!createdAt) return false
        const orderDate = new Date(createdAt)
        const now = new Date()
        return orderDate.getMonth() === now.getMonth() && orderDate.getFullYear() === now.getFullYear()
    }, [createdAt])

    // Track selected items and their quantities: { itemId: quantity }
    const [selectedItems, setSelectedItems] = useState<Record<number, number>>({})

    const { data: refundsData, mutate: mutateRefunds } = useSWR(`/api/v1/orders/${orderId}/refunds`, fetcher)
    const { data: orderData } = useSWR(showForm ? `/api/v1/orders?id=${orderId}` : null, fetcher)

    // Extract items from order API response
    const orderItems = useMemo(() => {
        if (orderData?.items?.[0]?.orderItems) {
            return orderData.items[0].orderItems
        }
        return initialOrderItems
    }, [orderData, initialOrderItems])

    // Use API data if available, otherwise construct from order props if refunded
    const apiRefunds = refundsData?.refunds || []

    const effectiveRefunds = (() => {
      if (apiRefunds.length > 0) {
        return apiRefunds
      }
      if ((refundAmountCents && refundAmountCents > 0)) {
        return [{
            id: 'legacy',
            amountCents: refundAmountCents,
            reason: refundReason || "Refunded externally",
            status: 'APPROVED',
            createdAt: refundedAt || new Date().toISOString(),
            processedByUser: { fullName: 'Admin' }
        }]
      }
      return []
    })()

    const totalApproved = effectiveRefunds
        .filter((r: any) => r.status === 'APPROVED' || r.status === 'COMPLETED')
        .reduce((sum: number, r: any) => sum + (r.amountCents || 0), 0)

    const totalPending = effectiveRefunds
        .filter((r: any) => r.status === 'PENDING')
        .reduce((sum: number, r: any) => sum + (r.amountCents || 0), 0)

    const remainingRefundable = pricesHidden || orderTotalCents === null
        ? 0
        : Math.max(0, orderTotalCents - (totalApproved + totalPending))

    // Calculate previously refunded quantities per item
    const refundedQuantities = useMemo(() => {
        const quantities: Record<number, number> = {}
        effectiveRefunds.forEach((refund: any) => {
            if (refund.status === 'APPROVED' || refund.status === 'COMPLETED') {
                if (refund.items && Array.isArray(refund.items)) {
                    refund.items.forEach((item: any) => {
                        quantities[item.orderItemId] = (quantities[item.orderItemId] || 0) + item.quantity
                    })
                }
            }
        })
        orderItems.forEach((item: any) => {
            quantities[item.id] = Math.max(quantities[item.id] || 0, Number(item.quantityRefunded || 0))
        })
        return quantities
    }, [effectiveRefunds, orderItems])

    // Calculate currently pending/requested quantities per item
    const requestedQuantities = useMemo(() => {
        const quantities: Record<number, number> = {}
        effectiveRefunds.forEach((refund: any) => {
            if (refund.status === 'PENDING') {
                if (refund.items && Array.isArray(refund.items)) {
                    refund.items.forEach((item: any) => {
                        quantities[item.orderItemId] = (quantities[item.orderItemId] || 0) + item.quantity
                    })
                }
            }
        })
        return quantities
    }, [effectiveRefunds])

    const quantitySummary = useMemo(() => {
        return orderItems.reduce((summary: { ordered: number, refunded: number, requested: number, remaining: number }, item: any) => {
            const ordered = Number(item.quantity || 0)
            const refunded = Number(refundedQuantities[item.id] || 0)
            const requested = Number(requestedQuantities[item.id] || 0)
            return {
                ordered: summary.ordered + ordered,
                refunded: summary.refunded + refunded,
                requested: summary.requested + requested,
                remaining: summary.remaining + Math.max(0, ordered - refunded - requested),
            }
        }, { ordered: 0, refunded: 0, requested: 0, remaining: 0 })
    }, [orderItems, refundedQuantities, requestedQuantities])

    const {
        quantityOnlyRefundAvailable,
        hasRefundCapacity,
        isFullyRefunded,
        isOrderApproved,
        isOrderPortal,
        meetsOrderPortalDeliveryRequirement,
        canRefund,
    } = getRefundAvailability({
        pricesHidden,
        quantityOnlyRefundAvailable: refundsData?.quantityOnlyRefundAvailable !== false,
        remainingQuantity: quantitySummary.remaining,
        remainingAmount: remainingRefundable,
        orderStatus,
        orderItemCount: orderItems.length,
        totalApproved,
        orderTotalCents,
        requesterRole,
        orderFulfillmentStatus,
        allowRefundRequest,
        isWithinRefundWindow,
    })

    const handleItemToggle = (itemId: number, maxRefundableQty: number) => {
        setSelectedItems(prev => {
            const next = { ...prev }
            if (next[itemId]) {
                delete next[itemId]
            } else {
                next[itemId] = maxRefundableQty // Default to max available quantity
            }
            return next
        })
    }

    const handleQuantityChange = (itemId: number, qty: number, maxRefundableQty: number) => {
        const item = orderItems.find((orderItem: any) => orderItem.id === itemId)
        const step = sanitizeQuantityStep(Boolean(item?.allowDecimalQuantity), item?.quantityStep ?? 1)
        let nextQty = Number.isFinite(qty) ? qty : step
        if (nextQty < step) nextQty = step
        if (nextQty > maxRefundableQty) nextQty = maxRefundableQty
        nextQty = Math.round(nextQty / step) * step
        setSelectedItems(prev => ({ ...prev, [itemId]: roundQuantity(Math.min(nextQty, maxRefundableQty)) }))
    }

    // Detect legacy refunds (amount-based only)
    const legacyRefundAmount = useMemo(() => {
        let trackedAmount = 0
        effectiveRefunds.forEach((r: any) => {
            if (r.status === 'REJECTED') return
            if (r.items && Array.isArray(r.items)) {
                trackedAmount += r.items.reduce((sum: number, i: any) => sum + i.amountCents, 0)
            }
        })
        return Math.max(0, totalApproved + totalPending - trackedAmount)
    }, [effectiveRefunds, totalApproved, totalPending])

    // Calculate total amount for selected items
    const selectedRefundAmount = useMemo(() => {
        if (pricesHidden) return 0
        return orderItems.reduce((total: number, item: any) => {
            const qty = selectedItems[item.id] || 0
            return total + calculateLineCents(Number(item.priceCents || 0), qty)
        }, 0)
    }, [orderItems, pricesHidden, selectedItems])

    const selectedRefundQuantity = useMemo(
        () => Object.values(selectedItems).reduce((sum, quantity) => sum + Number(quantity || 0), 0),
        [selectedItems]
    )

    const handleSubmit = async (e: React.SubmitEvent<HTMLFormElement>) => {
        e.preventDefault()

        if (!allowRefundRequest) return

        if (Object.keys(selectedItems).length === 0) {
            toast({ title: "No items selected", description: "Please select at least one item to refund", variant: "destructive" })
            return
        }

        const trimmedReason = reason.trim()
        if (!trimmedReason) {
            setReasonError("Refund reason is required")
            toast({
                title: "Refund reason required",
                description: "Please provide a reason before submitting the refund request.",
                variant: "destructive"
            })
            return
        }
        setReasonError("")

        if (!pricesHidden && selectedRefundAmount > remainingRefundable) {
            toast({
                title: "Amount exceeds limit",
                description: `Total refund amount (PKR ${(selectedRefundAmount / 100).toFixed(2)}) exceeds remaining refundable amount (PKR ${(remainingRefundable / 100).toFixed(2)})`,
                variant: "destructive"
            })
            return
        }

        setProcessing(true)
        try {
            const itemsPayload = Object.entries(selectedItems).map(([id, qty]) => ({
                id: Number(id),
                quantity: qty
            }))

            const res = await fetch(`/api/v1/orders/${orderId}/refunds`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    items: itemsPayload,
                    reason: trimmedReason
                })
            })

            const json = await res.json()
            if (!res.ok) throw new Error(json.error || "Failed to process refund")

            toast({
                title: pricesHidden ? "Refund Request Submitted" : "Refund Processed",
                description: json.message
            })

            setSelectedItems({})
            setReason("")
            setReasonError("")
            setShowForm(false)
            mutateRefunds()
            onRefundSuccess?.()

        } catch (err: any) {
            toast({
                title: "Refund Failed",
                description: err.message,
                variant: "destructive"
            })
        } finally {
            setProcessing(false)
        }
    }

    return (
        <div className="min-w-0 space-y-4 pt-4 border-t">
            {/* Refund Metrics Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div className="bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-900/50 rounded-xl p-4 text-center">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-yellow-600 mb-1">{pricesHidden ? "Requested Qty" : "Requested"}</p>
                    <p className="text-xl font-bold text-yellow-700 dark:text-yellow-400">
                        {pricesHidden ? formatQuantity(quantitySummary.requested) : `PKR ${(totalPending / 100).toFixed(2)}`}
                    </p>
                </div>
                <div className="bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900/50 rounded-xl p-4 text-center">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-green-600 mb-1">{pricesHidden ? "Refunded Qty" : "Refunded"}</p>
                    <p className="text-xl font-bold text-green-700 dark:text-green-400">
                        {pricesHidden ? formatQuantity(quantitySummary.refunded) : `PKR ${(totalApproved / 100).toFixed(2)}`}
                    </p>
                </div>
                <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 rounded-xl p-4 text-center">
                    <p className="text-[10px] uppercase tracking-wider font-semibold text-blue-600 mb-1">{pricesHidden ? "Remaining Qty" : "Remaining"}</p>
                    <p className="text-xl font-bold text-blue-700 dark:text-blue-400">
                        {pricesHidden ? formatQuantity(quantitySummary.remaining) : `PKR ${(remainingRefundable / 100).toFixed(2)}`}
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-semibold text-lg">Refund History</h3>
                <div className="flex flex-wrap items-center gap-4">
                    {isFullyRefunded && (
                        <Badge variant="outline" className="border-green-600 text-green-600 bg-green-50">Fully Refunded</Badge>
                    )}
                    {canRefund && !showForm && (
                        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
                            Request Refund
                        </Button>
                    )}
                    {allowRefundRequest && isOrderPortal && !meetsOrderPortalDeliveryRequirement && hasRefundCapacity && !showForm && (
                        <div className="text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-md border border-slate-200 flex items-center gap-2">
                            <Clock className="h-3 w-3" />
                            Refund available after fulfillment and delivery
                        </div>
                    )}
                    {allowRefundRequest && !isOrderPortal && !isOrderApproved && hasRefundCapacity && !showForm && (
                        <div className="text-xs text-slate-600 bg-slate-50 px-3 py-2 rounded-md border border-slate-200 flex items-center gap-2">
                            <Clock className="h-3 w-3" />
                            Refund available after approval
                        </div>
                    )}
                    {allowRefundRequest && isOrderApproved && meetsOrderPortalDeliveryRequirement && !isWithinRefundWindow && hasRefundCapacity && !showForm && (
                        <div className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-md border border-amber-200 flex items-center gap-2">
                            <Clock className="h-3 w-3" />
                            Refund period ended
                        </div>
                    )}
                </div>
            </div>

            {/* Refund window explanation */}
            {allowRefundRequest && isOrderApproved && meetsOrderPortalDeliveryRequirement && !isWithinRefundWindow && hasRefundCapacity && !showForm && (
                <p className="text-xs text-muted-foreground text-right mt-1">
                    Requests are limited to the calendar month of the order.
                </p>
            )}

            {allowRefundRequest && pricesHidden && !quantityOnlyRefundAvailable && !showForm && (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    This order has a legacy refund. A Super Admin must review it before another refund can be requested.
                </p>
            )}

            {
                allowRefundRequest && showForm && (
                    <Card className="p-4 border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20">
                        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400 mb-2">
                                <AlertTriangle className="h-4 w-4" />
                                <span className="text-sm font-medium">Select Items to Refund</span>
                            </div>


                            {!pricesHidden && legacyRefundAmount > 0 && (
                                <div className="bg-yellow-100 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 p-3 rounded text-sm mb-4">
                                    <p className="font-semibold text-yellow-800 dark:text-yellow-200 flex items-center gap-2">
                                        <AlertTriangle className="h-4 w-4" />
                                        Legacy Refunds Detected
                                    </p>
                                    <p className="text-yellow-700 dark:text-yellow-300 mt-1">
                                        This order has PKR {(legacyRefundAmount / 100).toFixed(2)} refunded previously without item tracking.
                                        You can only refund items up to the remaining balance of PKR {(remainingRefundable / 100).toFixed(2)}.
                                    </p>
                                </div>
                            )}

                            {/* Items Table */}
                            <div className="min-w-0 bg-white dark:bg-slate-900 rounded-md border">
                                <Table className="table-fixed">
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-10"></TableHead>
                                            <TableHead className={pricesHidden ? "w-[50%] whitespace-normal" : "w-[38%] whitespace-normal"}>Product</TableHead>
                                            {!pricesHidden && <TableHead className="w-[14%] text-right">Price</TableHead>}
                                            <TableHead className="w-[14%] text-right whitespace-normal">Remaining</TableHead>
                                            <TableHead className="text-center whitespace-normal w-[100px]">Qty to Refund</TableHead>
                                            {!pricesHidden && <TableHead className="w-[14%] text-right">Total</TableHead>}
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {(() => {
                                          if (orderItems.length > 0) {
                                            return (
                                            orderItems.map((item: any) => {
                                                const refundedQty = refundedQuantities[item.id] || 0
                                                const requestedQty = requestedQuantities[item.id] || 0
                                                const remainingQty = Math.max(0, item.quantity - (refundedQty + requestedQty))
                                                const isSelected = !!selectedItems[item.id]
                                                const isFullyRefundedItem = remainingQty === 0

                                                // Calculate if selecting this item (min qty 1) would exceed remaining balance
                                                const costOfOne = Number(item.priceCents || 0)
                                                const currentSelectedQty = selectedItems[item.id] || 0
                                                const otherItemsTotal = selectedRefundAmount - (costOfOne * currentSelectedQty)
                                                const availableForThisItem = remainingRefundable - otherItemsTotal
                                                const step = sanitizeQuantityStep(Boolean(item.allowDecimalQuantity), item.quantityStep ?? 1)
                                                const maxAffordableQty = pricesHidden || costOfOne <= 0
                                                    ? remainingQty
                                                    : Math.floor((availableForThisItem / costOfOne) / step) * step

                                                const effectiveMaxQty = Math.min(remainingQty, maxAffordableQty)

                                                const wouldExceedBalance = !pricesHidden && !isSelected && (selectedRefundAmount + costOfOne > remainingRefundable)
                                                const isDisable = isFullyRefundedItem || wouldExceedBalance

                                                return (
                                                    <TableRow key={item.id} className={isFullyRefundedItem ? "opacity-50 bg-slate-50" : ""}>
                                                        <TableCell>
                                                            <Checkbox
                                                                checked={isSelected}
                                                                onCheckedChange={() => handleItemToggle(item.id, remainingQty)}
                                                                disabled={isDisable}
                                                            />
                                                        </TableCell>
                                                        <TableCell className="whitespace-normal break-words">
                                                            <div className="flex flex-col">
                                                                <span className="break-words font-medium">{item.productName}</span>
                                                                <span className="text-xs text-muted-foreground flex flex-wrap gap-x-2 gap-y-1">
                                                                    <span>{item.unit}</span>
                                                                    <span>• Ordered: {item.quantity}</span>
                                                                    {refundedQty > 0 && <span className="text-green-600 font-medium">• Refunded: {refundedQty}</span>}
                                                                    {requestedQty > 0 && <span className="text-amber-600 font-medium">• Requested: {requestedQty}</span>}
                                                                </span>
                                                            </div>
                                                        </TableCell>
                                                        {!pricesHidden && <TableCell className="text-right">
                                                            {(item.priceCents / 100).toFixed(2)}
                                                        </TableCell>}
                                                        <TableCell className="text-right font-semibold">
                                                            {formatQuantity(remainingQty)}
                                                        </TableCell>
                                                        <TableCell>
                                                            {(() => {
                                                              if (isSelected) {
                                                                return (
                                                                <Input
                                                                    type="number"
                                                                    min={step}
                                                                    step={step}
                                                                    max={effectiveMaxQty}
                                                                    value={selectedItems[item.id]}
                                                                    onChange={(e) => handleQuantityChange(item.id, parseQuantity(e.target.value), effectiveMaxQty)}
                                                                    className="h-8 w-20 text-center mx-auto"
                                                                />
                                                            )
                                                              }
                                                              return (
                                                                <div className="text-center text-muted-foreground">
                                                                    {isFullyRefundedItem ? (
                                                                        <Badge variant="secondary" className="text-[10px]">Refunded</Badge>
                                                                    ) : "-"}
                                                                </div>
                                                            )
                                                            })()}
                                                        </TableCell>
                                                        {!pricesHidden && <TableCell className="text-right font-medium text-red-600">
                                                            {isSelected
                                                                ? (calculateLineCents(item.priceCents, selectedItems[item.id]) / 100).toFixed(2)
                                                                : "0.00"
                                                            }
                                                        </TableCell>}
                                                    </TableRow>
                                                )
                                            })
                                        )
                                          }
                                          return (
                                            <TableRow>
                                                <TableCell colSpan={pricesHidden ? 4 : 6} className="text-center h-24 text-muted-foreground">
                                                    Loading items...
                                                </TableCell>
                                            </TableRow>
                                        )
                                        })()}
                                    </TableBody>
                                </Table>
                            </div>

                            <div className="flex justify-between items-center bg-slate-100 dark:bg-slate-800 p-3 rounded-lg">
                                <span className="font-medium">{pricesHidden ? "Total Quantity Selected:" : "Total Refund Amount:"}</span>
                                <span className="text-lg font-bold">
                                    {pricesHidden ? formatQuantity(selectedRefundQuantity) : `PKR ${(selectedRefundAmount / 100).toFixed(2)}`}
                                </span>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="refund-reason">
                                    Reason <span className="text-destructive" aria-hidden="true">*</span>
                                </Label>
                                <Textarea
                                    id="refund-reason"
                                    placeholder="Why is this refund being requested?"
                                    value={reason}
                                    onChange={e => {
                                        const nextReason = e.target.value
                                        setReason(nextReason)
                                        if (nextReason.trim()) setReasonError("")
                                    }}
                                    onBlur={() => {
                                        if (!reason.trim()) setReasonError("Refund reason is required")
                                    }}
                                    rows={2}
                                    maxLength={255}
                                    required
                                    aria-invalid={Boolean(reasonError)}
                                    aria-describedby={reasonError ? "refund-reason-error refund-reason-count" : "refund-reason-count"}
                                />
                                {reasonError && (
                                    <p id="refund-reason-error" className="text-xs text-destructive" role="alert">
                                        {reasonError}
                                    </p>
                                )}
                                <div id="refund-reason-count" className="text-xs text-muted-foreground text-right">
                                    {reason.length}/255
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setReason("")
                                        setReasonError("")
                                        setShowForm(false)
                                    }}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    type="submit"
                                    size="sm"
                                    disabled={processing || (pricesHidden ? selectedRefundQuantity <= 0 : selectedRefundAmount <= 0)}
                                >
                                    {processing ? "Processing..." : "Submit Refund"}
                                </Button>
                            </div>
                        </form>
                    </Card>
                )
            }

            {/* Refunds History */}
            <div className="space-y-2">
                {(() => {
                  if (effectiveRefunds.length === 0) {
                    return (
                    <p className="text-sm text-muted-foreground italic">No refunds recorded for this order.</p>
                )
                  }
                  return (
                    effectiveRefunds.map((refund: any) => (
                        <div key={refund.id} className="flex flex-col p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border gap-3">
                            <div className="flex items-center justify-between w-full">
                                <div className="flex items-center gap-3">
                                    <div className={`p-2 rounded-full ${(() => {
                                      if (refund.status === 'APPROVED') {
                                        return 'bg-green-100 text-green-600 dark:bg-green-900/30'
                                      }
                                      if (refund.status === 'REJECTED') {
                                        return 'bg-red-100 text-red-600 dark:bg-red-900/30'
                                      }
                                      return 'bg-yellow-100 text-yellow-600 dark:bg-yellow-900/30'
                                    })()
                                        }`}>
                                        {(() => {
                                          if (refund.status === 'APPROVED') {
                                            return <CheckCircle className="h-4 w-4" />
                                          }
                                          if (refund.status === 'REJECTED') {
                                            return <AlertTriangle className="h-4 w-4" />
                                          }
                                          return <Clock className="h-4 w-4" />
                                        })()}
                                    </div>
                                    <div>
                                        <p className="font-medium text-sm">
                                            <span className="font-mono text-xs text-primary font-semibold mr-2">
                                                {refund.refundNumber || (refund.id !== 'legacy' ? `Refund-${String(refund.id).padStart(6, '0')}` : '')}
                                            </span>
                                            {!pricesHidden && `PKR ${(refund.amountCents / 100).toFixed(2)}`}
                                            <span className="text-muted-foreground font-normal ml-2">
                                                via {refund.processedByUser?.fullName || 'System'}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {new Date(refund.createdAt).toLocaleDateString()}
                                            {refund.reason && ` • ${refund.reason}`}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Badge variant="outline" className={
                                        (() => {
                                          if (refund.status === 'APPROVED') {
                                            return 'text-green-600 border-green-200'
                                          }
                                          if (refund.status === 'REJECTED') {
                                            return 'text-red-600 border-red-200'
                                          }
                                          if (refund.status === 'SUPERSEDED') {
                                            return 'text-slate-500 border-slate-200'
                                          }
                                          return 'text-yellow-600 border-yellow-200'
                                        })()
                                    }>
                                        {refund.status}
                                    </Badge>
                                    {refund.refundType && (
                                        <Badge variant="secondary" className="text-xs">
                                            {refund.refundType === 'FULL' ? 'Full Refund' : 'Partial Refund'}
                                        </Badge>
                                    )}
                                </div>
                            </div>

                            {/* Detailed items list for this refund */}
                            {
                                refund.items && refund.items.length > 0 && (
                                    <div className="pl-12 text-sm">
                                        <p className="text-xs font-medium text-muted-foreground mb-1">Refunded Items:</p>
                                        <ul className="space-y-1">
                                            {refund.items.map((item: any) => (
                                                 <li key={item.orderItemId} className="flex justify-between text-xs bg-white dark:bg-slate-900 p-2 rounded border">
                                                     <span>{formatQuantity(item.quantity)}x {item.productName} ({item.unit})</span>
                                                     {!pricesHidden && <span className="font-medium">PKR {(item.amountCents / 100).toFixed(2)}</span>}
                                                 </li>
                                            ))}
                                        </ul>
                                    </div>
                                )
                            }
                        </div>
                    ))
                )
                })()}
            </div>
        </div>
    )
}

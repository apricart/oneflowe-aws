"use client"

import { useState, useMemo, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Search, RefreshCcw, Loader2, AlertTriangle, Building2, Calendar, User, DollarSign, Clock, XCircle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { calculateLineCents, formatQuantity, parseQuantity, roundQuantity, sanitizeQuantityStep } from "@/lib/quantity"

type OrderItem = {
    id: number
    productName: string
    productCode: string
    quantity: number
    priceCents: number
    unit: string
    refundedQuantity?: number // Added by API
    requestedQuantity?: number // Added by API
    remainingQuantity?: number // Added by API
    allowDecimalQuantity?: boolean
    quantityStep?: number
}

type OrderData = {
    id: number
    tid: string
    organizationId: number
    organizationName: string
    branchId: number
    branchName: string
    status: string
    subtotalCents: number
    taxCents: number
    totalCents: number
    createdAt: string
    statusAtRefund: string | null
    refundedAt: string | null
    refundAmountCents: number | null
    createdByUserName: string
    items: OrderItem[]
    refundedQuantities?: Record<number, number> // Refunded quantities per order item ID
}

type PendingRefundRequest = {
    id: number
    refundNumber: string | null
    amountCents: number
    reason: string | null
    status: string
    createdAt: string
    orderId: number
    tid: string
    totalCents: number
    organizationName: string | null
    branchName: string | null
    requestedByName: string | null
}

import { useSearchParams } from "next/navigation"

export default function RefundsPage() {
    const { toast } = useToast()
    const searchParams = useSearchParams()
    const [searchQuery, setSearchQuery] = useState(searchParams.get("tid") || "")
    const [searching, setSearching] = useState(false)
    const [order, setOrder] = useState<OrderData | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [selectedItems, setSelectedItems] = useState<Map<number, number>>(new Map())
    const [refundDialogOpen, setRefundDialogOpen] = useState(false)
    const [refundReason, setRefundReason] = useState("")
    const [processing, setProcessing] = useState(false)

    const [pendingRefunds, setPendingRefunds] = useState<PendingRefundRequest[]>([])
    const [pendingRefundsLoading, setPendingRefundsLoading] = useState(false)
    const [pendingRefundsVersion, setPendingRefundsVersion] = useState(0)
    const [reviewingRefund, setReviewingRefund] = useState<PendingRefundRequest | null>(null)
    const [cancelTarget, setCancelTarget] = useState<PendingRefundRequest | null>(null)
    const [cancelling, setCancelling] = useState(false)

    // Separate search function to be called from effect or button
    const performSearch = async (tid: string, refundRequest: PendingRefundRequest | null = null) => {
        if (!tid.trim()) return

        setSearching(true)
        setError(null)
        setOrder(null)
        setSelectedItems(new Map())
        setReviewingRefund(refundRequest)

        try {
            const requestQuery = refundRequest ? `&refundRequestId=${refundRequest.id}` : ""
            const response = await fetch(`/api/v1/admin/refunds?q=${encodeURIComponent(tid.trim())}${requestQuery}`)
            const data = await response.json()

            if (!response.ok) {
                setError(data.error || "Order not found")
                return
            }

            const order = data.order
            setOrder(order)

            // Auto-select pending items
            const newSelectedItems = new Map<number, number>()
            order.items.forEach((item: any) => {
                const requested = item.requestedQuantity || 0
                if (requested > 0) {
                    const remaining = item.remainingQuantity ?? Math.max(0, item.quantity - (item.refundedQuantity || 0))
                    const refundable = Math.min(requested, remaining)
                    if (refundable > 0) {
                        newSelectedItems.set(item.id, refundable)
                    }
                }
            })
            if (newSelectedItems.size > 0) {
                setSelectedItems(newSelectedItems)
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to search order"
            setError(message)
        } finally {
            setSearching(false)
        }
    }

    // Fetch pending refund requests — re-runs when pendingRefundsVersion increments
    useEffect(() => {
        const fetchPendingRefunds = async () => {
            setPendingRefundsLoading(true)
            try {
                const response = await fetch('/api/v1/admin/refunds?status=pending')
                if (response.ok) {
                    const data = await response.json()
                    setPendingRefunds(data.refunds || [])
                }
            } catch (error) {
                console.error("Failed to fetch pending refunds", error)
            } finally {
                setPendingRefundsLoading(false)
            }
        }

        fetchPendingRefunds()
    }, [pendingRefundsVersion])

    // Auto-search on mount if tid param exists
    useEffect(() => {
        const tid = searchParams.get("tid")
        if (tid) {
            performSearch(tid)
        }
    }, [searchParams])

    const searchOrder = () => performSearch(searchQuery)

    const handleItemToggle = (itemId: number, maxQty: number) => {
        setSelectedItems(prev => {
            const newMap = new Map(prev)
            if (newMap.has(itemId)) {
                newMap.delete(itemId)
            } else {
                newMap.set(itemId, maxQty)
            }
            return newMap
        })
    }

    const handleQuantityChange = (itemId: number, value: string, maxQty: number) => {
        const item = order?.items.find((orderItem) => orderItem.id === itemId)
        const step = sanitizeQuantityStep(Boolean(item?.allowDecimalQuantity), item?.quantityStep ?? 1)
        const qty = parseQuantity(value)
        if (Number.isNaN(qty) || qty < 0) return

        const finalQty = Math.min(roundQuantity(Math.round(qty / step) * step), maxQty)
        setSelectedItems(prev => {
            const newMap = new Map(prev)
            if (finalQty === 0) {
                newMap.delete(itemId)
            } else {
                newMap.set(itemId, finalQty)
            }
            return newMap
        })
    }

    const handleSelectAll = () => {
        if (!order) return

        const refundableItems = order.items.filter(item => {
            const alreadyRefunded = item.refundedQuantity || 0
            return item.quantity > alreadyRefunded
        })

        if (selectedItems.size === refundableItems.length) {
            setSelectedItems(new Map())
        } else {
            const newMap = new Map<number, number>()
            refundableItems.forEach(item => {
                const remainingQty = item.remainingQuantity ?? (item.quantity - (item.refundedQuantity || 0))
                newMap.set(item.id, remainingQty)
            })
            setSelectedItems(newMap)
        }
    }

    const refundAmountCents = useMemo(() => {
        if (!order) return 0
        let total = 0
        selectedItems.forEach((qty, itemId) => {
            const item = order.items.find(i => i.id === itemId)
            if (item) {
                total += calculateLineCents(item.priceCents, qty)
            }
        })
        return total
    }, [selectedItems, order])

    const pendingStats = useMemo(() => {
        const totalAmountCents = pendingRefunds.reduce((sum, r) => sum + (r.amountCents || 0), 0)
        const uniqueBranches = new Set(pendingRefunds.map(r => r.branchName).filter(Boolean)).size
        // API returns desc(createdAt), so last item is the oldest
        const oldestDate = pendingRefunds.at(-1)?.createdAt ?? null
        const daysOld = oldestDate ? Math.floor((Date.now() - new Date(oldestDate).getTime()) / 86400000) : null
        return { totalCount: pendingRefunds.length, totalAmountCents, uniqueBranches, daysOld }
    }, [pendingRefunds])

    const openRefundDialog = () => {
        if (selectedItems.size === 0) {
            toast({
                title: "⚠️ No Items Selected",
                description: "Please select at least one item to refund",
                variant: "destructive",
                duration: 3000
            })
            return
        }
        setRefundReason(reviewingRefund?.reason || "")
        setRefundDialogOpen(true)
    }

    const processRefund = async () => {
        if (!order || selectedItems.size === 0) return

        const refundItems = Array.from(selectedItems.entries()).map(([itemId, quantity]) => ({
            itemId,
            quantity
        }))

        setProcessing(true)
        try {
            const response = await fetch(`/api/v1/admin/refunds`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    orderId: order.id,
                    items: refundItems,
                    reason: refundReason.trim() || undefined,
                    refundRequestId: reviewingRefund?.id,
                })
            })

            const data = await response.json()

            if (!response.ok) {
                // Show detailed error message from backend
                toast({
                    title: "Refund Failed",
                    description: data.error || "Failed to process refund. Please try again.",
                    variant: "destructive",
                    duration: 5000
                })
                return
            }

            toast({
                title: "✅ Refund Processed Successfully",
                description: `Refunded PKR ${(refundAmountCents / 100).toFixed(2)} for ${selectedItems.size} item(s)`,
                duration: 4000
            })

            setRefundDialogOpen(false)
            setSelectedItems(new Map())
            searchOrder()
            setPendingRefundsVersion(v => v + 1)
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to process refund"
            toast({
                title: "❌ Error",
                description: message,
                variant: "destructive",
                duration: 5000
            })
        } finally {
            setProcessing(false)
        }
    }

    const cancelRefund = async () => {
        if (!cancelTarget) return
        setCancelling(true)
        try {
            const response = await fetch(`/api/v1/admin/refunds/${cancelTarget.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "cancel" }),
            })
            const data = await response.json()
            if (!response.ok) {
                toast({
                    title: "Cancellation Failed",
                    description: data.error || "Failed to cancel refund request.",
                    variant: "destructive",
                    duration: 5000,
                })
                return
            }
            toast({
                title: "Refund Request Cancelled",
                description: `The refund request for ${cancelTarget.tid} has been cancelled.`,
                duration: 4000,
            })
            setCancelTarget(null)
            setPendingRefundsVersion(v => v + 1)
            // If the cancelled order is currently shown in search, refresh it
            if (order?.tid === cancelTarget.tid) {
                searchOrder()
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "Failed to cancel refund request"
            toast({ title: "Error", description: message, variant: "destructive", duration: 5000 })
        } finally {
            setCancelling(false)
        }
    }

    const getStatusBadge = (status: string, statusAtRefund?: string | null) => {
        const statusUpper = status.toUpperCase()

        if (statusUpper === "REFUNDED" && statusAtRefund) {
            return (
                <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-slate-600">{statusAtRefund}</Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="destructive">Refunded</Badge>
                </div>
            )
        }

        switch (statusUpper) {
            case "PENDING": return <Badge variant="secondary">Pending</Badge>
            case "APPROVED": return <Badge className="bg-blue-500">Active</Badge>
            case "FULFILLED": return <Badge className="bg-green-500">Fulfilled</Badge>
            case "REJECTED": return <Badge variant="destructive">Rejected</Badge>
            case "REFUNDED": return <Badge variant="destructive">Refunded</Badge>
            default: return <Badge variant="outline">{status}</Badge>
        }
    }

    const canRefund = order && !["PENDING", "REJECTED", "REFUNDED"].includes(order.status.toUpperCase())

    return (
        <div className="space-y-6 p-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight">Refund Management</h1>
                <p className="text-muted-foreground">Review pending refund requests and process refunds by Transaction ID</p>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-muted-foreground">Pending Requests</p>
                                <p className="text-3xl font-bold mt-1">
                                    {pendingRefundsLoading
                                        ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                        : pendingStats.totalCount
                                    }
                                </p>
                            </div>
                            <div className="h-12 w-12 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                                <Clock className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-muted-foreground">Total Requested</p>
                                <p className="text-xl font-bold mt-1 text-red-600">
                                    {pendingRefundsLoading
                                        ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                        : `PKR ${(pendingStats.totalAmountCents / 100).toFixed(2)}`
                                    }
                                </p>
                            </div>
                            <div className="h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                                <DollarSign className="h-6 w-6 text-red-600 dark:text-red-400" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-muted-foreground">Branches Affected</p>
                                <p className="text-3xl font-bold mt-1">
                                    {pendingRefundsLoading
                                        ? <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                        : pendingStats.uniqueBranches
                                    }
                                </p>
                            </div>
                            <div className="h-12 w-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                                <Building2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardContent className="pt-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm text-muted-foreground">Oldest Request</p>
                                <p className="text-3xl font-bold mt-1">
                                    {(() => {
                                      if (pendingRefundsLoading) {
                                        return <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                                      }
                                      if (pendingStats.daysOld === null) {
                                        return "—"
                                      }
                                      if (pendingStats.daysOld === 0) {
                                        return "Today"
                                      }
                                      return `${pendingStats.daysOld}d ago`
                                    })()
                                    }
                                </p>
                            </div>
                            <div className="h-12 w-12 rounded-full bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                                <Calendar className="h-6 w-6 text-orange-600 dark:text-orange-400" />
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Pending Refund Requests Table */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <CardTitle className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                            Pending Refund Requests
                        </CardTitle>
                        <p className="text-sm text-muted-foreground mt-1">
                            Refund requests submitted by branches awaiting admin review
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPendingRefundsVersion(v => v + 1)}
                        disabled={pendingRefundsLoading}
                    >
                        <RefreshCcw className={`h-4 w-4 mr-2 ${pendingRefundsLoading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </CardHeader>
                <CardContent>
                    {(() => {
                      if (pendingRefundsLoading) {
                        return (
                        <div className="flex items-center justify-center py-10">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                    )
                      }
                      if (pendingRefunds.length === 0) {
                        return (
                        <div className="text-center py-10 text-muted-foreground">
                            <Clock className="h-10 w-10 mx-auto mb-3 opacity-30" />
                            <p className="font-medium">No pending refund requests</p>
                            <p className="text-sm mt-1">All caught up!</p>
                        </div>
                    )
                      }
                      return (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Refund ID</TableHead>
                                    <TableHead>Transaction ID</TableHead>
                                    <TableHead>Organization</TableHead>
                                    <TableHead>Branch</TableHead>
                                    <TableHead>Requested By</TableHead>
                                    <TableHead className="text-right">Amount</TableHead>
                                    <TableHead>Date Requested</TableHead>
                                    <TableHead>Reason</TableHead>
                                    <TableHead className="w-44 text-center">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {pendingRefunds.map((refund) => (
                                    <TableRow key={refund.id} className="hover:bg-muted/50">
                                        <TableCell>
                                            <span className="font-mono text-xs font-semibold text-primary">
                                                {refund.refundNumber || `Refund-${String(refund.id).padStart(6, '0')}`}
                                            </span>
                                        </TableCell>
                                        <TableCell>
                                            <span className="font-mono text-sm font-semibold">{refund.tid}</span>
                                        </TableCell>
                                        <TableCell className="text-sm">{refund.organizationName || "—"}</TableCell>
                                        <TableCell className="text-sm">{refund.branchName || "—"}</TableCell>
                                        <TableCell className="text-sm">{refund.requestedByName || "—"}</TableCell>
                                        <TableCell className="text-right font-semibold text-red-600">
                                            PKR {(refund.amountCents / 100).toFixed(2)}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                            {new Date(refund.createdAt).toLocaleDateString("en-PK", {
                                                day: "2-digit",
                                                month: "short",
                                                year: "numeric",
                                            })}
                                        </TableCell>
                                        <TableCell className="text-sm text-muted-foreground max-w-[180px]">
                                            <span className="truncate block" title={refund.reason ?? undefined}>
                                                {refund.reason || "—"}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-center">
                                            <div className="flex items-center justify-center gap-2">
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => {
                                                        setSearchQuery(refund.tid)
                                                        performSearch(refund.tid, refund)
                                                    }}
                                                >
                                                    Review
                                                </Button>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    className="text-rose-600 border-rose-200 hover:bg-rose-50 dark:text-rose-400 dark:border-rose-800 dark:hover:bg-rose-950/20"
                                                    onClick={() => setCancelTarget(refund)}
                                                >
                                                    <XCircle className="h-3.5 w-3.5 mr-1" />
                                                    Cancel
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )
                    })()}
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Search className="h-5 w-5" />
                        Search Order
                    </CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="flex gap-3">
                        <Input
                            placeholder="Enter Transaction ID (e.g., ORD-ABC123)"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && searchOrder()}
                            className="max-w-md"
                        />
                        <Button onClick={searchOrder}>
                            {searching ? "Searching..." : (
                                <>
                                    <Search className="h-4 w-4 mr-2" />
                                    Search
                                </>
                            )}
                        </Button>
                    </div>
                    {error && (
                        <div className="mt-4 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
                            <p className="text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
                                <AlertTriangle className="h-4 w-4" />
                                {error}
                            </p>
                        </div>
                    )}
                </CardContent>
            </Card>

            {order && (
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle className="text-xl">Order: {order.tid}</CardTitle>
                            <div className="mt-2">
                                {getStatusBadge(order.status, order.statusAtRefund)}
                                {reviewingRefund && (
                                    <Badge variant="outline" className="ml-2 font-mono text-xs text-primary">
                                        Reviewing {reviewingRefund.refundNumber || `Refund-${String(reviewingRefund.id).padStart(6, '0')}`}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        {canRefund && selectedItems.size > 0 && (
                            <div className="flex items-center gap-3">
                                <div className="text-right">
                                    <p className="text-sm text-muted-foreground">Refund Amount</p>
                                    <p className="text-2xl font-bold text-red-600">
                                        PKR {(refundAmountCents / 100).toFixed(2)}
                                    </p>
                                </div>
                                <Button onClick={openRefundDialog} variant="destructive" className="gap-2">
                                    <DollarSign className="h-4 w-4" />
                                    Process Refund
                                </Button>
                            </div>
                        )}
                    </CardHeader>
                    <CardContent className="space-y-6">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                    <Building2 className="h-3 w-3" /> Organization
                                </p>
                                <p className="font-medium">{order.organizationName}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                    <Building2 className="h-3 w-3" /> Branch
                                </p>
                                <p className="font-medium">{order.branchName}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                    <Calendar className="h-3 w-3" /> Created
                                </p>
                                <p className="font-medium">{new Date(order.createdAt).toLocaleString()}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground flex items-center gap-1">
                                    <User className="h-3 w-3" /> Created By
                                </p>
                                <p className="font-medium">{order.createdByUserName}</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg">
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground">Subtotal</p>
                                <p className="text-lg font-bold">PKR {(order.subtotalCents / 100).toFixed(2)}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground">Tax</p>
                                <p className="text-lg font-bold">PKR {(order.taxCents / 100).toFixed(2)}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground">Total</p>
                                <p className="text-lg font-bold text-green-600">PKR {(order.totalCents / 100).toFixed(2)}</p>
                            </div>
                            <div className="space-y-1">
                                <p className="text-sm text-muted-foreground">Already Refunded</p>
                                <p className="text-lg font-bold text-red-600">
                                    PKR {((order.refundAmountCents || 0) / 100).toFixed(2)}
                                </p>
                            </div>
                        </div>

                        {order.refundedAt && (
                            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                                <h4 className="font-medium text-amber-800 dark:text-amber-200 mb-2">Refund Information</h4>
                                <div className="text-sm text-amber-700 dark:text-amber-300 space-y-2">
                                    <p>Was <strong>{order.statusAtRefund}</strong> → Now <strong>REFUNDED</strong></p>
                                    <p>Refunded at: {new Date(order.refundedAt).toLocaleString()}</p>
                                    <div className="pt-2 border-t border-amber-200/50 dark:border-amber-800/50">
                                        <p className="font-semibold mb-1">Refunded Items:</p>
                                        <div className="space-y-1">
                                            {order.items
                                                .filter(i => (i.refundedQuantity || 0) > 0)
                                                .map(i => (
                                                    <div key={`info-${i.id}`} className="flex justify-between">
                                                        <span>{i.refundedQuantity}x {i.productName}</span>
                                                        <span>PKR {((i.refundedQuantity || 0) * i.priceCents / 100).toFixed(2)}</span>
                                                    </div>
                                                ))
                                            }
                                        </div>
                                    </div>
                                    <div className="pt-2 border-t border-amber-200/50 dark:border-amber-800/50 flex justify-between font-bold">
                                        <span>Total Refunded</span>
                                        <span>PKR {((order.refundAmountCents || 0) / 100).toFixed(2)}</span>
                                    </div>
                                </div>
                            </div>
                        )}

                        {canRefund && (
                            <div>
                                <div className="flex items-center justify-between mb-3">
                                    <h4 className="font-medium">Select Items to Refund</h4>
                                    <Button variant="outline" size="sm" onClick={handleSelectAll}>
                                        {selectedItems.size === order.items.length ? "Deselect All" : "Select All"}
                                    </Button>
                                </div>
                                <Table>
                                    <TableHeader>
                                        <TableRow>
                                            <TableHead className="w-12"></TableHead>
                                            <TableHead>Product</TableHead>
                                            <TableHead>Code</TableHead>
                                            <TableHead className="text-right">Unit Price</TableHead>
                                            <TableHead className="text-right">Ordered Qty</TableHead>
                                            <TableHead className="text-right">Remaining Qty</TableHead>
                                            <TableHead className="text-right">Refund Qty</TableHead>
                                            <TableHead className="text-right">Line Total</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {order.items.map((item) => {
                                            const refundedQty = item.refundedQuantity || 0
                                            const remainingQty = item.remainingQuantity ?? Math.max(0, item.quantity - refundedQty)
                                            const isFullyRefunded = remainingQty === 0

                                            const isSelected = selectedItems.has(item.id)
                                            const refundQty = selectedItems.get(item.id) || remainingQty
                                            const step = sanitizeQuantityStep(Boolean(item.allowDecimalQuantity), item.quantityStep ?? 1)
                                            const lineTotal = isSelected ? calculateLineCents(item.priceCents, refundQty) : 0

                                            return (
                                                <TableRow
                                                    key={item.id}
                                                    className={(() => {
                                                      if (isSelected) {
                                                        return "bg-red-50 dark:bg-red-950/20"
                                                      }
                                                      if (isFullyRefunded) {
                                                        return "opacity-50"
                                                      }
                                                      return ""
                                                    })()}
                                                >
                                                    <TableCell>
                                                        <Checkbox
                                                            checked={isSelected}
                                                            onCheckedChange={() => handleItemToggle(item.id, remainingQty)}
                                                            disabled={isFullyRefunded}
                                                        />
                                                    </TableCell>
                                                    <TableCell className="font-medium">
                                                        <div>
                                                            {item.productName}
                                                            {(item.requestedQuantity || 0) > 0 && (
                                                                <span className="text-xs text-blue-600 font-semibold block mt-1">
                                                                    ({formatQuantity(item.requestedQuantity)} requested for refund)
                                                                </span>
                                                            )}
                                                            {refundedQty > 0 && (
                                                                <span className="text-xs text-amber-600 block mt-1">
                                                                    ({formatQuantity(refundedQty)} already refunded)
                                                                </span>
                                                            )}
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge variant="outline">{item.productCode}</Badge>
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        PKR {(item.priceCents / 100).toFixed(2)}
                                                    </TableCell>
                                                    <TableCell className="text-right text-muted-foreground">
                                                        {formatQuantity(item.quantity)} {item.unit}
                                                    </TableCell>
                                                    <TableCell className="text-right font-semibold">
                                                        {formatQuantity(remainingQty)} {item.unit}
                                                    </TableCell>
                                                    <TableCell className="text-right">
                                                        {(() => {
                                                          if (isSelected) {
                                                            return (
                                                            <Input
                                                                type="number"
                                                                min={step}
                                                                step={step}
                                                                max={remainingQty}
                                                                value={refundQty}
                                                                onChange={(e) => handleQuantityChange(item.id, e.target.value, remainingQty)}
                                                                className="w-20 h-8 text-right"
                                                                onClick={(e) => e.stopPropagation()}
                                                            />
                                                        )
                                                          }
                                                          if (isFullyRefunded) {
                                                            return (
                                                            <Badge variant="secondary" className="text-xs">Fully Refunded</Badge>
                                                        )
                                                          }
                                                          return (
                                                            <span className="text-muted-foreground">-</span>
                                                        )
                                                        })()}
                                                    </TableCell>
                                                    <TableCell className="text-right font-medium">
                                                        {isSelected ? (
                                                            <span className="text-red-600">
                                                                PKR {(lineTotal / 100).toFixed(2)}
                                                            </span>
                                                        ) : (
                                                            <span className="text-muted-foreground">-</span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })}
                                    </TableBody>
                                </Table>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Cancel Refund Request Confirmation Dialog */}
            <Dialog open={!!cancelTarget} onOpenChange={(open) => !open && setCancelTarget(null)}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-rose-600">
                            <XCircle className="h-5 w-5" />
                            Cancel Refund Request
                        </DialogTitle>
                        <DialogDescription>
                            This will cancel the pending refund request. The order will remain in its current state and no budget changes will be made.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg space-y-2 text-sm">
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Transaction ID</span>
                                <span className="font-mono font-semibold">{cancelTarget?.tid}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Branch</span>
                                <span className="font-medium">{cancelTarget?.branchName || "—"}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Requested By</span>
                                <span className="font-medium">{cancelTarget?.requestedByName || "—"}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-muted-foreground">Amount</span>
                                <span className="font-semibold text-rose-600">
                                    PKR {cancelTarget ? (cancelTarget.amountCents / 100).toFixed(2) : "0.00"}
                                </span>
                            </div>
                        </div>
                        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                            <p className="text-sm text-amber-800 dark:text-amber-200">
                                The order status and branch budget will <strong>not</strong> be affected. Only the pending request will be removed.
                            </p>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setCancelTarget(null)} disabled={cancelling}>
                            Keep Request
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={cancelRefund}
                            disabled={cancelling}
                        >
                            {cancelling ? "Cancelling..." : "Cancel Request"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={refundDialogOpen} onOpenChange={setRefundDialogOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-red-600">
                            <AlertTriangle className="h-5 w-5" />
                            Confirm Refund
                        </DialogTitle>
                        <DialogDescription>
                            {reviewingRefund
                                ? `This will approve ${reviewingRefund.refundNumber || ("Refund-" + String(String(reviewingRefund.id).padStart(6, '0')))} and credit the branch budget.`
                                : "This will refund the selected items and credit the branch budget."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="p-3 bg-slate-100 dark:bg-slate-800 rounded-lg space-y-2">
                            <p className="text-sm text-muted-foreground">Order</p>
                            <p className="font-medium">{order?.tid}</p>
                            <p className="text-sm">
                                <strong>{selectedItems.size}</strong> item(s) selected
                            </p>
                            <p className="text-lg font-bold text-red-600">
                                Refund Amount: PKR {(refundAmountCents / 100).toFixed(2)}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor="refundReason">Reason (Optional)</Label>
                            <Textarea
                                id="refundReason"
                                value={refundReason}
                                onChange={(e) => setRefundReason(e.target.value)}
                                placeholder="Enter reason for refund..."
                                rows={3}
                                maxLength={255}
                            />
                            <div className="text-xs text-muted-foreground text-right">
                                {refundReason.length}/255
                            </div>
                        </div>

                        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                            <p className="text-sm text-amber-800 dark:text-amber-200">
                                <strong>This will:</strong>
                            </p>
                            <ul className="text-sm text-amber-700 dark:text-amber-300 list-disc ml-4 mt-1">
                                <li>Refund PKR {(refundAmountCents / 100).toFixed(2)}</li>
                                <li>Credit the branch budget</li>
                                <li>Update order status if full refund</li>
                                <li>Create audit log entry</li>
                            </ul>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRefundDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={processRefund}
                            disabled={processing}
                        >
                            {processing ? "Processing..." : "Confirm Refund"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}

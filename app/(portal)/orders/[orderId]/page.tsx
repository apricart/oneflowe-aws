"use client"

import { useParams,useRouter } from "next/navigation"
import useSWR from "swr"
import { useSession } from "next-auth/react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn,formatPKR } from "@/lib/utils"
import { calculateLineCents,formatQuantity } from "@/lib/quantity"
import { buildStatusTimeline } from "@/lib/order-utils"
import { getOrderDerivedStatus,hasPartialRefund } from "@/lib/order-status"
import { PAYMENT_STATUS_LABELS,normalizePaymentStatus } from "@/lib/payment-status"
import { ArrowLeft,Clock,TrendingDown,CheckCircle,RefreshCw,Package,Ban,Copy,User,XCircle } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { RefundManagement } from "@/components/refund-management"

// ... (existing imports)

// ...


import { formatDistanceToNow } from "date-fns"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

type OrderItem = {
  id: number
  productName: string
  productCode?: string | null
  quantity: number
  quantityRefunded?: number
  priceCents: number | null
  unit: string
  globalProductId: number
  imageUrl?: string | null
}

type OrderDetail = {
  id: number
  tid: string
  branchId: number
  branchName?: string | null
  creatorName?: string | null
  creatorEmail?: string | null
  creatorPhone?: string | null
  creatorEmployeeId?: string | null
  status: string
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  statusAtRefund?: string | null
  refundedAt?: string | null
  refundedByUserId?: string | null
  refundAmountCents?: number | null
  refundReason?: string | null
  subtotalCents: number | null
  taxCents: number | null
  totalCents: number | null
  createdAt: string
  orderItems?: OrderItem[]
  approvalToken?: string | null // Only visible to the approver
  rejectionReason?: string | null
  pricesHidden?: boolean
}

function numericOrderId(orderId: string | string[] | undefined): number | null {
  const rawId = Array.isArray(orderId) ? orderId[0] : orderId
  return rawId && /^\d+$/.test(rawId) ? Number(rawId) : null
}

function canRequestRefund(role: string | undefined): boolean {
  return ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"].includes(role ?? "")
}

export default function SuperAdminOrderDetailsPage() {
  const params = useParams<{ orderId: string }>()
  const router = useRouter()
  const { data: session } = useSession()
  const { toast } = useToast()
  const userRole = (session?.user as any)?.role
  const numericId = numericOrderId(params?.orderId)
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null)
  const [rejectionReason, setRejectionReason] = useState("")
  const [isDeciding, setIsDeciding] = useState(false)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)

  const isSuperAdmin = userRole === "SUPER_ADMIN"
  const isHeadOffice = userRole === "HEAD_OFFICE"
  const isBranchAdmin = userRole === "BRANCH_ADMIN"
  const canRequestRefundFromOrderReview = canRequestRefund(userRole)

  const { data, error, isLoading, mutate } = useSWR<{
    item: OrderDetail & { orderItems: OrderItem[] }
    capabilities: {
      canApproveOrders: boolean
      canRejectOrders: boolean
    }
  }>(
    numericId ? `/api/v1/orders/${numericId}` : null,
    fetcher
  )

  const order: OrderDetail | undefined = data?.item
  const orderItems = order?.orderItems || []
  const pricesHidden = Boolean(order?.pricesHidden)
  const canDecideOrders = Boolean(
    data?.capabilities?.canApproveOrders
    && data?.capabilities?.canRejectOrders,
  )
  const initiatorName = order?.creatorName?.trim() || order?.creatorEmail?.trim() || "Unknown user"
  const initiatorDetails = [
    order?.creatorEmployeeId ? `Employee #${order.creatorEmployeeId}` : null,
    order?.creatorPhone,
  ].filter(Boolean).join(" · ")

  // Hide items that have been fully refunded

  const submitDecision = async () => {
    if (!order || !decision) return
    if (decision === "reject" && !rejectionReason.trim()) return

    setIsDeciding(true)
    try {
      const response = await fetch(`/api/v1/orders/${order.id}/${decision}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: decision === "reject"
          ? JSON.stringify({ reason: rejectionReason.trim() })
          : undefined,
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `Unable to ${decision} order`)

      if (decision === "approve" && result.approvalToken) {
        setGeneratedToken(result.approvalToken)
      }
      toast({
        title: decision === "approve" ? "Order approved" : "Order rejected",
        description: `Order ${order.tid} was ${decision}d successfully.`,
      })
      setDecision(null)
      setRejectionReason("")
      await mutate()
    } catch (decisionError: any) {
      toast({
        title: "Order decision failed",
        description: decisionError?.message || "Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsDeciding(false)
    }
  }

  if (isLoading) return <div className="p-8 text-center text-slate-500 font-medium">Loading order details...</div>

  const roleLabel = (() => {
    if (isSuperAdmin) {
      return "SUPER ADMIN"
    }
    if (isHeadOffice) {
      return "HEAD OFFICE"
    }
    return "BRANCH ADMIN"
  })()

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-3xl bg-white dark:bg-slate-900 px-6 py-6 shadow-sm border border-slate-200 dark:border-slate-800">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs tracking-[0.2em] text-slate-500 dark:text-slate-400 font-bold mb-1">{roleLabel} · ORDERS</p>
            <h1 className="text-3xl font-semibold text-slate-900 dark:text-white">Order overview</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
              Watch approvals, fulfillment, and refund indicators for order #{rawId}.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700"
              onClick={() => mutate()}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh data
            </Button>
            {order && (
              <div className="flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
                {order.branchName || `Branch ${order.branchId}`}
              </div>
            )}
          </div>
        </div>
        {order && (
          <div className="mt-6 flex flex-wrap gap-4 text-xs font-medium text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800 pt-4">
            <div className="flex items-center gap-2">
              <span className="uppercase tracking-wide text-slate-400 dark:text-slate-500">Transaction</span>
              <span className="font-mono text-slate-700 dark:text-slate-300">{order.tid}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="uppercase tracking-wide text-slate-400 dark:text-slate-500">Created</span>
              <span className="text-slate-700 dark:text-slate-300">{formatDistanceToNow(new Date(order.createdAt), { addSuffix: true })}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="uppercase tracking-wide text-slate-400 dark:text-slate-500">Status</span>
              <span className="uppercase font-bold text-slate-900 dark:text-white">{getOrderDerivedStatus({ status: order.status }).label}</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" className="gap-2" onClick={() => router.push("/orders")}>
          <ArrowLeft className="h-4 w-4" />
          Back to orders
        </Button>
        {order?.status.toUpperCase() === "PENDING" && canDecideOrders && (
          <div className="flex gap-2">
            <Button variant="outline" className="text-rose-600" onClick={() => setDecision("reject")}>
              <XCircle className="mr-2 h-4 w-4" />
              Reject
            </Button>
            <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => setDecision("approve")}>
              <CheckCircle className="mr-2 h-4 w-4" />
              Approve
            </Button>
          </div>
        )}
      </div>

      {order && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {!pricesHidden && order.totalCents !== null && order.subtotalCents !== null && order.taxCents !== null && (
          <Card className="rounded-2xl border-0 bg-white dark:bg-slate-900 dark:border-slate-800 p-4 shadow-md">
            <p className="text-sm text-muted-foreground">Order total</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-white">
              {formatPKR(order.totalCents / 100)}
            </p>
            <p className="text-xs text-muted-foreground">
              Subtotal {formatPKR(order.subtotalCents / 100)} · Tax {formatPKR(order.taxCents / 100)}
            </p>
          </Card>
          )}
          <Card className="rounded-2xl border-0 bg-white dark:bg-slate-900 dark:border-slate-800 p-4 shadow-md">
            <p className="text-sm text-muted-foreground">Current status</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-white">
              {getOrderDerivedStatus({ status: order.status }).label}
            </p>
            <span className={cn(
              "mt-2 inline-flex items-center rounded-lg border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              normalizePaymentStatus(order.paymentStatus) === "PAID"
                ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
                : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
            )}>
              {PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]}
            </span>
            {order.status.toLowerCase() === 'rejected' && order.rejectionReason && (
              <div className="mt-3 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300 border border-red-100 dark:border-red-900">
                <span className="font-semibold block mb-0.5">Reason:</span>
                {order.rejectionReason}
              </div>
            )}
          </Card>
          <Card className="rounded-2xl border-0 bg-white dark:bg-slate-900 dark:border-slate-800 p-4 shadow-md">
            <p className="text-sm text-muted-foreground">Branch</p>
            <p className="text-2xl font-semibold text-slate-900 dark:text-white">
              {order.branchName || `Branch ${order.branchId}`}
            </p>
            <p className="text-xs text-muted-foreground">Order ID #{order.id}</p>
          </Card>
          <Card className="rounded-2xl border-0 bg-white dark:bg-slate-900 dark:border-slate-800 p-4 shadow-md">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              <span>Initiated by</span>
            </div>
            <p className="mt-1 truncate text-xl font-semibold text-slate-900 dark:text-white" title={initiatorName}>
              {initiatorName}
            </p>
            {initiatorDetails && (
              <p className="truncate text-xs text-muted-foreground" title={initiatorDetails}>
                {initiatorDetails}
              </p>
            )}
          </Card>
          {!pricesHidden && order.refundAmountCents && order.refundAmountCents > 0 && (
            <Card className="rounded-2xl border-0 bg-yellow-50 dark:bg-yellow-950/50 border-yellow-200 dark:border-yellow-800 p-4 shadow-md">
              <p className="text-sm text-yellow-700 dark:text-yellow-300">Refund amount</p>
              <p className="text-2xl font-semibold text-yellow-900 dark:text-yellow-200">
                {formatPKR(order.refundAmountCents / 100)}
              </p>
              <p className="text-xs text-yellow-600 dark:text-yellow-400">
                {order.status.toLowerCase() === "refunded" ? "Full refund" : "Partial refund"}
              </p>
            </Card>
          )}
        </div>
      )}

      {/* Refund Information Card */}
      {order?.refundAmountCents}

      {!numericId && (
        <Card className="p-6 text-sm text-muted-foreground">
          Invalid order id provided. Please navigate back and pick a valid order.
        </Card>
      )}

      {numericId && (
        <>
          {isLoading && (
            <Card className="p-6">
              <p className="text-sm text-muted-foreground">Loading order details…</p>
            </Card>
          )}
          {error && (
            <Card className="p-6">
              <p className="text-sm text-destructive">Failed to load order information.</p>
            </Card>
          )}
          {!isLoading && !order && !error && (
            <Card className="p-6 text-sm text-muted-foreground">
              Order not found or you lack access.
            </Card>
          )}

          {order && (
            <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
              <Card className="space-y-4 border dark:bg-slate-900 dark:border-slate-800">
                <div className="grid gap-4 border-b dark:border-slate-800 px-6 py-5 md:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Transaction ID
                    </p>
                    <p className="font-mono text-sm font-semibold dark:text-white">{order.tid}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Order ID
                    </p>
                    <p className="font-semibold dark:text-white">{order.id}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Branch
                    </p>
                    <p className="font-semibold dark:text-white">
                      {order.branchName || `Branch ${order.branchId}`}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Initiated by
                    </p>
                    <p className="truncate font-semibold dark:text-white" title={initiatorName}>
                      {initiatorName}
                    </p>
                  </div>
                </div>

                {!pricesHidden && order.subtotalCents !== null && order.taxCents !== null && order.totalCents !== null && (
                <div className="grid gap-3 px-6 pb-6 md:grid-cols-3">
                  <div className="rounded-2xl bg-white/80 dark:bg-slate-800/80 p-4 shadow-sm">
                    <p className="text-xs uppercase text-muted-foreground">Subtotal</p>
                    <p className="text-lg font-semibold dark:text-white">
                      {formatPKR(order.subtotalCents / 100)}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-white/80 dark:bg-slate-800/80 p-4 shadow-sm">
                    <p className="text-xs uppercase text-muted-foreground">Tax</p>
                    <p className="text-lg font-semibold dark:text-white">
                      {formatPKR(order.taxCents / 100)}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-indigo-50 dark:bg-indigo-950 p-4 shadow-sm">
                    <p className="text-xs uppercase text-indigo-700 dark:text-indigo-300">Total</p>
                    <p className="text-xl font-bold text-indigo-700 dark:text-indigo-300">
                      {formatPKR(order.totalCents / 100)}
                    </p>
                  </div>
                </div>
                )}



                {/* Order Items */}
                {orderItems.length > 0 && (
                  <div className="mx-6 mb-6 space-y-4">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Order Items</h3>
                    <div className="space-y-3">
                      {orderItems.map((item) => {
                        const quantityRefunded = item.quantityRefunded || 0
                        const isFullyRefunded = quantityRefunded >= item.quantity
                        const isPartiallyRefunded = quantityRefunded > 0 && !isFullyRefunded

                        return (
                          <div
                            key={item.id}
                            className={`flex items-center gap-4 rounded-lg border bg-white dark:bg-slate-800 dark:border-slate-700 p-4 ${isFullyRefunded ? "opacity-70" : ""}`}
                          >
                            <div className="flex h-16 w-16 items-center justify-center rounded-lg border bg-slate-50 dark:bg-slate-600 dark:border-slate-500">
                              {item.imageUrl ? (
                                <img
                                  src={item.imageUrl}
                                  alt={item.productName}
                                  className="h-full w-full rounded-lg object-cover"
                                />
                              ) : (
                                <Package className="h-8 w-8 text-slate-400 dark:text-slate-300" />
                              )}
                            </div>
                            <div className="flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className={`font-semibold text-slate-900 dark:text-white ${isFullyRefunded ? "line-through text-muted-foreground dark:text-slate-400" : ""}`}>
                                  {item.productName}
                                </p>
                                {isFullyRefunded && <Badge variant="destructive" className="text-[10px]">Refunded</Badge>}
                                {isPartiallyRefunded && <Badge variant="outline" className="border-yellow-500 text-yellow-600 text-[10px]">Partial refund</Badge>}
                              </div>
                              {item.productCode && (
                                <p className="text-xs text-muted-foreground font-mono">{item.productCode}</p>
                              )}
                              <p className="text-xs text-muted-foreground mt-1">
                                {!pricesHidden && item.priceCents !== null && (
                                  <>{formatPKR(item.priceCents / 100)} per {item.unit}</>
                                )}
                                {quantityRefunded > 0 && (
                                  <span className="ml-2 font-semibold text-red-600 dark:text-red-400">
                                    {formatQuantity(quantityRefunded)} refunded
                                  </span>
                                )}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="text-sm font-semibold text-slate-900 dark:text-white">Qty: {formatQuantity(item.quantity)}</p>
                              {!pricesHidden && item.priceCents !== null && <p className={`text-sm font-bold ${isFullyRefunded ? "line-through text-muted-foreground" : "text-indigo-600 dark:text-indigo-400"}`}>
                                {formatPKR((calculateLineCents(item.priceCents, item.quantity)) / 100)}
                              </p>}
                              {!pricesHidden && item.priceCents !== null && quantityRefunded > 0 && (
                                <p className="text-[11px] font-bold text-red-600 dark:text-red-400">
                                  - {formatPKR((calculateLineCents(item.priceCents, quantityRefunded)) / 100)}
                                </p>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                <div id={order.refundAmountCents && order.refundAmountCents > 0 ? undefined : "refund-details"} className="mx-6 mb-6 scroll-mt-6">
                  <RefundManagement
                    orderId={order.id}
                    orderTotalCents={order.totalCents}
                    orderStatus={order.status}
                    orderFulfillmentStatus={order.fulfillmentStatus}
                    createdAt={order.createdAt}
                    allowRefundRequest={canRequestRefundFromOrderReview}
                    requesterRole={userRole}
                    pricesHidden={pricesHidden}
                    initialOrderItems={orderItems}
                    onRefundSuccess={() => mutate()}
                    refundAmountCents={order.refundAmountCents}
                    refundedAt={order.refundedAt}
                    refundReason={order.refundReason}
                  />
                </div>
              </Card>

              {/* The token is only returned to the configured approver or Super Admin. */}

              <Card className="p-5 dark:bg-slate-900 dark:border-slate-800">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">Status timeline</p>
                    <p className="text-xs text-muted-foreground">Track key lifecycle events.</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <Badge variant="outline">
                      {getOrderDerivedStatus({ status: order.status }).label}
                    </Badge>
                    {hasPartialRefund(order) && (
                      <Badge variant="outline" className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                        Partial Refund
                      </Badge>
                    )}
                  </div>
                </div>
                <ol className="space-y-4">
                  {buildStatusTimeline(
                    order.status,
                    order.statusAtRefund,
                    (order.refundAmountCents || 0) > 0 && order.status.toUpperCase() !== "REFUNDED",
                    canDecideOrders ? order.approvalToken : null
                  ).map((step: any, index, arr) => {
                    const isLast = index === arr.length - 1
                    const isComplete = step.state === "complete"
                    const isCurrent = step.state === "current"
                    const isSkipped = step.state === "skipped"

                    return (
                      <li key={step.key} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <div
                            className={`flex h-8 w-8 items-center justify-center rounded-full border ${(() => {
                              if (isComplete) {
                                return "border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300"
                              }
                              if (isCurrent) {
                                return "border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
                              }
                              if (isSkipped) {
                                return "border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border-dashed"
                              }
                              return "border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-slate-400 dark:text-slate-400"
                            })()
                              }`}
                          >
                            {(() => {
                              if (isComplete) {
                                return (
                              <CheckCircle className="h-4 w-4" />
                            )
                              }
                              if (isSkipped) {
                                return (
                              <Ban className="h-4 w-4" />
                            )
                              }
                              if (isCurrent) {
                                return (
                              <Clock className="h-4 w-4" />
                            )
                              }
                              return null
                            })()}
                          </div>
                          {!isLast && (
                            <div
                              className={`mt-1 w-px flex-1 ${isComplete ? "bg-emerald-100 dark:bg-emerald-900" : "bg-slate-200 dark:bg-slate-600"
                                }`}
                            />
                          )}
                        </div>
                        <div className={`flex-1 rounded-xl border dark:border-slate-700 bg-white dark:bg-slate-800 p-3 shadow-sm ${isSkipped ? 'opacity-60 grayscale' : ''}`}>
                          <p className="text-sm font-semibold dark:text-white">
                            {step.label}
                            {isSkipped && <span className="ml-2 text-[10px] font-normal text-muted-foreground uppercase tracking-wider">(Skipped)</span>}
                          </p>
                          <p className="text-xs text-muted-foreground">{step.description}</p>
                          {step.approvalToken && (
                            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-100 dark:border-emerald-900/50 p-2">
                              <div className="flex flex-col">
                                <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest">Approval Token</span>
                                <span className="font-mono text-xs font-black text-slate-900 dark:text-white mt-0.5">{step.approvalToken}</span>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 hover:bg-emerald-100 dark:hover:bg-emerald-900 text-emerald-600 dark:text-emerald-400"
                                onClick={() => {
                                  navigator.clipboard.writeText(step.approvalToken)
                                  toast({
                                    title: "Token Copied",
                                    description: "Approval token copied to clipboard",
                                  })
                                }}
                              >
                                <Copy className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </Card>
            </div>
          )}
        </>
      )}

      <Dialog open={decision !== null} onOpenChange={(open) => !open && setDecision(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{decision === "approve" ? "Approve order" : "Reject order"}</DialogTitle>
          </DialogHeader>
          {decision === "approve" ? (
            <p className="text-sm text-muted-foreground">
              Approve order {order?.tid}? The order creator and Super Admin will be notified.
            </p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Provide a reason for rejecting order {order?.tid}.</p>
              <Input
                value={rejectionReason}
                onChange={(event) => setRejectionReason(event.target.value)}
                placeholder="Rejection reason"
                maxLength={2000}
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={isDeciding} onClick={() => setDecision(null)}>Cancel</Button>
            <Button
              disabled={isDeciding || (decision === "reject" && !rejectionReason.trim())}
              onClick={submitDecision}
              className={decision === "reject" ? "bg-rose-600 text-white hover:bg-rose-500" : "bg-emerald-600 text-white hover:bg-emerald-500"}
            >
              {(() => {
                if (isDeciding) {
                  return "Processing..."
                }
                if (decision === "approve") {
                  return "Approve order"
                }
                return "Reject order"
              })()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={generatedToken !== null} onOpenChange={(open) => !open && setGeneratedToken(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Order approved</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Save this fulfillment token and share it securely with the Super Admin.
          </p>
          <div className="rounded-xl border bg-indigo-50 p-5 text-center font-mono text-2xl font-black tracking-[0.25em] text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300">
            {generatedToken}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(generatedToken || "")
                toast({ title: "Copied", description: "Token copied to clipboard." })
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}



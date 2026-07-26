"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import {
  Package,
  CheckCircle,
  XCircle,
  TrendingDown,
  Clock,
  LayoutGrid,
  List,
  MapPin,
  Building2,
  Calendar as CalendarIcon,
  Check,
  X,
  CreditCard,
  Building,
  AlertTriangle,
  FileCheck,
  Lock,
  Share2,
  Copy,
  Send,
  Truck,
  Banknote
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "@/hooks/use-toast"
import { cn, formatPKR } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { ReceiptIconButton } from "@/components/receipts/receipt-icon-button"
import { Separator } from "@/components/ui/separator"
import { getOrderDerivedStatus, hasPartialRefund, type DerivedOrderStatusKey, type OrderStatusContext } from "@/lib/order-status"
import {
  FULFILLMENT_STATUS_LABELS,
  getNextFulfillmentStatus,
  normalizeFulfillmentStatus,
  type FulfillmentStatus,
} from "@/lib/fulfillment-status"
import {
  PAYMENT_STATUS_LABELS,
  normalizePaymentStatus,
  type PaymentStatus,
} from "@/lib/payment-status"

type OrderItem = any // Avoiding strict type definition for speed, will rely on usage
type OrdersDirectoryProps = {
  orders: OrderItem[]
  statusContext?: OrderStatusContext
  userRole: string | undefined
  isSuperAdmin: boolean
  isBranchAdmin: boolean
  isHeadOffice?: boolean
  showCostCenterId?: boolean
  onUpdate: () => void
}

export function OrdersDirectory({
  orders,
  statusContext = "default",
  userRole,
  isSuperAdmin,
  isBranchAdmin,
  isHeadOffice,
  showCostCenterId,
  onUpdate
}: OrdersDirectoryProps) {
  const router = useRouter()
  const [viewMode, setViewMode] = useState<"grid" | "table">("table")
  const [viewingOrder, setViewingOrder] = useState<OrderItem | null>(null)

  // Modals for actions
  const [actionType, setActionType] = useState<"approve" | "reject" | "fulfill" | null>(null)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [showTokenDialog, setShowTokenDialog] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [fulfillToken, setFulfillToken] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [isUpdatingProgress, setIsUpdatingProgress] = useState(false)
  const [isUpdatingPayment, setIsUpdatingPayment] = useState(false)
  const [isSendingTokenEmail, setIsSendingTokenEmail] = useState(false)
  const shouldShowCostCenterId = showCostCenterId ?? orders.some((order) => Boolean(order.branchCostCenterId))

  // Helpers
  const getStatusColor = (statusKey: DerivedOrderStatusKey) => {
    switch (statusKey) {
      case "partially_refunded":
        return { bg: "bg-amber-500/10 dark:bg-amber-500/20", text: "text-amber-600 dark:text-amber-400", border: "border-amber-200 dark:border-amber-800", icon: <TrendingDown className="h-4 w-4" /> }
      case "refunded":
        return { bg: "bg-rose-500/10 dark:bg-rose-500/20", text: "text-rose-600 dark:text-rose-400", border: "border-rose-200 dark:border-rose-800", icon: <TrendingDown className="h-4 w-4" /> }
      case "partially_fulfilled":
        return { bg: "bg-teal-500/10 dark:bg-teal-500/20", text: "text-teal-600 dark:text-teal-400", border: "border-teal-200 dark:border-teal-800", icon: <CheckCircle className="h-4 w-4" /> }
      case "fulfilled":
        return { bg: "bg-emerald-500/10 dark:bg-emerald-500/20", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-200 dark:border-emerald-800", icon: <CheckCircle className="h-4 w-4" /> }
      case "approved":
        return { bg: "bg-blue-500/10 dark:bg-blue-500/20", text: "text-blue-600 dark:text-blue-400", border: "border-blue-200 dark:border-blue-800", icon: <FileCheck className="h-4 w-4" /> }
      case "pending":
        return { bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-300", border: "border-slate-200 dark:border-slate-700", icon: <Clock className="h-4 w-4" /> }
      case "rejected":
      case "cancelled":
        return { bg: "bg-rose-500/10 dark:bg-rose-500/20", text: "text-rose-600 dark:text-rose-400", border: "border-rose-200 dark:border-rose-800", icon: <XCircle className="h-4 w-4" /> }
      default:
        return { bg: "bg-slate-100", text: "text-slate-600", border: "border-slate-200", icon: <Package className="h-4 w-4" /> }
    }
  }

  const openFullDetails = (order: OrderItem) => {
    router.push(`/orders/${order.id}#refund-details`)
  }

  const getFulfillmentProgressColor = (status?: string | null) => {
    switch (normalizeFulfillmentStatus(status)) {
      case "DELIVERED":
        return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
      case "OUT_FOR_DELIVERY":
        return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-300"
      case "IN_PROCESS":
        return "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/30 dark:text-indigo-300"
      default:
        return "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400"
    }
  }

  const shouldShowFulfillmentProgress = (order: OrderItem) => {
    const status = String(order.status || "").toLowerCase()
    return status === "approved" || status === "fulfilled"
  }

  const getPaymentStatusColor = (status?: string | null) => {
    return normalizePaymentStatus(status) === "PAID"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
  }

  const shouldShowPaymentStatus = (order: OrderItem) => {
    const status = String(order.status || "").toLowerCase()
    return status !== "rejected" && status !== "cancelled"
  }

  const updatePaymentStatus = async (nextStatus: PaymentStatus) => {
    if (!viewingOrder) return

    setIsUpdatingPayment(true)
    try {
      const res = await fetch(`/api/v1/orders/${viewingOrder.id}/payment-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentStatus: nextStatus }),
      })

      const responseText = await res.text()
      const data = responseText
        ? (() => {
            try {
              return JSON.parse(responseText)
            } catch {
              return { error: responseText }
            }
          })()
        : {}

      if (!res.ok) throw new Error(data.error || "Failed to update payment status")

      const updatedOrder = {
        ...viewingOrder,
        paymentStatus: data.item?.paymentStatus || nextStatus,
      }
      setViewingOrder(updatedOrder)
      toast({
        title: "Payment status updated",
        description: `Order marked ${PAYMENT_STATUS_LABELS[nextStatus]}.`,
      })
      onUpdate()
    } catch (err: any) {
      toast({
        title: "Payment Update Failed",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setIsUpdatingPayment(false)
    }
  }

  const updateFulfillmentProgress = async (nextStatus: FulfillmentStatus) => {
    if (!viewingOrder) return

    setIsUpdatingProgress(true)
    try {
      const res = await fetch(`/api/v1/orders/${viewingOrder.id}/fulfillment-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fulfillmentStatus: nextStatus }),
      })

      const responseText = await res.text()
      const data = responseText
        ? (() => {
            try {
              return JSON.parse(responseText)
            } catch {
              return { error: responseText }
            }
          })()
        : {}

      if (!res.ok) throw new Error(data.error || "Failed to update fulfillment progress")

      const updatedOrder = {
        ...viewingOrder,
        fulfillmentStatus: data.item?.fulfillmentStatus || nextStatus,
      }
      setViewingOrder(updatedOrder)
      toast({
        title: "Progress updated",
        description: `Order marked ${FULFILLMENT_STATUS_LABELS[nextStatus]}.`,
      })
      onUpdate()
    } catch (err: any) {
      toast({
        title: "Progress Update Failed",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setIsUpdatingProgress(false)
    }
  }

  const EmptyOrdersState = ({ compact = false }: { compact?: boolean }) => (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "py-16" : "p-16")}>
      <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
        <Package className="h-10 w-10 text-slate-300 dark:text-slate-600" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">No orders found</p>
        <p className="text-xs font-medium text-slate-400 dark:text-slate-500">No order data is available for the selected filters.</p>
      </div>
    </div>
  )

  // Handlers
  const executeAction = async () => {
    if (!viewingOrder || !actionType) return

    setIsProcessing(true)
    try {
      let endpoint = ""
      let payload: any = {}

      if (actionType === "approve") {
        endpoint = `/api/v1/orders/${viewingOrder.id}/approve`
      } else if (actionType === "reject") {
        endpoint = `/api/v1/orders/${viewingOrder.id}/reject`
        payload = { reason: rejectReason }
      } else if (actionType === "fulfill") {
        if (!fulfillToken) throw new Error("Fulfillment token is required")
        endpoint = `/api/v1/orders/${viewingOrder.id}/fulfill`
        payload = { approvalToken: fulfillToken }
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined
      })

      const responseText = await res.text()
      const data = responseText
        ? (() => {
            try {
              return JSON.parse(responseText)
            } catch {
              return { error: responseText }
            }
          })()
        : {}
      if (!res.ok) throw new Error(data.error || "Action failed")

      toast({
        title: "Success",
        description: `Order successfully ${actionType}ed.`,
      })

      if (actionType === "approve" && isBranchAdmin && (data.fulfillmentToken || data.approvalToken)) {
        setGeneratedToken(data.fulfillmentToken || data.approvalToken)
        setShowTokenDialog(true)
      }

      setActionType(null)
      setViewingOrder(null)
      setRejectReason("")
      setFulfillToken("")
      onUpdate()

    } catch (err: any) {
      toast({
        title: "Action Failed",
        description: err.message,
        variant: "destructive"
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const sendTokenToAdmin = async () => {
    if (!viewingOrder) return

    setIsSendingTokenEmail(true)
    try {
      const res = await fetch(`/api/v1/orders/${viewingOrder.id}/send-token-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const responseText = await res.text()
      const data = responseText
        ? (() => {
            try {
              return JSON.parse(responseText)
            } catch {
              return { error: responseText }
            }
          })()
        : {}

      if (!res.ok) throw new Error(data.error || "Failed to send token email")

      toast({
        title: "Token sent",
        description: "Fulfillment token emailed to the admin.",
      })
    } catch (err: any) {
      toast({
        title: "Email Failed",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setIsSendingTokenEmail(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Directory Tools */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2 text-sm text-slate-500 font-medium">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white dark:bg-slate-800 text-[10px] shadow-sm text-slate-600 dark:text-slate-400">
            {orders.length}
          </span>
          <span>Orders visible</span>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-1 rounded-xl shadow-sm flex items-center gap-1">
          <Button
            variant={viewMode === "grid" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("grid")}
            className={cn("h-8 gap-2 rounded-lg text-[11px] font-bold px-3 transition-all", viewMode === "grid" ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/50 dark:text-indigo-400" : "text-slate-500 hover:text-slate-900")}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Grid
          </Button>
          <Button
            variant={viewMode === "table" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setViewMode("table")}
            className={cn("h-8 gap-2 rounded-lg text-[11px] font-bold px-3 transition-all", viewMode === "table" ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/50 dark:text-indigo-400" : "text-slate-500 hover:text-slate-900")}
          >
            <List className="h-3.5 w-3.5" />
            Table
          </Button>
        </div>
      </div>

      <AnimatePresence mode="wait">
        {viewMode === "grid" ? (
          <motion.div
            key="grid"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          >
            {orders.length === 0 ? (
              <div className="col-span-full border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-3xl bg-slate-50/50 dark:bg-slate-900/50">
                <EmptyOrdersState />
              </div>
            ) : orders.map((order, idx) => {
              const derivedStatus = getOrderDerivedStatus(order, statusContext)
              const statusColors = getStatusColor(derivedStatus.key)
              return (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: idx * 0.03 }}
                  key={order.id}
                  onClick={() => setViewingOrder(order)}
                  className="group relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-5 shadow-sm hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden"
                >
                  {/* Subtle Background Accent */}
                  <div className={cn("absolute top-0 right-0 w-32 h-32 blur-3xl rounded-full opacity-20 -translate-y-1/2 translate-x-1/2 transition-opacity group-hover:opacity-40", statusColors.bg.split(' ')[0])} />

                  <div className="relative z-10 mb-4 flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">TID</p>
                      <p className="truncate font-mono text-sm font-bold text-slate-800 dark:text-slate-100">{order.tid}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "max-w-full whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[10px] font-bold uppercase leading-tight tracking-wider",
                        statusColors.bg,
                        statusColors.text,
                        statusColors.border
                      )}
                    >
                      {derivedStatus.label}
                    </Badge>
                    {shouldShowFulfillmentProgress(order) && (
                      <Badge
                        variant="outline"
                        className={cn("max-w-full whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getFulfillmentProgressColor(order.fulfillmentStatus))}
                      >
                        {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)]}
                      </Badge>
                    )}
                    {shouldShowPaymentStatus(order) && (
                      <Badge
                        variant="outline"
                        className={cn("max-w-full whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getPaymentStatusColor(order.paymentStatus))}
                      >
                        {PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]}
                      </Badge>
                    )}
                    {hasPartialRefund(order) && (
                      <Badge variant="outline" className="max-w-full rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[9px] font-bold uppercase leading-tight tracking-wider text-amber-600 dark:text-amber-400">
                        Partial Refund
                      </Badge>
                    )}
                  </div>

                  <div className="space-y-3 relative z-10">
                    <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                      <Building2 className="h-4 w-4 opacity-70 text-indigo-500" />
                      <span className="truncate font-medium">{order.branchName || `#${order.branchId}`}</span>
                    </div>

                    <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                      <CalendarIcon className="h-4 w-4 opacity-70 text-blue-500" />
                      <span className="truncate font-medium">{format(new Date(order.createdAt), "dd MMM yyyy, p")}</span>
                    </div>
                  </div>

                  <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between relative z-10">
                    {order.totalCents !== null && order.totalCents !== undefined && (
                      <>
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total</p>
                        <p className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
                          {formatPKR(order.totalCents / 100)}
                        </p>
                      </>
                    )}
                  </div>
                </motion.div>
              )
            })}
          </motion.div>
        ) : (
          <motion.div
            key="table"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl overflow-x-auto shadow-sm"
          >
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/50 text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                  <th className="text-left font-bold py-4 pl-6">TID</th>
                  <th className="text-left font-bold py-4">Branch</th>
                  {shouldShowCostCenterId && <th className="text-left font-bold py-4">Cost Center</th>}
                  <th className="text-left font-bold py-4">Status</th>
                  <th className="text-left font-bold py-4">Order Date</th>
                  <th className="text-left font-bold py-4">Delivery Date</th>
                  <th className="text-right font-bold py-4 pr-6">Amount</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => {
                  const derivedStatus = getOrderDerivedStatus(order, statusContext)
                  const statusColors = getStatusColor(derivedStatus.key)
                  return (
                    <motion.tr
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.02 }}
                      key={order.id}
                      onClick={() => setViewingOrder(order)}
                      className="group border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50/80 dark:hover:bg-slate-800/30 cursor-pointer transition-colors"
                    >
                      <td className="py-4 pl-6">
                        <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-300 group-hover:text-indigo-600 transition-colors uppercase tracking-wider">{order.tid}</span>
                      </td>
                      <td className="py-4">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-3.5 w-3.5 opacity-60 text-indigo-500" />
                          <span className="font-medium text-slate-600 dark:text-slate-400">{order.branchName || `#${order.branchId}`}</span>
                        </div>
                      </td>
                      {shouldShowCostCenterId && (
                        <td className="py-4">
                          <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                            {order.branchCostCenterId || "-"}
                          </span>
                        </td>
                      )}
                      <td className="py-4">
                        <Badge variant="outline" className={cn("px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-lg border", statusColors.bg, statusColors.text, statusColors.border)}>
                          {derivedStatus.label}
                        </Badge>
                        {shouldShowFulfillmentProgress(order) && (
                          <Badge variant="outline" className={cn("ml-2 px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getFulfillmentProgressColor(order.fulfillmentStatus))}>
                            {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)]}
                          </Badge>
                        )}
                        {shouldShowPaymentStatus(order) && (
                          <Badge variant="outline" className={cn("ml-2 px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getPaymentStatusColor(order.paymentStatus))}>
                            {PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]}
                          </Badge>
                        )}
                        {hasPartialRefund(order) && (
                          <Badge variant="outline" className="ml-2 px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                            Partial Refund
                          </Badge>
                        )}
                      </td>
                      <td className="py-4 font-medium text-slate-500 text-xs">
                        {format(new Date(order.createdAt), "dd MMM yyyy")}
                      </td>
                      <td className="py-4 font-medium text-slate-500 text-xs">
                        {order.deliveredAt ? format(new Date(order.deliveredAt), "dd MMM yyyy") : "—"}
                      </td>
                      <td className="py-4 pr-6 text-right font-bold text-slate-800 dark:text-slate-200">
                        {order.totalCents !== null && order.totalCents !== undefined ? formatPKR(order.totalCents / 100) : "-"}
                      </td>
                    </motion.tr>
                  )
                })}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={shouldShowCostCenterId ? 7 : 6}>
                      <EmptyOrdersState compact />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Spatial Detail Drawer (Order Action Sheet) - Adorable Theme */}
      <Sheet open={!!viewingOrder && !actionType} onOpenChange={(open) => !open && setViewingOrder(null)}>
        <SheetContent className="w-full sm:max-w-md border-l-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] p-0 bg-[#fdfdfd] dark:bg-[#0b0f19] overflow-y-auto">
          {viewingOrder && (
            (() => {
              const isRefundRelated =
                viewingOrder.status?.toLowerCase() === "refunded" ||
                Number(viewingOrder.refundAmountCents || 0) > 0

              return (
            <div className="flex flex-col h-full font-sans">
              {/* Cute Header Section */}
              <div className="p-6 md:p-8 bg-gradient-to-br from-indigo-50/80 to-purple-50/50 dark:from-indigo-950/20 dark:to-purple-950/10 border-b border-indigo-100/50 dark:border-indigo-900/30 rounded-b-[2.5rem] relative overflow-hidden shrink-0">
                {/* Decorative Blobs */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-pink-300/20 dark:bg-pink-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3 pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-40 h-40 bg-blue-300/20 dark:bg-blue-500/10 rounded-full blur-2xl translate-y-1/2 -translate-x-1/4 pointer-events-none" />

                <div className="flex justify-between items-start mb-6 relative z-10">
                  <div className="flex items-center gap-4">
                    <div className="h-14 w-14 rounded-[1.2rem] bg-indigo-100/80 dark:bg-indigo-900/40 border border-white/50 dark:border-indigo-800/30 flex items-center justify-center text-indigo-500 dark:text-indigo-400 shadow-sm backdrop-blur-sm -rotate-3 transition-transform hover:rotate-0">
                      <Package className="h-7 w-7 stroke-[1.5]" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-indigo-400/80 dark:text-indigo-500 uppercase tracking-widest mb-0.5">Order ID</p>
                      <h2 className="font-mono text-lg font-black text-slate-800 dark:text-slate-100 tracking-wider">
                        {viewingOrder.tid}
                      </h2>
                    </div>
                  </div>
                  {(() => {
                    const derivedStatus = getOrderDerivedStatus(viewingOrder, statusContext)
                    const c = getStatusColor(derivedStatus.key)
                    return (
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant="outline" className={cn("px-3 py-1 text-[9px] font-bold tracking-widest uppercase rounded-xl border-dashed shadow-sm backdrop-blur-sm", c.bg, c.text, c.border)}>
                          {derivedStatus.label}
                        </Badge>
                        {hasPartialRefund(viewingOrder) && (
                          <Badge variant="outline" className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                            Partial Refund
                          </Badge>
                        )}
                      </div>
                    )
                  })()}
                </div>

                <div className="bg-white/60 dark:bg-slate-900/40 backdrop-blur-md border border-white dark:border-slate-800 p-4 rounded-3xl shadow-[0_4px_20px_rgb(0,0,0,0.03)] grid grid-cols-2 gap-4 relative z-10">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center gap-1">
                      <CreditCard className="h-3 w-3" /> Total
                    </p>
                    {viewingOrder.totalCents !== null && viewingOrder.totalCents !== undefined && (
                      <p className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(viewingOrder.totalCents / 100)}</p>
                    )}
                  </div>
                  <div className="space-y-1 text-right">
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center justify-end gap-1">
                      <CalendarIcon className="h-3 w-3" /> Date
                    </p>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{format(new Date(viewingOrder.createdAt), "dd MMM yyyy")}</p>
                    <p className="text-[10px] font-semibold text-slate-400">{format(new Date(viewingOrder.createdAt), "p")}</p>
                  </div>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 p-6 space-y-5">
                <div className="space-y-3">
                  <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 pl-2">
                    <MapPin className="h-3.5 w-3.5" />
                    Details
                  </h3>
                  <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-100 dark:border-slate-800 p-5 rounded-[2rem] space-y-4">
                    {isSuperAdmin && (
                      <div className="flex items-center justify-between group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Building className="h-3.5 w-3.5" /> Org</span>
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-200 transition-colors group-hover:text-indigo-500">{viewingOrder.organizationName || `#${viewingOrder.organizationId}`}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between group">
                      <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> Branch</span>
                      <span className="text-sm font-bold text-slate-800 dark:text-slate-200 transition-colors group-hover:text-indigo-500">{viewingOrder.branchName || `#${viewingOrder.branchId}`}</span>
                    </div>
                    {(viewingOrder.branchAddress || viewingOrder.branchCity || viewingOrder.branchProvince) && (
                      <div className="flex items-start justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5 shrink-0"><MapPin className="h-3.5 w-3.5" /> Address</span>
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300 text-right leading-snug">
                          {[viewingOrder.branchAddress, viewingOrder.branchCity, viewingOrder.branchProvince].filter(Boolean).join(", ")}
                        </span>
                      </div>
                    )}
                    {shouldShowFulfillmentProgress(viewingOrder) && (
                      <div className="flex items-center justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" /> Progress</span>
                        <Badge
                          variant="outline"
                          className={cn("max-w-[11rem] whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getFulfillmentProgressColor(viewingOrder.fulfillmentStatus))}
                        >
                          {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(viewingOrder.fulfillmentStatus)]}
                        </Badge>
                      </div>
                    )}
                    {shouldShowPaymentStatus(viewingOrder) && (
                      <div className="flex items-center justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" /> Payment</span>
                        <Badge
                          variant="outline"
                          className={cn("max-w-[11rem] whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getPaymentStatusColor(viewingOrder.paymentStatus))}
                        >
                          {PAYMENT_STATUS_LABELS[normalizePaymentStatus(viewingOrder.paymentStatus)]}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>

                {viewingOrder.rejectionReason && (
                  <div className="p-5 rounded-[2rem] bg-rose-50/50 border border-rose-100 dark:bg-rose-950/20 dark:border-rose-900/30">
                    <div className="flex items-center gap-2 mb-2 text-rose-500">
                      <AlertTriangle className="h-4 w-4" />
                      <h4 className="text-[11px] font-bold uppercase tracking-wider">Rejection Reason</h4>
                    </div>
                    <p className="text-sm text-rose-700 dark:text-rose-300 font-medium leading-relaxed">{viewingOrder.rejectionReason}</p>
                  </div>
                )}

                {(isBranchAdmin && (viewingOrder.fulfillmentToken || viewingOrder.approvalToken) && viewingOrder.status.toLowerCase() === "approved") && (
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 pl-2">
                       Fulfillment Token
                    </h3>
                    <div className="bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-800 p-5 rounded-[2rem] space-y-3 relative overflow-hidden group">
                      <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-2">Share With Super Admin</p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 font-mono text-lg font-black tracking-[0.2em] text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-950 px-4 py-2 rounded-xl border border-indigo-200 dark:border-indigo-800 shadow-inner">
                          {viewingOrder.fulfillmentToken || viewingOrder.approvalToken}
                        </div>
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-11 w-11 rounded-xl bg-white dark:bg-slate-950 border border-indigo-100 dark:border-indigo-800 text-indigo-500 hover:bg-indigo-50 transition-all active:scale-90"
                          onClick={() => {
                            const tokenToCopy = viewingOrder.fulfillmentToken || viewingOrder.approvalToken || ""
                            navigator.clipboard.writeText(tokenToCopy)
                            toast({ title: "Copied", description: "Token copied to clipboard" })
                          }}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={isSendingTokenEmail}
                        onClick={sendTokenToAdmin}
                        className="w-full h-11 rounded-xl bg-white dark:bg-slate-950 border-indigo-100 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 font-bold text-[11px] uppercase tracking-widest transition-all active:scale-[0.99]"
                      >
                        <Send className={cn("mr-2 h-4 w-4", isSendingTokenEmail && "animate-pulse")} />
                        {isSendingTokenEmail ? "Sending Token..." : "Send Token to Admin"}
                      </Button>
                      <p className="text-[9px] font-bold text-slate-400 leading-tight">
                        Provide this security token to the Super Admin to mark this order as fulfilled.
                      </p>
                    </div>
                  </div>
                )}


              </div>

              {/* Cute Action Footer */}
              <div className="p-6 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-t border-slate-100 dark:border-slate-800 rounded-t-[2.5rem] mt-auto shrink-0 space-y-3 pb-safe">
                {isRefundRelated && (
                  <Button
                    type="button"
                    onClick={() => openFullDetails(viewingOrder)}
                    className="w-full h-12 rounded-2xl bg-amber-500 hover:bg-amber-600 text-white font-bold shadow-lg shadow-amber-500/20 gap-2"
                  >
                    <TrendingDown className="h-4 w-4" />
                    View Refund Details
                  </Button>
                )}

                {isSuperAdmin && shouldShowPaymentStatus(viewingOrder) && (
                  (() => {
                    const isPaid = normalizePaymentStatus(viewingOrder.paymentStatus) === "PAID"
                    return (
                      <Button
                        type="button"
                        disabled={isUpdatingPayment}
                        onClick={() => updatePaymentStatus(isPaid ? "UNPAID" : "PAID")}
                        className={cn(
                          "w-full h-12 rounded-xl text-white font-bold shadow-lg",
                          isPaid
                            ? "bg-amber-500 hover:bg-amber-600 shadow-amber-500/20"
                            : "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20"
                        )}
                      >
                        <Banknote className={cn("mr-2 h-4 w-4", isUpdatingPayment && "animate-pulse")} />
                        {isUpdatingPayment ? "Updating..." : isPaid ? "Mark as Unpaid" : "Mark as Paid"}
                      </Button>
                    )
                  })()
                )}

                <div className="flex bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 h-14 rounded-2xl justify-center items-center border border-dashed border-slate-200 dark:border-slate-700 transition-colors">
                  <ReceiptIconButton orderId={viewingOrder.id} />
                </div>

                <div className="flex gap-3">
                  {viewingOrder.status.toLowerCase() === "pending" && isBranchAdmin && (
                    <>
                      <Button onClick={() => setActionType("reject")} variant="outline" className="flex-1 h-12 rounded-xl text-rose-600 border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-900/20 dark:border-rose-800">
                        Reject
                      </Button>
                      <Button onClick={() => setActionType("approve")} className="flex-1 h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-lg shadow-emerald-600/20">
                        Approve
                      </Button>
                    </>
                  )}

                  {viewingOrder.status.toLowerCase() === "approved" && isSuperAdmin && (
                    <div className="w-full space-y-3">
                      {(() => {
                        const nextStatus = getNextFulfillmentStatus(viewingOrder.fulfillmentStatus)
                        return nextStatus ? (
                          <Button
                            type="button"
                            disabled={isUpdatingProgress}
                            onClick={() => updateFulfillmentProgress(nextStatus)}
                            className="w-full h-12 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold shadow-lg shadow-sky-600/20"
                          >
                            <Truck className={cn("mr-2 h-4 w-4", isUpdatingProgress && "animate-pulse")} />
                            {isUpdatingProgress ? "Updating..." : `Mark ${FULFILLMENT_STATUS_LABELS[nextStatus]}`}
                          </Button>
                        ) : null
                      })()}
                      <Button onClick={() => setActionType("fulfill")} className="w-full h-12 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-600/20">
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Fulfill Order
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
              )
            })()
          )}
        </SheetContent>
      </Sheet>

      {/* Action Dialogs (Replacing the old ones) */}
      <Dialog open={!!actionType} onOpenChange={(open) => !open && setActionType(null)}>
        <DialogContent className="max-w-md border-0 shadow-2xl bg-white/90 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2rem]">
          <DialogHeader>
            <DialogTitle className="text-xl font-black tracking-tight flex items-center gap-2 capitalize">
              {actionType === 'reject' && <XCircle className="text-rose-500 h-6 w-6" />}
              {actionType === 'approve' && <CheckCircle className="text-emerald-500 h-6 w-6" />}
              {actionType === 'fulfill' && <Package className="text-indigo-500 h-6 w-6" />}
              {actionType} Order
            </DialogTitle>
          </DialogHeader>

          <div className="py-4">
            {actionType === "reject" && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-slate-500">Please provide a reason for rejecting TID {viewingOrder?.tid}:</p>
                <Input
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="e.g. Budget constraints"
                  className="h-12 rounded-xl border-slate-200 bg-white"
                  autoFocus
                />
              </div>
            )}
            {actionType === "approve" && (
              <p className="text-sm font-medium text-slate-500">Are you sure you want to approve TID {viewingOrder?.tid}? This will notify Super Admin.</p>
            )}
            {actionType === "fulfill" && (
              <div className="space-y-4">
                <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-400">
                    Enter the Approval Token provided by the Branch Admin to verify this fulfillment.
                  </p>
                </div>
                <Input
                  value={fulfillToken}
                  onChange={(e) => setFulfillToken(e.target.value)}
                  placeholder="e.g. A1B2C3D4"
                  className="h-14 font-mono text-center text-lg tracking-widest font-bold uppercase rounded-xl border-indigo-200 shadow-inner"
                  autoFocus
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setActionType(null)} disabled={isProcessing} className="h-11 rounded-xl">Cancel</Button>
            <Button
              onClick={executeAction}
              disabled={isProcessing || (actionType === 'reject' && !rejectReason) || (actionType === 'fulfill' && !fulfillToken)}
              className={cn("h-11 rounded-xl font-bold px-6 text-white shadow-lg",
                actionType === 'reject' ? "bg-rose-600 hover:bg-rose-500 shadow-rose-600/20" :
                  actionType === 'approve' ? "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20" :
                    "bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20"
              )}
            >
              {isProcessing ? "Processing..." : `Confirm ${actionType}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Success Token Dialog (Branch Admin Only) */}
      <Dialog open={showTokenDialog} onOpenChange={setShowTokenDialog}>
        <DialogContent className="max-w-md border-0 shadow-2xl bg-white/90 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2rem] overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-emerald-400 to-indigo-500" />
          <DialogHeader className="pt-8 items-center text-center">
            <div className="h-20 w-20 rounded-full bg-emerald-500/10 flex items-center justify-center mb-4">
              <CheckCircle className="h-10 w-10 text-emerald-500" />
            </div>
            <DialogTitle className="text-2xl font-black text-slate-900 dark:text-white uppercase tracking-tight">Order Approved!</DialogTitle>
            <p className="text-sm font-medium text-slate-500 mt-2">Security Token Generated</p>
          </DialogHeader>

          <div className="py-8 px-2 space-y-6">
            <div className="relative p-6 rounded-[2rem] bg-indigo-50/50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800 text-center space-y-4 group">
              <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">Share With Super Admin</p>
              <div className="font-mono text-3xl font-black tracking-[0.3em] text-indigo-600 dark:text-indigo-400 select-all">
                {generatedToken}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <Button 
                className="h-14 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-xl shadow-indigo-600/20 gap-2"
                onClick={() => {
                  navigator.clipboard.writeText(generatedToken || "")
                  toast({ title: "Copied", description: "Token copied to clipboard" })
                }}
              >
                Copy Token
              </Button>
              <Button variant="ghost" onClick={() => setShowTokenDialog(false)} className="h-12 rounded-2xl text-slate-500 font-bold uppercase tracking-widest text-[10px]">
                Dismiss
              </Button>
            </div>

            <p className="text-[10px] text-center text-slate-400 font-bold uppercase leading-relaxed px-4">
              IMPORTANT: COPY THIS TOKEN NOW. IT MUST BE GIVEN TO THE SUPER ADMIN TO COMPLETE THE FULFILLMENT PROCESS.
            </p>
          </div>
        </DialogContent>
      </Dialog>


    </div>
  )
}

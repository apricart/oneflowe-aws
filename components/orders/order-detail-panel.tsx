"use client"

import type { ReactNode } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Package,
  CheckCircle,
  XCircle,
  TrendingDown,
  Clock,
  MapPin,
  Building2,
  Calendar as CalendarIcon,
  CreditCard,
  Building,
  AlertTriangle,
  FileCheck,
  Copy,
  Send,
  Truck,
  Banknote,
  ChevronDown,
  Loader2,
  User,
} from "lucide-react"
import { format } from "date-fns"

import { toast } from "@/hooks/use-toast"
import { cn, formatPKR } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  getOrderDerivedStatus,
  hasPartialRefund,
  type DerivedOrderStatusKey,
  type OrderStatusContext,
} from "@/lib/order-status"
import { calculateLineCents, formatQuantity } from "@/lib/quantity"
import { FULFILLMENT_STATUS_LABELS, normalizeFulfillmentStatus } from "@/lib/fulfillment-status"
import { PAYMENT_STATUS_LABELS, normalizePaymentStatus } from "@/lib/payment-status"
import {
  shouldShowOrderFulfillmentStatus,
  shouldShowOrderPaymentStatus,
} from "@/lib/order-status-display"

export type OrderDetailLine = {
  id: number
  productName: string
  productCode?: string | null
  quantity: number
  quantityRefunded?: number | null
  priceCents: number | null
  unit?: string | null
}

export type OrderDetails = {
  id: number
  orderItems?: OrderDetailLine[]
  receiptData?: {
    buyerName?: string | null
    buyerPhone?: string | null
  } | null
  creatorName?: string | null
  creatorPhone?: string | null
  creatorEmployeeId?: string | null
  pricesHidden?: boolean
}

export function getStatusColor(statusKey: DerivedOrderStatusKey) {
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

export function getFulfillmentProgressColor(status?: string | null) {
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

export function getPaymentStatusColor(status?: string | null) {
  return normalizePaymentStatus(status) === "PAID"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300"
    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300"
}

type OrderDetailPanelProps = Readonly<{
  order: any
  statusContext?: OrderStatusContext
  /** Adds the organization row, which only a platform-level actor may see. */
  isSuperAdmin?: boolean
  /** Whether this viewer may see the fulfilment token on an approved order. */
  showFulfillmentToken?: boolean
  details: OrderDetails | null
  detailsExpanded: boolean
  detailsLoading: boolean
  detailsError: string | null
  onToggleDetails: () => void
  onRetryDetails: () => void
  /** Omitted when the viewer has no hand-off to the admin operations mailbox. */
  onSendToken?: () => void
  isSendingToken?: boolean
  /** The footer. Each portal owns its own decisions, so none are built in. */
  actions?: ReactNode
}>

/**
 * The read-only body of the order detail drawer, shared by every portal.
 *
 * It renders what an order *is* — status, branch, lifecycle dates, line items —
 * and deliberately owns no decision logic: what a viewer may *do* with the
 * order differs by role, so each caller passes its own `actions` footer and
 * supplies the already role-scoped `order` and `details` it fetched. Nothing
 * here widens access; every field shown is one the caller's endpoint already
 * returned to that role.
 */
export function OrderDetailPanel({
  order,
  statusContext = "default",
  isSuperAdmin = false,
  showFulfillmentToken = false,
  details,
  detailsExpanded,
  detailsLoading,
  detailsError,
  onToggleDetails,
  onRetryDetails,
  onSendToken,
  isSendingToken = false,
  actions,
}: OrderDetailPanelProps) {
  const normalizedOrderStatus = order.status?.trim().toUpperCase()
  const isActiveOrder = normalizedOrderStatus === "APPROVED"
  const isFulfilledOrder = ["FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"].includes(normalizedOrderStatus)
  const isDeliveredOrder = normalizeFulfillmentStatus(order.fulfillmentStatus) === "DELIVERED"

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
                        {order.tid}
                      </h2>
                    </div>
                  </div>
                  {(() => {
                    const derivedStatus = getOrderDerivedStatus(order, statusContext)
                    const c = getStatusColor(derivedStatus.key)
                    return (
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant="outline" className={cn("px-3 py-1 text-[9px] font-bold tracking-widest uppercase rounded-xl border-dashed shadow-sm backdrop-blur-sm", c.bg, c.text, c.border)}>
                          {derivedStatus.label}
                        </Badge>
                        {hasPartialRefund(order) && (
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
                    {order.totalCents !== null && order.totalCents !== undefined && (
                      <p className="text-xl font-black text-slate-900 dark:text-white tracking-tight">{formatPKR(order.totalCents / 100)}</p>
                    )}
                  </div>
                  <div className="space-y-1 text-right">
                    <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider flex items-center justify-end gap-1">
                      <CalendarIcon className="h-3 w-3" /> Date
                    </p>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{format(new Date(order.createdAt), "dd MMM yyyy")}</p>
                    <p className="text-[10px] font-semibold text-slate-400">{format(new Date(order.createdAt), "p")}</p>
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
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-200 transition-colors group-hover:text-indigo-500">{order.organizationName || `#${order.organizationId}`}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between group">
                      <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Building2 className="h-3.5 w-3.5" /> Branch</span>
                      <span className="text-sm font-bold text-slate-800 dark:text-slate-200 transition-colors group-hover:text-indigo-500">{order.branchName || `#${order.branchId}`}</span>
                    </div>
                    {(order.branchAddress || order.branchCity || order.branchProvince) && (
                      <div className="flex items-start justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5 shrink-0"><MapPin className="h-3.5 w-3.5" /> Address</span>
                        <span className="text-sm font-medium text-slate-700 dark:text-slate-300 text-right leading-snug">
                          {[order.branchAddress, order.branchCity, order.branchProvince].filter(Boolean).join(", ")}
                        </span>
                      </div>
                    )}
                    {isActiveOrder && (
                      <div className="flex items-start justify-between gap-3 group">
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-500">
                          <FileCheck className="h-3.5 w-3.5" /> Approval Date
                        </span>
                        <span className="text-right text-sm font-medium text-slate-700 dark:text-slate-300">
                          {order.approvedAt
                            ? format(new Date(order.approvedAt), "dd MMM yyyy, p")
                            : "Unavailable"}
                        </span>
                      </div>
                    )}
                    {isFulfilledOrder && (
                      <div className="flex items-start justify-between gap-3 group">
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-500">
                          <CheckCircle className="h-3.5 w-3.5" /> Fulfilled Date
                        </span>
                        <span className="text-right text-sm font-medium text-slate-700 dark:text-slate-300">
                          {order.fulfilledAt
                            ? format(new Date(order.fulfilledAt), "dd MMM yyyy, p")
                            : "Unavailable"}
                        </span>
                      </div>
                    )}
                    {isDeliveredOrder && (
                      <div className="flex items-start justify-between gap-3 group">
                        <span className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-500">
                          <Truck className="h-3.5 w-3.5" /> Delivery Date
                        </span>
                        <span className="text-right text-sm font-medium text-slate-700 dark:text-slate-300">
                          {order.deliveredAt
                            ? format(new Date(order.deliveredAt), "dd MMM yyyy, p")
                            : "Unavailable"}
                        </span>
                      </div>
                    )}
                    {shouldShowOrderFulfillmentStatus(order) && (
                      <div className="flex items-center justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Truck className="h-3.5 w-3.5" /> Progress</span>
                        <Badge
                          variant="outline"
                          className={cn("max-w-[11rem] whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getFulfillmentProgressColor(order.fulfillmentStatus))}
                        >
                          {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)]}
                        </Badge>
                      </div>
                    )}
                    {shouldShowOrderPaymentStatus(order) && (
                      <div className="flex items-center justify-between gap-3 group">
                        <span className="text-xs font-semibold text-slate-500 flex items-center gap-1.5"><Banknote className="h-3.5 w-3.5" /> Payment</span>
                        <Badge
                          variant="outline"
                          className={cn("max-w-[11rem] whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getPaymentStatusColor(order.paymentStatus))}
                        >
                          {PAYMENT_STATUS_LABELS[normalizePaymentStatus(order.paymentStatus)]}
                        </Badge>
                      </div>
                    )}
                  </div>
                </div>

                {order.rejectionReason && (
                  <div className="p-5 rounded-[2rem] bg-rose-50/50 border border-rose-100 dark:bg-rose-950/20 dark:border-rose-900/30">
                    <div className="flex items-center gap-2 mb-2 text-rose-500">
                      <AlertTriangle className="h-4 w-4" />
                      <h4 className="text-[11px] font-bold uppercase tracking-wider">Rejection Reason</h4>
                    </div>
                    <p className="text-sm text-rose-700 dark:text-rose-300 font-medium leading-relaxed">{order.rejectionReason}</p>
                  </div>
                )}

                {(showFulfillmentToken && (order.fulfillmentToken || order.approvalToken) && order.status.toLowerCase() === "approved") && (
                  <div className="space-y-3">
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2 pl-2">
                       Fulfillment Token
                    </h3>
                    <div className="bg-indigo-50/50 dark:bg-indigo-900/10 border border-indigo-100 dark:border-indigo-800 p-5 rounded-[2rem] space-y-3 relative overflow-hidden group">
                      <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-wider mb-2">Share With Super Admin</p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 font-mono text-lg font-black tracking-[0.2em] text-indigo-600 dark:text-indigo-400 bg-white dark:bg-slate-950 px-4 py-2 rounded-xl border border-indigo-200 dark:border-indigo-800 shadow-inner">
                          {order.fulfillmentToken || order.approvalToken}
                        </div>
                        <Button 
                          size="icon" 
                          variant="ghost" 
                          className="h-11 w-11 rounded-xl bg-white dark:bg-slate-950 border border-indigo-100 dark:border-indigo-800 text-indigo-500 hover:bg-indigo-50 transition-all active:scale-90"
                          onClick={() => {
                            const tokenToCopy = order.fulfillmentToken || order.approvalToken || ""
                            navigator.clipboard.writeText(tokenToCopy)
                            toast({ title: "Copied", description: "Token copied to clipboard" })
                          }}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                      {onSendToken && (
                        <Button
                          type="button"
                          variant="outline"
                          disabled={isSendingToken}
                          onClick={onSendToken}
                          className="w-full h-11 rounded-xl bg-white dark:bg-slate-950 border-indigo-100 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 font-bold text-[11px] uppercase tracking-widest transition-all active:scale-[0.99]"
                        >
                          <Send className={cn("mr-2 h-4 w-4", isSendingToken && "animate-pulse")} />
                          {isSendingToken ? "Sending Token..." : "Send Token to Admin"}
                        </Button>
                      )}
                      <p className="text-[9px] font-bold text-slate-400 leading-tight">
                        Provide this security token to the Super Admin to mark this order as fulfilled.
                      </p>
                    </div>
                  </div>
                )}


                <OrderDetailsDisclosure
                  order={order}
                  details={details}
                  expanded={detailsExpanded}
                  loading={detailsLoading}
                  error={detailsError}
                  onToggle={onToggleDetails}
                  onRetry={onRetryDetails}
                />

              </div>

              {actions}
            </div>
  )
}

function OrderDetailsDisclosure({
  order,
  details,
  expanded,
  loading,
  error,
  onToggle,
  onRetry,
}: Readonly<{
  order: any
  details: OrderDetails | null
  expanded: boolean
  loading: boolean
  error: string | null
  onToggle: () => void
  onRetry: () => void
}>) {
  const detailLines = details?.orderItems || []
  const profileName =
    details?.receiptData?.buyerName ||
    details?.creatorName ||
    order.branchName ||
    "Not available"
  const profilePhone =
    details?.receiptData?.buyerPhone ||
    details?.creatorPhone
  const pricesHidden =
    details?.pricesHidden === true ||
    order.totalCents === null ||
    order.totalCents === undefined

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 pl-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
        <Package className="h-3.5 w-3.5" />
        Transaction History
      </h3>
      <div
        className={cn(
          "overflow-hidden rounded-[1.75rem] border transition-all duration-300",
          expanded
            ? "border-indigo-200 bg-white shadow-lg ring-1 ring-indigo-500/10 dark:border-indigo-800 dark:bg-slate-900"
            : "border-slate-200 bg-white/60 hover:border-indigo-300 hover:bg-white dark:border-slate-800 dark:bg-slate-900/50 dark:hover:border-indigo-700 dark:hover:bg-slate-900"
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`order-detail-breakdown-${order.id}`}
          onClick={onToggle}
          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-50 text-sm font-black text-amber-600 dark:bg-amber-950/40 dark:text-amber-400">
            1
          </span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs font-bold tracking-tight text-slate-900 dark:text-white">
              {order.tid}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-2 text-[9px] font-bold uppercase tracking-widest text-slate-400">
              <span className="flex shrink-0 items-center gap-1">
                <Clock className="h-3 w-3" />
                {format(new Date(order.createdAt), "HH:mm")}
              </span>
              <span className="flex min-w-0 items-center gap-1">
                <Package className="h-3 w-3 shrink-0" />
                <span className="truncate">
                  {order.branchName || `#${order.branchId}`}
                </span>
              </span>
            </span>
          </span>
          <span className="text-right">
            <span className="block text-[9px] font-bold uppercase leading-none tracking-wider text-slate-400">
              Value
            </span>
            <span className="mt-1 block whitespace-nowrap text-xs font-bold tabular-nums text-slate-900 dark:text-white">
              {pricesHidden ? "—" : formatPKR(order.totalCents / 100)}
            </span>
          </span>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-slate-300 transition-transform duration-300",
              expanded && "rotate-180 text-indigo-500"
            )}
          />
        </button>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              id={`order-detail-breakdown-${order.id}`}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: "easeInOut" }}
              className="overflow-hidden"
            >
              <div className="mx-4 border-t border-slate-100 pb-4 pt-4 dark:border-slate-800">
                {(() => {
                  if (loading) {
                    return (
                  <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-slate-400">
                    <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                    <p className="text-[10px] font-bold uppercase tracking-wider">
                      Loading order details
                    </p>
                  </div>
                )
                  }
                  if (error) {
                    return (
                  <div className="flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl bg-rose-50/60 px-4 text-center dark:bg-rose-950/20">
                    <p className="text-xs font-semibold text-rose-600 dark:text-rose-300">
                      {error}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRetry}
                      className="h-8 rounded-xl border-rose-200 bg-white px-4 text-[10px] font-bold uppercase tracking-wider text-rose-600 hover:bg-rose-50 dark:border-rose-800 dark:bg-slate-950 dark:text-rose-300"
                    >
                      Try Again
                    </Button>
                  </div>
                )
                  }
                  if (details) {
                    return (
                  <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="min-w-0 rounded-2xl border border-indigo-100/60 bg-indigo-50/30 p-3 dark:border-indigo-900/40 dark:bg-indigo-950/20">
                        <h4 className="mb-3 text-[8px] font-bold uppercase tracking-widest text-indigo-500">
                          Customer Profile
                        </h4>
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-100 bg-white shadow-sm dark:border-indigo-900 dark:bg-slate-800">
                            <User className="h-4 w-4 text-indigo-500" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-[11px] font-semibold text-slate-900 dark:text-white">
                              {profileName}
                            </p>
                            {profilePhone && (
                              <p className="truncate text-[9px] font-medium text-slate-500">
                                {profilePhone}
                              </p>
                            )}
                            {details.creatorEmployeeId && (
                              <p className="mt-0.5 truncate font-mono text-[8px] font-black text-indigo-500">
                                #{details.creatorEmployeeId}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="min-w-0 rounded-2xl border border-slate-200/60 bg-slate-50/50 p-3 dark:border-slate-800/60 dark:bg-slate-950/50">
                        <h4 className="mb-3 text-[8px] font-bold uppercase tracking-widest text-slate-400">
                          Order Source
                        </h4>
                        <div className="space-y-2">
                          <div className="min-w-0">
                            <p className="mb-0.5 text-[8px] font-semibold uppercase text-slate-400">
                              Entity
                            </p>
                            <p className="truncate text-[10px] font-medium text-slate-900 dark:text-white">
                              {order.organizationName || `#${order.organizationId}`}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className="mb-0.5 text-[8px] font-semibold uppercase text-slate-400">
                              Point
                            </p>
                            <p className="truncate text-[10px] font-medium text-slate-900 dark:text-white">
                              {order.branchName || `#${order.branchId}`}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h4 className="text-[9px] font-bold uppercase tracking-widest text-indigo-500">
                        Transaction Breakdown
                      </h4>
                      <div className="overflow-hidden rounded-2xl border border-slate-200/60 bg-white/50 dark:border-slate-800/60 dark:bg-slate-900/50">
                        {(() => {
                          if (detailLines.length > 0) {
                            return (
                          <>
                            <div className="divide-y divide-slate-100 dark:divide-slate-800">
                              {detailLines.map((line) => (
                                <div
                                  key={line.id}
                                  className="flex items-start justify-between gap-3 p-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[11px] font-semibold leading-tight text-slate-900 dark:text-white">
                                      {line.productName}
                                    </p>
                                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                      <span className="font-mono text-[8px] font-semibold italic text-slate-400">
                                        {line.productCode || "N/A"}
                                      </span>
                                      <Badge
                                        variant="outline"
                                        className="h-4 border-slate-200 bg-slate-50 px-1.5 py-0 text-[7px] font-medium dark:border-slate-700 dark:bg-slate-800"
                                      >
                                        Qty: {formatQuantity(line.quantity)}
                                      </Badge>
                                      {Number(line.quantityRefunded || 0) > 0 && (
                                        <Badge
                                          variant="outline"
                                          className="h-4 border-rose-200 bg-rose-50 px-1.5 py-0 text-[7px] font-medium text-rose-600 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300"
                                        >
                                          Refunded: {formatQuantity(line.quantityRefunded)}
                                        </Badge>
                                      )}
                                    </div>
                                  </div>
                                  {!pricesHidden && line.priceCents !== null && (
                                    <div className="shrink-0 text-right">
                                      <p className="text-[11px] font-bold text-slate-900 dark:text-white">
                                        {formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)}
                                      </p>
                                      <p className="mt-1 text-[8px] font-medium text-slate-400">
                                        @ {formatPKR(line.priceCents / 100)}
                                      </p>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                            <div className="border-t border-slate-100 bg-slate-50/80 p-3 dark:border-slate-800 dark:bg-slate-800/50">
                              <div className="flex items-center justify-between gap-3 text-[8px] font-bold uppercase tracking-widest text-slate-400">
                                <span>Order Summary</span>
                                <span className="text-right text-slate-600 dark:text-slate-400">
                                  {detailLines.length} {detailLines.length === 1 ? "Product" : "Products"} ·{" "}
                                  {formatQuantity(
                                    detailLines.reduce(
                                      (total, line) => total + Number(line.quantity || 0),
                                      0
                                    )
                                  )}{" "}
                                  Units
                                </span>
                              </div>
                            </div>
                          </>
                        )
                          }
                          return (
                          <p className="p-6 text-center text-[10px] font-medium text-slate-400">
                            No product lines are available for this order.
                          </p>
                        )
                        })()}
                      </div>
                    </div>
                  </div>
                )
                  }
                  return null
                })()}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

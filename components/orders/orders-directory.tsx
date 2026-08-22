"use client"

import { useEffect,useState } from "react"
import { useRouter } from "next/navigation"
import { motion,AnimatePresence } from "framer-motion"
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
  Calendar as CalendarIcon,CreditCard,
  Building,
  AlertTriangle,
  FileCheck,Copy,
  Send,
  Truck,
  Banknote,
  ChevronDown,
  Loader2,
  User
} from "lucide-react"
import { format } from "date-fns"
import { toast } from "@/hooks/use-toast"
import { cn,formatPKR } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
import {
  OrderDetailPanel,
  getFulfillmentProgressColor,
  getPaymentStatusColor,
  getStatusColor,
  type OrderDetails,
} from "@/components/orders/order-detail-panel"
import { ColumnSelector,type ColumnDef,useColumnSelector } from "@/components/reports/column-selector"
import { isInvoiceAvailableForOrder } from "@/lib/invoice-availability"
import { getOrderDerivedStatus,hasPartialRefund,type DerivedOrderStatusKey,type OrderStatusContext } from "@/lib/order-status"
import { calculateLineCents,formatQuantity } from "@/lib/quantity"
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
import {
  getOrderStatusDisplay,
  shouldShowOrderFulfillmentStatus,
  shouldShowOrderPaymentStatus,
} from "@/lib/order-status-display"

type OrderTableColumn = ColumnDef & { width: number }

const ORDER_TABLE_COLUMNS: OrderTableColumn[] = [
  { key: "tid", label: "TID", width: 190 },
  { key: "branch", label: "Branch", width: 190 },
  { key: "costCenter", label: "Cost Center", width: 125 },
  { key: "orderStatus", label: "Order Status", width: 150 },
  { key: "progress", label: "Progress", width: 150 },
  { key: "paymentStatus", label: "Payment", width: 120 },
  { key: "refundStatus", label: "Refund", width: 150 },
  { key: "orderDate", label: "Order Date", width: 135 },
  { key: "approvalDate", label: "Approval Date", width: 140 },
  { key: "deliveryDate", label: "Delivery Date", width: 140 },
  { key: "amount", label: "Amount", width: 125 },
]

type OrdersDirectoryProps = {
  orders: any[]
  statusContext?: OrderStatusContext
  userRole: string | undefined
  isSuperAdmin: boolean
  isBranchAdmin: boolean
  isHeadOffice?: boolean
  canDecideOrders?: boolean
  showCostCenterId?: boolean
  pricesHidden?: boolean
  onUpdate: () => void
}

function EmptyOrdersState({ compact = false }: Readonly<{ compact?: boolean }>) {
  return (
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
}

export function OrdersDirectory({
  orders,
  statusContext = "default",
  userRole,
  isSuperAdmin,
  isBranchAdmin,
  isHeadOffice,
  canDecideOrders = false,
  showCostCenterId,
  pricesHidden = false,
  onUpdate
}: Readonly<OrdersDirectoryProps>) {
  const router = useRouter()
  const [viewMode, setViewMode] = useState<"grid" | "table">("table")
  const [viewingOrder, setViewingOrder] = useState<any>(null)

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
  const [isOrderDetailsExpanded, setIsOrderDetailsExpanded] = useState(false)
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null)
  const [isOrderDetailsLoading, setIsOrderDetailsLoading] = useState(false)
  const [orderDetailsError, setOrderDetailsError] = useState<string | null>(null)
  const [orderDetailsRequestKey, setOrderDetailsRequestKey] = useState(0)
  const viewingOrderId = viewingOrder?.id
  const shouldShowCostCenterId = showCostCenterId ?? orders.some((order) => Boolean(order.branchCostCenterId))
  const { visibleKeys, isVisible, setVisibleKeys } = useColumnSelector(
    ORDER_TABLE_COLUMNS,
    "orders-directory-table-v1",
  )
  const availableTableColumns = ORDER_TABLE_COLUMNS.filter((column) => {
    if (column.key === "costCenter") return shouldShowCostCenterId
    if (column.key === "amount") return !pricesHidden
    return true
  })
  const availableTableColumnKeys = new Set(availableTableColumns.map((column) => column.key))
  const selectedTableColumns = availableTableColumns.filter((column) => isVisible(column.key))
  const selectedTableColumnKeys = selectedTableColumns.map((column) => column.key)
  const tableMinWidth = Math.max(
    720,
    selectedTableColumns.reduce((total, column) => total + column.width, 0),
  )
  const isTableColumnVisible = (key: string) => availableTableColumnKeys.has(key) && isVisible(key)
  const setSelectedTableColumns = (nextKeys: string[]) => {
    const unavailableKeys = visibleKeys.filter((key) => !availableTableColumnKeys.has(key))
    setVisibleKeys([...unavailableKeys, ...nextKeys])
  }

  useEffect(() => {
    setIsOrderDetailsExpanded(false)
    setOrderDetails(null)
    setOrderDetailsError(null)
    setIsOrderDetailsLoading(false)
    setOrderDetailsRequestKey(0)
  }, [viewingOrderId])

  useEffect(() => {
    if (
      !isOrderDetailsExpanded ||
      viewingOrderId === null ||
      viewingOrderId === undefined ||
      orderDetails?.id === viewingOrderId
    ) {
      return
    }

    const controller = new AbortController()
    let isCurrentRequest = true

    const loadOrderDetails = async () => {
      setIsOrderDetailsLoading(true)
      setOrderDetailsError(null)

      try {
        const response = await fetch(`/api/v1/orders/${viewingOrderId}`, {
          signal: controller.signal,
        })
        const data = await response.json().catch(() => ({}))

        if (!response.ok) {
          throw new Error(data.error || "Unable to load order details")
        }
        if (!data.item) {
          throw new Error("Order details are unavailable")
        }

        if (isCurrentRequest) {
          setOrderDetails(data.item)
        }
      } catch (error: any) {
        if (error?.name !== "AbortError" && isCurrentRequest) {
          setOrderDetailsError(error?.message || "Unable to load order details")
        }
      } finally {
        if (isCurrentRequest) {
          setIsOrderDetailsLoading(false)
        }
      }
    }

    loadOrderDetails()

    return () => {
      isCurrentRequest = false
      controller.abort()
    }
  }, [
    isOrderDetailsExpanded,
    orderDetails?.id,
    orderDetailsRequestKey,
    viewingOrderId,
  ])

  const openFullDetails = (order: any) => {
    router.push(`/orders/${order.id}#refund-details`)
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

      if (actionType === "approve" && canDecideOrders && (data.fulfillmentToken || data.approvalToken)) {
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
    <div className="min-w-0 max-w-full space-y-4">
      {/* Directory Tools */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-2">
        <div className="flex items-center gap-2 text-sm text-slate-500 font-medium">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-white dark:bg-slate-800 text-[10px] shadow-sm text-slate-600 dark:text-slate-400">
            {orders.length}
          </span>
          <span>Orders visible</span>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {viewMode === "table" && (
            <ColumnSelector
              columns={availableTableColumns}
              storageKey="orders-directory-table-v1"
              visibleKeys={selectedTableColumnKeys}
              onChange={setSelectedTableColumns}
            />
          )}
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900">
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
      </div>

      <AnimatePresence mode="wait">
        {(() => {
          if (viewMode === "grid") {
            return (
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
                    {shouldShowOrderFulfillmentStatus(order) && (
                      <Badge
                        variant="outline"
                        className={cn("max-w-full whitespace-normal break-words rounded-lg border px-2 py-0.5 text-right text-[9px] font-bold uppercase leading-tight tracking-wider", getFulfillmentProgressColor(order.fulfillmentStatus))}
                      >
                        {FULFILLMENT_STATUS_LABELS[normalizeFulfillmentStatus(order.fulfillmentStatus)]}
                      </Badge>
                    )}
                    {shouldShowOrderPaymentStatus(order) && (
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
        )
          }
          return (
          <motion.div
            key="table"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="w-full min-w-0 max-w-full overflow-x-auto rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <table
              className="w-full table-fixed text-sm"
              style={{ minWidth: `${tableMinWidth}px` }}
            >
              <colgroup>
                {selectedTableColumns.map((column) => (
                  <col key={column.key} style={{ width: `${column.width}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-slate-800 dark:bg-slate-800/50">
                  {isTableColumnVisible("tid") && <th className="h-14 whitespace-nowrap py-3 pl-6 pr-4 text-left font-bold">TID</th>}
                  {isTableColumnVisible("branch") && <th className="h-14 whitespace-nowrap px-4 py-3 text-left font-bold">Branch</th>}
                  {isTableColumnVisible("costCenter") && <th className="h-14 whitespace-nowrap px-4 py-3 text-left font-bold">Cost Center</th>}
                  {isTableColumnVisible("orderStatus") && <th className="h-14 whitespace-nowrap px-4 py-3 text-center font-bold">Order Status</th>}
                  {isTableColumnVisible("progress") && <th className="h-14 whitespace-nowrap px-4 py-3 text-center font-bold">Progress</th>}
                  {isTableColumnVisible("paymentStatus") && <th className="h-14 whitespace-nowrap px-4 py-3 text-center font-bold">Payment</th>}
                  {isTableColumnVisible("refundStatus") && <th className="h-14 whitespace-nowrap px-4 py-3 text-center font-bold">Refund</th>}
                  {isTableColumnVisible("orderDate") && <th className="h-14 whitespace-nowrap px-4 py-3 text-left font-bold">Order Date</th>}
                  {isTableColumnVisible("approvalDate") && <th className="h-14 whitespace-nowrap px-4 py-3 text-left font-bold">Approval Date</th>}
                  {isTableColumnVisible("deliveryDate") && <th className="h-14 whitespace-nowrap px-4 py-3 text-left font-bold">Delivery Date</th>}
                  {isTableColumnVisible("amount") && <th className="h-14 whitespace-nowrap py-3 pl-4 pr-6 text-right font-bold">Amount</th>}
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => {
                  const statusDisplay = getOrderStatusDisplay(order, statusContext)
                  const derivedStatus = statusDisplay.orderStatus
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
                      {isTableColumnVisible("tid") && <td className="py-5 pl-6 pr-4">
                        <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-300 group-hover:text-indigo-600 transition-colors uppercase tracking-wider">{order.tid}</span>
                      </td>}
                      {isTableColumnVisible("branch") && <td className="px-4 py-5">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-3.5 w-3.5 shrink-0 text-indigo-500 opacity-60" />
                          <span className="truncate font-medium text-slate-600 dark:text-slate-400" title={order.branchName || `#${order.branchId}`}>
                            {order.branchName || `#${order.branchId}`}
                          </span>
                        </div>
                      </td>}
                      {isTableColumnVisible("costCenter") && (
                        <td className="px-4 py-5">
                          <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                            {order.branchCostCenterId || "-"}
                          </span>
                        </td>
                      )}
                      {isTableColumnVisible("orderStatus") && <td className="px-4 py-5 text-center">
                        <Badge variant="outline" className={cn("px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-lg border", statusColors.bg, statusColors.text, statusColors.border)}>
                          {derivedStatus.label}
                        </Badge>
                      </td>}
                      {isTableColumnVisible("progress") && <td className="px-4 py-5 text-center">
                        {statusDisplay.fulfillmentStatus ? (
                          <Badge variant="outline" className={cn("px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getFulfillmentProgressColor(order.fulfillmentStatus))}>
                            {statusDisplay.fulfillmentStatus}
                          </Badge>
                        ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>}
                      {isTableColumnVisible("paymentStatus") && <td className="px-4 py-5 text-center">
                        {statusDisplay.paymentStatus ? (
                          <Badge variant="outline" className={cn("px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getPaymentStatusColor(order.paymentStatus))}>
                            {statusDisplay.paymentStatus}
                          </Badge>
                        ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>}
                      {isTableColumnVisible("refundStatus") && <td className="px-4 py-5 text-center">
                        {(() => {
                          if (statusDisplay.refundStatus) {
                            return (
                          <Badge
                            variant="outline"
                            className={cn(
                              "px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border",
                              statusDisplay.refundStatus === "Partial Refund"
                                ? "border-amber-300 bg-amber-50 text-amber-600 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                                : "border-rose-300 bg-rose-50 text-rose-600 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
                            )}
                          >
                            {statusDisplay.refundStatus}
                          </Badge>
                        )
                          }
                          return <span className="text-slate-300 dark:text-slate-600">—</span>
                        })()}
                      </td>}
                      {isTableColumnVisible("orderDate") && <td className="whitespace-nowrap px-4 py-5 text-xs font-medium text-slate-500">
                        {format(new Date(order.createdAt), "dd MMM yyyy")}
                      </td>}
                      {isTableColumnVisible("approvalDate") && <td className="whitespace-nowrap px-4 py-5 text-xs font-medium text-slate-500">
                        {order.approvedAt ? format(new Date(order.approvedAt), "dd MMM yyyy") : "—"}
                      </td>}
                      {isTableColumnVisible("deliveryDate") && <td className="whitespace-nowrap px-4 py-5 text-xs font-medium text-slate-500">
                        {order.deliveredAt ? format(new Date(order.deliveredAt), "dd MMM yyyy") : "—"}
                      </td>}
                      {isTableColumnVisible("amount") && <td className="whitespace-nowrap py-5 pl-4 pr-6 text-right font-bold text-slate-800 dark:text-slate-200">
                        {order.totalCents !== null && order.totalCents !== undefined ? formatPKR(order.totalCents / 100) : "-"}
                      </td>}
                    </motion.tr>
                  )
                })}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={Math.max(selectedTableColumns.length, 1)}>
                      <EmptyOrdersState compact />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </motion.div>
        )
        })()}
      </AnimatePresence>

      {/* Spatial Detail Drawer (Order Action Sheet) - Adorable Theme */}
      <Sheet open={!!viewingOrder && !actionType} onOpenChange={(open) => !open && setViewingOrder(null)}>
        <SheetContent className="w-full sm:max-w-md border-l-0 shadow-[0_0_50px_rgba(0,0,0,0.1)] p-0 bg-[#fdfdfd] dark:bg-[#0b0f19] overflow-y-auto">
          <SheetHeader className="sr-only p-0">
            <SheetTitle>Order details</SheetTitle>
            <SheetDescription>
              {viewingOrder
                ? `Review status, branch information, line items, and available actions for order ${viewingOrder.tid}.`
                : "Review the order status, branch information, line items, and available actions."}
            </SheetDescription>
          </SheetHeader>
          {viewingOrder && (
            <OrderDetailPanel
              order={viewingOrder}
              statusContext={statusContext}
              isSuperAdmin={isSuperAdmin}
              showFulfillmentToken={canDecideOrders}
              details={orderDetails?.id === viewingOrder.id ? orderDetails : null}
              detailsExpanded={isOrderDetailsExpanded}
              detailsLoading={isOrderDetailsLoading}
              detailsError={orderDetailsError}
              onToggleDetails={() => setIsOrderDetailsExpanded((expanded) => !expanded)}
              onRetryDetails={() => setOrderDetailsRequestKey((key) => key + 1)}
              onSendToken={sendTokenToAdmin}
              isSendingToken={isSendingTokenEmail}
              actions={(() => {
                const isRefundRelated =
                  viewingOrder.status?.toLowerCase() === "refunded" ||
                  Number(viewingOrder.refundAmountCents || 0) > 0

                return (
              /* Cute Action Footer */
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

                {isSuperAdmin &&
                  viewingOrder.status?.toLowerCase() === "fulfilled" &&
                  normalizeFulfillmentStatus(viewingOrder.fulfillmentStatus) === "DELIVERED" &&
                  shouldShowOrderPaymentStatus(viewingOrder) && (
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
                        {(() => {
                          if (isUpdatingPayment) {
                            return "Updating..."
                          }
                          if (isPaid) {
                            return "Mark as Unpaid"
                          }
                          return "Mark as Paid"
                        })()}
                      </Button>
                    )
                  })()
                )}

                {isInvoiceAvailableForOrder(viewingOrder) && (
                  <div className="flex bg-slate-50 hover:bg-slate-100 dark:bg-slate-800 dark:hover:bg-slate-700 h-14 rounded-2xl justify-center items-center border border-dashed border-slate-200 dark:border-slate-700 transition-colors">
                    <ReceiptIconButton
                      orderId={viewingOrder.id}
                      orderStatus={viewingOrder.status}
                      statusAtRefund={viewingOrder.statusAtRefund}
                    />
                  </div>
                )}

                <div className="flex gap-3">
                  {viewingOrder.status.toLowerCase() === "pending" && canDecideOrders && (
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
                        return (() => {
                          if (nextStatus) {
                            return (
                          <Button
                            type="button"
                            disabled={isUpdatingProgress}
                            onClick={() => updateFulfillmentProgress(nextStatus)}
                            className="w-full h-12 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold shadow-lg shadow-sky-600/20"
                          >
                            <Truck className={cn("mr-2 h-4 w-4", isUpdatingProgress && "animate-pulse")} />
                            {isUpdatingProgress ? "Updating..." : `Mark ${FULFILLMENT_STATUS_LABELS[nextStatus]}`}
                          </Button>
                        )
                          }
                          return null
                        })()
                      })()}
                      <Button onClick={() => setActionType("fulfill")} className="w-full h-12 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-600/20">
                        <CheckCircle className="mr-2 h-4 w-4" />
                        Fulfill Order
                      </Button>
                    </div>
                  )}
                </div>
              </div>
                )
              })()}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Action Dialogs (Replacing the old ones) */}
      <Dialog open={!!actionType} onOpenChange={(open) => !open && setActionType(null)}>
        <DialogContent className="max-w-md border-0 shadow-2xl bg-white/90 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2rem]">
          <DialogHeader>
            <DialogTitle className="text-xl font-black tracking-tight flex items-center gap-2">
              {actionType === 'reject' && <XCircle className="text-rose-500 h-6 w-6" />}
              {actionType === 'approve' && <CheckCircle className="text-emerald-500 h-6 w-6" />}
              {actionType === 'fulfill' && <Package className="text-indigo-500 h-6 w-6" />}
              {actionType === "reject" && "Reject Order"}
              {actionType === "approve" && "Approve Order"}
              {actionType === "fulfill" && "Fulfill Order"}
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
                    Enter the approval token provided by the organization approver to verify this fulfillment.
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
                (() => {
                  if (actionType === 'reject') {
                    return "bg-rose-600 hover:bg-rose-500 shadow-rose-600/20"
                  }
                  if (actionType === 'approve') {
                    return "bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/20"
                  }
                  return "bg-indigo-600 hover:bg-indigo-500 shadow-indigo-600/20"
                })()
              )}
            >
              {isProcessing ? "Processing..." : `Confirm ${actionType}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Success token dialog for the organization's configured approver. */}
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


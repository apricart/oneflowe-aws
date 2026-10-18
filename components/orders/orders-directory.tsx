"use client"

import { useEffect,useState } from "react"
import { useRouter } from "next/navigation"
import { motion,AnimatePresence } from "framer-motion"
import {
  Package,
  CheckCircle,
  XCircle,
  TrendingDown,
  LayoutGrid,
  List,
  Building2,
  Calendar as CalendarIcon,
  Copy,
  Send,
  Truck,
  Banknote,
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
  getStatusColor,
  type OrderDetails,
} from "@/components/orders/order-detail-panel"
import { getFulfillmentProgressColor, getPaymentStatusColor } from "@/lib/order-status-colors"
import { ColumnSelector,type ColumnDef,useColumnSelector } from "@/components/reports/column-selector"
import { SortableHeader,ariaSortFor } from "@/components/reports/sortable-header"
import type { OrderListSortKey } from "@/lib/list-sort-keys"
import type { SortDirection,SortState } from "@/lib/table-sort"
import { isInvoiceAvailableForOrder } from "@/lib/invoice-availability"
import { getOrderDerivedStatus,hasPartialRefund,type OrderStatusContext } from "@/lib/order-status"
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
import { isUnacknowledgedDelivery } from "@/lib/unacknowledged-delivery-block"
import { isAwaitingCorrection } from "@/lib/order-correction"
import { OrderCorrectionNotice, ReturnForCorrectionDialog } from "@/components/orders/order-correction"
import { DeliveryChallanUploadDialog } from "@/components/orders/delivery-challan"
import { InvoiceStatusBadge } from "@/components/orders/invoice-status-badge"
import { TOKEN_SENT_LABEL, isTokenAlreadySent, readTokenSendRefusal } from "@/lib/order-token-handoff"
import {
  DELIVERED_UNFULFILLED_LABEL,
  orderRowFulfilmentAction,
} from "@/lib/unacknowledged-orders"

type OrderTableColumn = ColumnDef & { width: number }

const ORDER_TABLE_COLUMNS: OrderTableColumn[] = [
  { key: "id", label: "Order ID", width: 96 },
  { key: "tid", label: "Transaction ID", width: 224 },
  { key: "organization", label: "Organization", width: 176 },
  { key: "branch", label: "Branch", width: 160 },
  { key: "costCenter", label: "Cost Center", width: 104 },
  { key: "partialDelivery", label: "Partial Delivery", width: 128 },
  { key: "orderStatus", label: "Order Status", width: 152 },
  { key: "progress", label: "Progress", width: 140 },
  { key: "paymentStatus", label: "Payment", width: 108 },
  { key: "refundStatus", label: "Refund", width: 128 },
  { key: "orderDate", label: "Order Date", width: 112 },
  { key: "approvalDate", label: "Approval Date", width: 120 },
  { key: "deliveryDate", label: "Delivery Date", width: 120 },
  { key: "invoiceStatus", label: "Invoice Status", width: 148 },
  { key: "amount", label: "Amount", width: 120 },
]

/**
 * Operational roles can hand a fulfillment token to admin operations from
 * these two pinned columns once the scoped API returns that token. Super Admin
 * deliberately does not render either column; it keeps its verification flow.
 */
const TOKEN_COLUMN_WIDTH = 180
const ACTION_COLUMN_WIDTH = 150
const PARTIAL_DELIVERY_STATUSES = new Set(["PARTIAL", "PARTIALLY_FULFILLED"])

function isPartialDelivery(order: { partialDelivery?: boolean; status?: string | null }): boolean {
  return order.partialDelivery
    ?? PARTIAL_DELIVERY_STATUSES.has(String(order.status || "").trim().toUpperCase())
}

/** Numbers and dates show the largest or newest first on the first click. */
const DESC_FIRST_SORT_KEYS = new Set<OrderListSortKey>(["id", "orderDate", "approvalDate", "deliveryDate", "amount"])
const PINNED_CELL_CLASS = "sticky z-10 bg-white group-hover:bg-slate-50 dark:bg-slate-900 dark:group-hover:bg-slate-800"
/**
 * The table scrolls inside a bounded box so its horizontal scrollbar stays in
 * view; the header row sticks to the top of that box while the body scrolls.
 */
const HEAD_CELL_CLASS = "sticky top-0 z-20 bg-slate-50 shadow-[inset_0_-1px_0_var(--color-slate-200)] dark:bg-slate-800 dark:shadow-[inset_0_-1px_0_var(--color-slate-700)]"
const PINNED_HEAD_CLASS = "sticky top-0 z-30 bg-slate-50 shadow-[inset_0_-1px_0_var(--color-slate-200)] dark:bg-slate-800 dark:shadow-[inset_0_-1px_0_var(--color-slate-700)]"

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
  /**
   * The server-side sort of the list (`GET /api/v1/orders?sort=&dir=`). Without
   * `onSort` the headers are plain labels.
   */
  sort?: SortState<OrderListSortKey>
  onSort?: (key: OrderListSortKey, firstDirection?: SortDirection) => void
  onUpdate: () => void
}

/**
 * Marks an order Apricart's Order Desk entered. An Apricart Executive approves
 * it; the tenant's approvers see it but cannot decide it, and the decision
 * routes refuse them (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
 */
/**
 * The approval level a pending order waits at, for an organization that uses
 * levels. Nothing is drawn for any other order.
 */
function ApprovalLevelBadge({ order }: Readonly<{ order: { approvalLevel?: number | null; status?: string } }>) {
  if (!order.approvalLevel || order.status?.toLowerCase() !== "pending") return null
  return (
    <Badge
      variant="outline"
      title={`Only a Level ${order.approvalLevel} approver at this branch can decide this order`}
      className="mt-1 rounded-lg border border-violet-200 bg-violet-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300"
    >
      Level {order.approvalLevel} approval
    </Badge>
  )
}

function ApricartOrderBadge({ pending }: Readonly<{ pending: boolean }>) {
  return (
    <Badge
      variant="outline"
      title={pending ? "Entered by Apricart's Order Desk; an Apricart Executive approves it" : "Entered by Apricart's Order Desk"}
      className="mt-1 rounded-lg border border-sky-200 bg-sky-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
    >
      {pending ? "Awaiting Apricart approval" : "Apricart Order Desk"}
    </Badge>
  )
}

/**
 * Marks an order that reached this branch through a Group Order Portal
 * submission. It is an ordinary branch order in every other respect — the badge
 * exists so an administrator can tell at a glance why an order they did not
 * expect is on their branch's list.
 */
function GroupOrderBadge() {
  return (
    <Badge
      variant="outline"
      title="Raised for this branch through the Group Order Initiator Portal"
      className="mt-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-indigo-600 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-400"
    >
      Group Order
    </Badge>
  )
}

/**
 * Marks an active order whose goods have arrived but which has not been
 * fulfilled yet — the same rule the ordering block and the dashboard's
 * "Delivered/Unacknowledged" figure use.
 */
function DeliveredUnfulfilledBadge() {
  return (
    <Badge
      variant="outline"
      title="Delivered to the branch, not yet fulfilled"
      className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
    >
      {DELIVERED_UNFULFILLED_LABEL}
    </Badge>
  )
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
  sort = null,
  onSort,
  onUpdate
}: Readonly<OrdersDirectoryProps>) {
  const router = useRouter()
  const [viewMode, setViewMode] = useState<"grid" | "table">("table")
  const [viewingOrder, setViewingOrder] = useState<any>(null)
  // An Order Desk entry is an Apricart Executive's to decide, never the tenant's;
  // an order waiting at an approval level this reader does not hold is that
  // level's holders' (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md).
  const canDecideViewingOrder = canDecideOrders
    && !viewingOrder?.decidedByApricart
    && !viewingOrder?.levelDecisionLocked

  // Modals for actions
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(null)
  const [generatedToken, setGeneratedToken] = useState<string | null>(null)
  const [showTokenDialog, setShowTokenDialog] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [returningOrder, setReturningOrder] = useState<{ id: number; tid: string } | null>(null)
  // The order whose delivery is waiting on its challan upload.
  const [challanOrder, setChallanOrder] = useState<{ id: number; tid: string } | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isUpdatingProgress, setIsUpdatingProgress] = useState(false)
  const [isUpdatingPayment, setIsUpdatingPayment] = useState(false)
  /** The order whose token is being emailed; one at a time, from the row or the drawer. */
  const [sendingTokenOrderId, setSendingTokenOrderId] = useState<number | null>(null)
  const [isOrderDetailsExpanded, setIsOrderDetailsExpanded] = useState(false)
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null)
  const [isOrderDetailsLoading, setIsOrderDetailsLoading] = useState(false)
  const [orderDetailsError, setOrderDetailsError] = useState<string | null>(null)
  const [orderDetailsRequestKey, setOrderDetailsRequestKey] = useState(0)
  const viewingOrderId = viewingOrder?.id
  const showOrganizationColumn = isSuperAdmin && userRole === "SUPER_ADMIN"
  const viewingOrderCanHandoffToken = !isSuperAdmin
    && String(viewingOrder?.status ?? "").trim().toUpperCase() === "APPROVED"
    && typeof viewingOrder?.approvalToken === "string"
    && viewingOrder.approvalToken.trim().length > 0
  const shouldShowCostCenterId = showCostCenterId ?? orders.some((order) => Boolean(order.branchCostCenterId))
  const { visibleKeys, isVisible, setVisibleKeys } = useColumnSelector(
    ORDER_TABLE_COLUMNS,
    "orders-directory-table-v1",
  )
  const availableTableColumns = ORDER_TABLE_COLUMNS.filter((column) => {
    if (column.key === "organization") return showOrganizationColumn
    if (column.key === "costCenter") return shouldShowCostCenterId
    if (column.key === "amount") return !pricesHidden
    return true
  })
  const availableTableColumnKeys = new Set(availableTableColumns.map((column) => column.key))
  const selectedTableColumns = availableTableColumns.filter((column) => isVisible(column.key))
  const selectedTableColumnKeys = selectedTableColumns.map((column) => column.key)
  const showFulfillmentColumns = !isSuperAdmin
  const fulfillmentColumnsWidth = showFulfillmentColumns
    ? TOKEN_COLUMN_WIDTH + ACTION_COLUMN_WIDTH
    : 0
  const tableMinWidth = Math.max(
    720,
    selectedTableColumns.reduce((total, column) => total + column.width, 0),
  ) + fulfillmentColumnsWidth
  const isTableColumnVisible = (key: string) => availableTableColumnKeys.has(key) && isVisible(key)
  const sortLabel = (key: OrderListSortKey, label: string) => (onSort
    ? <SortableHeader label={label} sortKey={key} sort={sort} onSort={onSort} firstDirection={DESC_FIRST_SORT_KEYS.has(key) ? "desc" : "asc"} />
    : label)
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

    void loadOrderDetails()

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

  /**
   * Record one step of delivery progress. Delivered needs the uploaded
   * challan's id; the server refuses it without one. Throws on refusal so the
   * caller decides how to show it.
   */
  const postFulfillmentProgress = async (order: any, nextStatus: FulfillmentStatus, deliveryChallanId?: number) => {
    const res = await fetch(`/api/v1/orders/${order.id}/fulfillment-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fulfillmentStatus: nextStatus,
        ...(deliveryChallanId === undefined ? {} : { deliveryChallanId }),
      }),
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
      ...order,
      fulfillmentStatus: data.item?.fulfillmentStatus || nextStatus,
      // Recording delivery settles an order whose fulfilment token has
      // already reached the admin, so the order status is taken from the
      // server rather than assumed to be unchanged.
      status: data.item?.status || order.status,
    }
    setViewingOrder(updatedOrder)
    toast({
      title: data?.fulfilled ? "Delivered — order fulfilled" : "Progress updated",
      description: data?.fulfilled
        ? `Order marked ${FULFILLMENT_STATUS_LABELS[nextStatus]}. Its fulfilment token was already sent to the admin, so the order is now fulfilled.`
        : `Order marked ${FULFILLMENT_STATUS_LABELS[nextStatus]}.`,
    })
    onUpdate()
  }

  /** Delivered goes through the challan dialog; every earlier step posts directly. */
  const requestFulfillmentProgress = (nextStatus: FulfillmentStatus) => {
    if (!viewingOrder) return
    if (nextStatus === "DELIVERED") {
      setChallanOrder({ id: viewingOrder.id, tid: viewingOrder.tid })
      return
    }
    void updateFulfillmentProgress(nextStatus)
  }

  const updateFulfillmentProgress = async (nextStatus: FulfillmentStatus) => {
    if (!viewingOrder) return

    setIsUpdatingProgress(true)
    try {
      await postFulfillmentProgress(viewingOrder, nextStatus)
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

  const closeActionDialog = () => {
    setActionType(null)
  }

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token)
      toast({ title: "Copied", description: "Fulfillment token copied to clipboard." })
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy the fulfillment token. Please select and copy it manually.",
        variant: "destructive",
      })
    }
  }

  const sendTokenToAdmin = async (order: any) => {
    if (!order || isTokenAlreadySent(order.tokenHandoffAt) || sendingTokenOrderId !== null) return

    setSendingTokenOrderId(order.id)
    try {
      const res = await fetch(`/api/v1/orders/${order.id}/send-token-email`, {
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

      // A refusal that only means this screen is out of date — the token has
      // already gone, or the order is no longer approved — corrects the panel
      // and refreshes the list rather than reporting a failure.
      const refusal = readTokenSendRefusal(res.status, data)
      if (refusal?.kind === "not-approved") {
        setViewingOrder((current: any) => (
          current?.id === order.id && refusal.status ? { ...current, status: refusal.status } : current
        ))
        toast({ title: "Order already updated", description: refusal.message })
        onUpdate()
        return
      }
      const alreadySent = refusal?.kind === "already-sent"
      if (!res.ok && !alreadySent) throw new Error(data.error || "Failed to send token email")

      toast(alreadySent
        ? { title: TOKEN_SENT_LABEL, description: refusal.message }
        : {
            title: data?.fulfilled ? "Token sent — order fulfilled" : "Token sent",
            description: data?.message || "Fulfillment token emailed to the admin.",
          })

      // The hand-off settles the order only once it has been delivered, so the
      // open panel shows FULFILLED only when it actually did. The list is
      // refreshed either way, so the order now shows its token as sent.
      const sentAt = new Date().toISOString()
      setViewingOrder((current: any) => (
        current?.id === order.id
          ? {
              ...current,
              tokenHandoffAt: current.tokenHandoffAt ?? sentAt,
              ...(data?.fulfilled ? { status: "FULFILLED" } : {}),
            }
          : current
      ))
      onUpdate()
    } catch (err: any) {
      toast({
        title: "Email Failed",
        description: err.message,
        variant: "destructive",
      })
    } finally {
      setSendingTokenOrderId(null)
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
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Transaction ID</p>
                      <p className="truncate font-mono text-sm font-bold text-slate-800 dark:text-slate-100">{order.tid}</p>
                      <p className="text-[10px] font-medium text-slate-500 dark:text-slate-400">
                        Order ID <span className="font-mono">#{order.id}</span>
                      </p>
                      {order.placedByGroupPortal && <GroupOrderBadge />}
                      {order.decidedByApricart && <ApricartOrderBadge pending={order.status?.toLowerCase() === "pending"} />}
                      <ApprovalLevelBadge order={order} />
                      {isUnacknowledgedDelivery(order) && <DeliveredUnfulfilledBadge />}
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
            data-testid="orders-table-scroll"
            className="orders-table-scrollbar max-h-[max(24rem,calc(100dvh-12rem))] w-full min-w-0 max-w-full rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
          >
            <table
              className="w-full table-fixed text-sm"
              style={{ minWidth: `${tableMinWidth}px` }}
            >
              <colgroup>
                {selectedTableColumns.map((column) => (
                  <col key={column.key} style={{ width: `${column.width}px` }} />
                ))}
                {showFulfillmentColumns && (
                  <>
                    <col style={{ width: `${TOKEN_COLUMN_WIDTH}px` }} />
                    <col style={{ width: `${ACTION_COLUMN_WIDTH}px` }} />
                  </>
                )}
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:border-slate-800">
                  {isTableColumnVisible("id") && <th aria-sort={ariaSortFor(sort, "id")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap py-2.5 pl-5 pr-3 text-left font-bold")}>{sortLabel("id", "Order ID")}</th>}
                  {isTableColumnVisible("tid") && <th aria-sort={ariaSortFor(sort, "tid")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("tid", "Transaction ID")}</th>}
                  {isTableColumnVisible("organization") && <th className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>Organization</th>}
                  {isTableColumnVisible("branch") && <th aria-sort={ariaSortFor(sort, "branch")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("branch", "Branch")}</th>}
                  {isTableColumnVisible("costCenter") && <th aria-sort={ariaSortFor(sort, "costCenter")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("costCenter", "Cost Center")}</th>}
                  {isTableColumnVisible("partialDelivery") && <th className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>Partial Delivery</th>}
                  {isTableColumnVisible("orderStatus") && <th aria-sort={ariaSortFor(sort, "orderStatus")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>{sortLabel("orderStatus", "Order Status")}</th>}
                  {isTableColumnVisible("progress") && <th aria-sort={ariaSortFor(sort, "progress")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>{sortLabel("progress", "Progress")}</th>}
                  {isTableColumnVisible("paymentStatus") && <th aria-sort={ariaSortFor(sort, "paymentStatus")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>{sortLabel("paymentStatus", "Payment")}</th>}
                  {isTableColumnVisible("refundStatus") && <th aria-sort={ariaSortFor(sort, "refundStatus")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>{sortLabel("refundStatus", "Refund")}</th>}
                  {isTableColumnVisible("orderDate") && <th aria-sort={ariaSortFor(sort, "orderDate")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("orderDate", "Order Date")}</th>}
                  {isTableColumnVisible("approvalDate") && <th aria-sort={ariaSortFor(sort, "approvalDate")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("approvalDate", "Approval Date")}</th>}
                  {isTableColumnVisible("deliveryDate") && <th aria-sort={ariaSortFor(sort, "deliveryDate")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-left font-bold")}>{sortLabel("deliveryDate", "Delivery Date")}</th>}
                  {isTableColumnVisible("invoiceStatus") && <th aria-sort={ariaSortFor(sort, "invoiceStatus")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap px-3 py-2.5 text-center font-bold")}>{sortLabel("invoiceStatus", "Invoice Status")}</th>}
                  {isTableColumnVisible("amount") && <th aria-sort={ariaSortFor(sort, "amount")} className={cn(HEAD_CELL_CLASS, "h-11 whitespace-nowrap py-2.5 pl-3 pr-5 text-right font-bold")}>{sortLabel("amount", "Amount")}</th>}
                  {showFulfillmentColumns && (
                    <>
                      <th
                        className={cn(PINNED_HEAD_CLASS, "h-11 whitespace-nowrap border-l border-slate-200 px-3 py-2.5 text-left font-bold dark:border-slate-700")}
                        style={{ right: ACTION_COLUMN_WIDTH }}
                      >
                        Fulfillment Token
                      </th>
                      <th
                        className={cn(PINNED_HEAD_CLASS, "h-11 whitespace-nowrap py-2.5 pl-3 pr-5 text-right font-bold")}
                        style={{ right: 0 }}
                      >
                        Action
                      </th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {orders.map((order, idx) => {
                  const statusDisplay = getOrderStatusDisplay(order, statusContext)
                  const derivedStatus = statusDisplay.orderStatus
                  const statusColors = getStatusColor(derivedStatus.key)
                  const isActiveOrder = String(order.status || "").toUpperCase() === "APPROVED"
                  const rowToken = isActiveOrder && typeof order.approvalToken === "string" && order.approvalToken
                    ? order.approvalToken
                    : null
                  const rowAction = showFulfillmentColumns ? orderRowFulfilmentAction({
                    canFulfilWithToken: false,
                    status: order.status,
                    approvalToken: order.approvalToken,
                  }) : null
                  return (
                    <motion.tr
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.02 }}
                      key={order.id}
                      onClick={() => setViewingOrder(order)}
                      className="group border-b border-slate-50 dark:border-slate-800/50 hover:bg-slate-50/80 dark:hover:bg-slate-800/30 cursor-pointer transition-colors"
                    >
                      {isTableColumnVisible("id") && (
                        <td className="py-3 pl-5 pr-3">
                          <span className="font-mono text-xs font-bold text-slate-600 dark:text-slate-300">
                            #{order.id}
                          </span>
                        </td>
                      )}
                      {isTableColumnVisible("tid") && <td className="px-3 py-3">
                        <span className="block truncate font-mono text-xs font-bold text-slate-700 dark:text-slate-300 group-hover:text-indigo-600 transition-colors uppercase tracking-wider" title={order.tid}>{order.tid}</span>
                        {order.placedByGroupPortal && <GroupOrderBadge />}
                        {order.decidedByApricart && <ApricartOrderBadge pending={order.status?.toLowerCase() === "pending"} />}
                        <ApprovalLevelBadge order={order} />
                        {isUnacknowledgedDelivery(order) && <DeliveredUnfulfilledBadge />}
                      </td>}
                      {isTableColumnVisible("organization") && <td className="px-3 py-3">
                        <span className="block truncate font-medium text-slate-600 dark:text-slate-400" title={order.organizationName || undefined}>
                          {order.organizationName || "—"}
                        </span>
                      </td>}
                      {isTableColumnVisible("branch") && <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-3.5 w-3.5 shrink-0 text-indigo-500 opacity-60" />
                          <span className="min-w-0 truncate font-medium text-slate-600 dark:text-slate-400" title={order.branchName || `#${order.branchId}`}>
                            {order.branchName || `#${order.branchId}`}
                          </span>
                        </div>
                      </td>}
                      {isTableColumnVisible("costCenter") && (
                        <td className="px-3 py-3">
                          <span className="font-mono text-xs font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-md">
                            {order.branchCostCenterId || "-"}
                          </span>
                        </td>
                      )}
                      {isTableColumnVisible("partialDelivery") && (
                        <td className="px-3 py-3 text-center font-medium text-slate-600 dark:text-slate-400">
                          {isPartialDelivery(order) ? "Yes" : "No"}
                        </td>
                      )}
                      {isTableColumnVisible("orderStatus") && <td className="px-3 py-3 text-center">
                        <Badge variant="outline" className={cn("px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-lg border", statusColors.bg, statusColors.text, statusColors.border)}>
                          {derivedStatus.label}
                        </Badge>
                      </td>}
                      {isTableColumnVisible("progress") && <td className="px-3 py-3 text-center">
                        {statusDisplay.fulfillmentStatus ? (
                          <Badge variant="outline" className={cn("px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getFulfillmentProgressColor(order.fulfillmentStatus))}>
                            {statusDisplay.fulfillmentStatus}
                          </Badge>
                        ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>}
                      {isTableColumnVisible("paymentStatus") && <td className="px-3 py-3 text-center">
                        {statusDisplay.paymentStatus ? (
                          <Badge variant="outline" className={cn("px-2 py-0.5 text-[9px] uppercase font-bold tracking-wider rounded-lg border", getPaymentStatusColor(order.paymentStatus))}>
                            {statusDisplay.paymentStatus}
                          </Badge>
                        ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>}
                      {isTableColumnVisible("refundStatus") && <td className="px-3 py-3 text-center">
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
                      {isTableColumnVisible("orderDate") && <td className="whitespace-nowrap px-3 py-3 text-xs font-medium text-slate-500">
                        {format(new Date(order.createdAt), "dd MMM yyyy")}
                      </td>}
                      {isTableColumnVisible("approvalDate") && <td className="whitespace-nowrap px-3 py-3 text-xs font-medium text-slate-500">
                        {order.approvedAt ? format(new Date(order.approvedAt), "dd MMM yyyy") : "—"}
                      </td>}
                      {isTableColumnVisible("deliveryDate") && <td className="whitespace-nowrap px-3 py-3 text-xs font-medium text-slate-500">
                        {order.deliveredAt ? format(new Date(order.deliveredAt), "dd MMM yyyy") : "—"}
                      </td>}
                      {isTableColumnVisible("invoiceStatus") && <td className="px-3 py-3 text-center">
                        <InvoiceStatusBadge status={order.invoiceStatus} />
                      </td>}
                      {isTableColumnVisible("amount") && <td className="whitespace-nowrap py-3 pl-3 pr-5 text-right font-bold text-slate-800 dark:text-slate-200">
                        {order.totalCents !== null && order.totalCents !== undefined ? formatPKR(order.totalCents / 100) : "-"}
                      </td>}
                      {showFulfillmentColumns && (
                        <>
                      <td
                        className={cn(PINNED_CELL_CLASS, "border-l border-slate-100 px-3 py-3 dark:border-slate-800")}
                        style={{ right: ACTION_COLUMN_WIDTH }}
                      >
                        {rowToken ? (
                          <div className="flex min-w-0 items-center gap-1.5">
                            <code
                              className="min-w-0 truncate rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 font-mono text-xs font-bold tracking-[0.12em] text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300"
                              title={rowToken}
                            >
                              {rowToken}
                            </code>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 shrink-0"
                              aria-label={`Copy fulfillment token for order ${order.tid}`}
                              title="Copy fulfillment token"
                              onClick={(event) => {
                                event.stopPropagation()
                                void copyToken(rowToken)
                              }}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                      <td
                        className={cn(PINNED_CELL_CLASS, "py-3 pl-3 pr-5 text-right")}
                        style={{ right: 0 }}
                      >
                        {rowAction === "send-token" && isTokenAlreadySent(order.tokenHandoffAt) && (
                          <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                            {TOKEN_SENT_LABEL}
                          </span>
                        )}
                        {rowAction === "send-token" && !isTokenAlreadySent(order.tokenHandoffAt) && (
                          <Button
                            type="button"
                            size="sm"
                            disabled={sendingTokenOrderId !== null}
                            className="h-8 gap-1.5 rounded-lg bg-indigo-600 px-3 text-xs font-bold text-white hover:bg-indigo-500"
                            aria-label={`Fulfil order ${order.tid} by emailing its token`}
                            onClick={(event) => {
                              event.stopPropagation()
                              void sendTokenToAdmin(order)
                            }}
                          >
                            <Send className={cn("h-3.5 w-3.5", sendingTokenOrderId === order.id && "animate-pulse")} />
                            {sendingTokenOrderId === order.id ? "Sending..." : "Send token"}
                          </Button>
                        )}
                        {!rowAction && <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                        </>
                      )}
                    </motion.tr>
                  )
                })}
                {orders.length === 0 && (
                  <tr>
                    <td colSpan={selectedTableColumns.length + (showFulfillmentColumns ? 2 : 0)}>
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
              showFulfillmentToken={viewingOrderCanHandoffToken}
              details={orderDetails?.id === viewingOrder.id ? orderDetails : null}
              detailsExpanded={isOrderDetailsExpanded}
              detailsLoading={isOrderDetailsLoading}
              detailsError={orderDetailsError}
              onToggleDetails={() => setIsOrderDetailsExpanded((expanded) => !expanded)}
              onRetryDetails={() => setOrderDetailsRequestKey((key) => key + 1)}
              onSendToken={viewingOrderCanHandoffToken
                ? () => { void sendTokenToAdmin(viewingOrder) }
                : undefined}
              isSendingToken={sendingTokenOrderId !== null}
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

                {isAwaitingCorrection(viewingOrder) && (
                  <OrderCorrectionNotice
                    comment={viewingOrder.correctionRequestNote}
                    returnedAt={viewingOrder.returnedForCorrectionAt}
                    audience="approver"
                  />
                )}

                {viewingOrder.status.toLowerCase() === "pending" && canDecideViewingOrder && !isAwaitingCorrection(viewingOrder) && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setReturningOrder({ id: viewingOrder.id, tid: viewingOrder.tid })}
                    className="w-full h-12 rounded-xl text-amber-700 border-amber-200 hover:bg-amber-50 dark:hover:bg-amber-900/20 dark:border-amber-800"
                  >
                    Return for correction
                  </Button>
                )}

                <div className="flex gap-3">
                  {viewingOrder.status.toLowerCase() === "pending" && canDecideViewingOrder && (
                    <>
                      <Button onClick={() => setActionType("reject")} variant="outline" className="flex-1 h-12 rounded-xl text-rose-600 border-rose-200 hover:bg-rose-50 dark:hover:bg-rose-900/20 dark:border-rose-800">
                        Reject
                      </Button>
                      <Button
                        onClick={() => setActionType("approve")}
                        disabled={isAwaitingCorrection(viewingOrder)}
                        title={isAwaitingCorrection(viewingOrder) ? "Waiting for the requester to resubmit" : undefined}
                        className="flex-1 h-12 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold shadow-lg shadow-emerald-600/20"
                      >
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
                            onClick={() => requestFulfillmentProgress(nextStatus)}
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
      <Dialog open={!!actionType} onOpenChange={(open) => !open && closeActionDialog()}>
        <DialogContent className="max-w-md border-0 shadow-2xl bg-white/90 dark:bg-slate-900/95 backdrop-blur-xl rounded-[2rem]">
          <DialogHeader>
            <DialogTitle className="text-xl font-black tracking-tight flex items-center gap-2">
              {actionType === 'reject' && <XCircle className="text-rose-500 h-6 w-6" />}
              {actionType === 'approve' && <CheckCircle className="text-emerald-500 h-6 w-6" />}
              {actionType === "reject" && "Reject Order"}
              {actionType === "approve" && "Approve Order"}
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
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={closeActionDialog} disabled={isProcessing} className="h-11 rounded-xl">Cancel</Button>
            <Button
              onClick={executeAction}
              disabled={isProcessing || (actionType === 'reject' && !rejectReason)}
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
                  navigator.clipboard.writeText(generatedToken || "").then(
                    () => toast({ title: "Copied", description: "Token copied to clipboard" }),
                    () => toast({
                      title: "Copy failed",
                      description: "Could not copy the token. Please select and copy it manually.",
                      variant: "destructive",
                    }),
                  )
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

      <DeliveryChallanUploadDialog
        order={challanOrder}
        mode="deliver"
        onClose={() => setChallanOrder(null)}
        onUploaded={async (challanId) => {
          if (!viewingOrder) throw new Error("The order is no longer open")
          await postFulfillmentProgress(viewingOrder, "DELIVERED", challanId)
        }}
      />

      <ReturnForCorrectionDialog
        order={returningOrder}
        onClose={() => setReturningOrder(null)}
        onReturned={() => {
          setViewingOrder(null)
          onUpdate()
        }}
      />
    </div>
  )
}


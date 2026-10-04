"use client"

import { CheckCircle2, Copy, Eye, PackageCheck, Send } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  TOKEN_HELD_BY_RAISER_NOTE,
  canSendTokenFromTab,
  type UnacknowledgedOrderSource,
} from "@/lib/unacknowledged-orders"
import { TOKEN_SENT_LABEL, isTokenAlreadySent } from "@/lib/order-token-handoff"
import { cn } from "@/lib/utils"

export type UnacknowledgedOrderRow = UnacknowledgedOrderSource & {
  tid: string
  itemNames?: string | null
  branchName?: string | null
  placedByGroupPortal?: boolean
}

const formatDate = (value?: string | null): string => {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString()
}

/**
 * The branch's delivered orders that have not been acknowledged yet, each with
 * its full fulfilment token and the action that acknowledges it: emailing the
 * token to admin operations, which settles a delivered order to FULFILLED.
 *
 * Presentation only. Whether a token is shown at all was decided by the server
 * when it built the list; whether it may be sent is decided again by the
 * send-token-email route.
 */
export function UnacknowledgedOrdersTable<T extends UnacknowledgedOrderRow>({
  orders,
  loading,
  sendingOrderId,
  onSendToken,
  onCopyToken,
  onViewDetails,
}: Readonly<{
  orders: readonly T[]
  loading: boolean
  /** The order whose token is on its way, so every send stays disabled until it lands. */
  sendingOrderId: number | null
  onSendToken: (order: T) => void
  onCopyToken: (token: string) => void
  onViewDetails: (order: T) => void
}>) {
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading unacknowledged orders">
        {["first", "second", "third"].map((key) => <Skeleton key={key} className="h-12 w-full" />)}
      </div>
    )
  }

  if (orders.length === 0) {
    return (
      <div className="py-16 text-center">
        <PackageCheck className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-50" aria-hidden="true" />
        <p className="text-lg font-medium text-muted-foreground">No delivered orders awaiting acknowledgement</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        These orders have been delivered to your branch. Send each order&apos;s fulfilment token to the admin to
        acknowledge it — the order is then marked fulfilled.
      </p>
      <div className="overflow-x-auto rounded-2xl border bg-white dark:border-slate-800 dark:bg-slate-900">
        <Table aria-label="Delivered orders awaiting acknowledgement">
          <TableHeader>
            <TableRow>
              <TableHead>Order</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Delivered</TableHead>
              <TableHead>Fulfillment Token</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => {
              const token = canSendTokenFromTab(order) ? String(order.approvalToken) : null
              const sending = sendingOrderId === order.id
              const alreadySent = isTokenAlreadySent(order.tokenHandoffAt)
              return (
                <TableRow key={order.id}>
                  <TableCell className="align-top">
                    <div className="font-semibold text-slate-900 dark:text-white">{order.tid}</div>
                    <div className="font-mono text-xs text-muted-foreground">#{order.id}</div>
                    {order.placedByGroupPortal && (
                      <Badge variant="outline" className="mt-1 text-[10px] uppercase">Group Order</Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[16rem] whitespace-normal align-top text-sm text-slate-600 dark:text-slate-300">
                    {order.itemNames || "—"}
                  </TableCell>
                  <TableCell className="align-top text-sm">{formatDate(order.deliveredAt)}</TableCell>
                  <TableCell className="align-top">
                    {token ? (
                      <div className="flex items-center gap-2">
                        <code className="whitespace-nowrap rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 font-mono text-sm font-bold tracking-[0.15em] text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300">
                          {token}
                        </code>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 shrink-0"
                          aria-label={`Copy fulfillment token for order ${order.tid}`}
                          title="Copy fulfillment token"
                          onClick={() => onCopyToken(token)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <span className="block max-w-[14rem] whitespace-normal text-xs text-muted-foreground">
                        {TOKEN_HELD_BY_RAISER_NOTE}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={`View order ${order.tid}`}
                        onClick={() => onViewDetails(order)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {token && alreadySent && (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled
                          aria-label={`Token for order ${order.tid} has already been emailed`}
                          className="gap-2 whitespace-nowrap"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          {TOKEN_SENT_LABEL}
                        </Button>
                      )}
                      {token && !alreadySent && (
                        <Button
                          type="button"
                          size="sm"
                          disabled={sendingOrderId !== null}
                          aria-label={`Fulfil order ${order.tid} by emailing its token`}
                          onClick={() => onSendToken(order)}
                          className="gap-2 whitespace-nowrap"
                        >
                          <Send className={cn("h-4 w-4", sending && "animate-pulse")} />
                          {sending ? "Sending..." : "Fulfil via email"}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

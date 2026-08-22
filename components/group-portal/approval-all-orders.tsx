"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import { Package, RefreshCw, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

import { ApprovalOrderTable } from "./approval-order-table"
import { type ApprovalOrder, type DecisionResponse } from "./approval-types"

type OrdersResponse = {
  items: Array<{
    id: number
    tid: string
    branchId: number
    branchName?: string | null
    branchCostCenterId?: string | null
    status: string
    fulfillmentStatus?: string | null
    totalCents: number
    createdAt: string
    approvedAt?: string | null
    rejectionReason?: string | null
    approvalToken?: string | null
    orderItems?: unknown[]
  }>
  pagination?: { total: number; totalPages: number }
}

const PAGE_SIZE = 25
const STATUS_TABS: Array<[string, string]> = [
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["all", "All"],
]

/**
 * Every order across this user's branches, group-raised or not.
 *
 * The group queue answers "what came in as a group order"; this answers "what
 * is outstanding anywhere in my scope", which is the same view a Branch Admin
 * has of its single branch. It reads the standard, already role-scoped orders
 * endpoint rather than a parallel one, so there is a single source of truth for
 * which orders this user may see.
 */
export function ApprovalAllOrders() {
  const { toast } = useToast()
  const [status, setStatus] = useState("pending")
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search.trim(), 300)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({ page: "1", limit: String(PAGE_SIZE) })
    if (status !== "all") params.set("status", status)
    if (debouncedSearch) params.set("q", debouncedSearch)
    return `/api/v1/orders?${params.toString()}`
  }, [debouncedSearch, status])

  const { data, error, isLoading, isValidating, mutate } = useSWR<OrdersResponse>(
    endpoint,
    fetcher,
    { keepPreviousData: true },
  )

  const orders: ApprovalOrder[] = useMemo(
    () => (data?.items ?? []).map((order) => ({
      id: order.id,
      tid: order.tid,
      branchId: order.branchId,
      branchName: order.branchName ?? `Branch ${order.branchId}`,
      branchCostCenterId: order.branchCostCenterId ?? null,
      status: order.status,
      fulfillmentStatus: order.fulfillmentStatus ?? "",
      totalCents: order.totalCents,
      itemCount: Array.isArray(order.orderItems) ? order.orderItems.length : 0,
      createdAt: order.createdAt,
      approvedAt: order.approvedAt ?? null,
      rejectionReason: order.rejectionReason ?? null,
      approvalToken: order.approvalToken ?? null,
    })),
    [data],
  )

  const toggleSelection = useCallback((orderId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(orderId)) next.delete(orderId)
      else next.add(orderId)
      return next
    })
  }, [])

  // Single-order decisions only here; bulk work belongs in the group queue,
  // where a selection has a group order to be meaningful against.
  const decide = useCallback(async (orderIds: number[], decision: "approve" | "reject") => {
    if (orderIds.length === 0) return

    let reason: string | null = null
    if (decision === "reject") {
      reason = window.prompt("Reason for rejecting this order:")?.trim() || null
      if (!reason) return
    }

    setBusy(true)
    try {
      const res = await fetch("/api/v1/group-portal/approvals/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, orderIds, ...(reason ? { reason } : {}) }),
      })
      const payload: DecisionResponse & { error?: string } = await res.json().catch(() => ({} as any))

      if (!res.ok || payload.failed > 0) {
        const firstFailure = payload.results?.find((result) => !result.ok)
        toast({
          title: "Decision not applied",
          description: firstFailure?.message || payload?.error || "Please try again.",
          variant: "destructive",
        })
        if (!res.ok) return
      } else {
        toast({ title: payload.message })
      }

      setSelectedIds(new Set())
      await mutate()
    } catch {
      toast({
        title: "Decision not applied",
        description: "Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setBusy(false)
    }
  }, [mutate, toast])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex items-center overflow-x-auto rounded-xl border border-slate-200/60 bg-slate-100/60 p-1 dark:border-slate-700/50 dark:bg-slate-800/50"
          role="group"
          aria-label="Filter orders by status"
        >
          {STATUS_TABS.map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? "secondary" : "ghost"}
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value)
                setSelectedIds(new Set())
              }}
              className={cn(
                "h-8 shrink-0 rounded-lg px-3 text-xs font-bold",
                status === value
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                  : "text-slate-500 hover:text-slate-900 dark:text-slate-400",
              )}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by TID or cost center"
              aria-label="Search orders"
              className="h-8 rounded-xl pl-9 text-xs"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => mutate()}
            className="h-8 gap-2 rounded-full"
          >
            <RefreshCw className={cn("h-3.5 w-3.5 text-slate-500", isValidating && "animate-spin text-indigo-500")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden rounded-2xl border-slate-200 dark:border-slate-800">
        <CardContent className="p-0">
          <OrdersBody
            loading={isLoading && !data}
            error={Boolean(error)}
            isEmpty={orders.length === 0}
          >
            <ApprovalOrderTable
              orders={orders}
              selectedIds={selectedIds}
              onToggleSelection={toggleSelection}
              onDecide={decide}
              busy={busy}
            />
          </OrdersBody>
        </CardContent>
      </Card>
    </div>
  )
}

function OrdersBody({
  loading,
  error,
  isEmpty,
  children,
}: Readonly<{
  loading: boolean
  error: boolean
  isEmpty: boolean
  children: React.ReactNode
}>) {
  if (loading) return <div className="p-6"><ListSkeleton rows={5} /></div>

  if (error) {
    return (
      <p role="alert" className="p-6 text-sm text-slate-700 dark:text-slate-300">
        Orders could not be loaded. Please try again.
      </p>
    )
  }

  if (isEmpty) {
    return (
      <div className="p-10 text-center">
        <Package className="mx-auto mb-3 h-9 w-9 text-slate-300 dark:text-slate-700" />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No orders match this filter in your branches.
        </p>
      </div>
    )
  }

  return <>{children}</>
}

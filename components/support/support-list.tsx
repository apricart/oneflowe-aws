"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Inbox, Loader2, MessageSquare, Paperclip } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_LABELS_APRICART,
} from "@/lib/support-thread"
import {
  CategoryLabel,
  PriorityBadge,
  StatusBadge,
  SupportHeader,
  formatWhen,
  homeHrefForRole,
  useSupportSide,
} from "@/components/support/support-chrome"
import { NewThreadDialog } from "@/components/support/new-thread-dialog"

type SupportThreadRow = {
  id: number
  reference: string
  subject: string
  category: string
  status: string
  priority: string
  organizationName: string | null
  branchName: string | null
  orderTid: string | null
  createdByName: string | null
  assignedToName: string | null
  messageCount: number
  lastMessageAt: string
  lastMessageSide: string
  unread: boolean
}

type SupportListResponse = {
  items: SupportThreadRow[]
  total: number
  unreadCount: number
  page: number
  pageSize: number
}

export function SupportList() {
  const searchParams = useSearchParams()
  const { role, side } = useSupportSide()
  const apricart = side === "APRICART"
  const home = homeHrefForRole(role)

  // A deep link from an order or an invoice carries the order it is about, and
  // opens the dialog straight away.
  const linkedOrderId = Number(searchParams.get("orderId")) || null
  const linkedOrderLabel = searchParams.get("orderTid")
  const [dialogOpen, setDialogOpen] = useState(Boolean(linkedOrderId))

  const [status, setStatus] = useState<string>("ALL")
  const [category, setCategory] = useState<string>("ALL")
  const [page, setPage] = useState(1)

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (status !== "ALL") params.set("status", status)
    if (category !== "ALL") params.set("category", category)
    params.set("page", String(page))
    return params.toString()
  }, [status, category, page])

  const { data, isLoading, mutate } = useAPI<SupportListResponse>(
    `/api/v1/support/threads?${query}`,
    // Support is a conversation; a reply landing while the list is open should
    // show up without a manual refresh.
    { refreshInterval: 60_000, keepPreviousData: true },
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pageSize = data?.pageSize ?? 20
  const lastPage = Math.max(1, Math.ceil(total / pageSize))

  return (
    <>
      <SupportHeader
        title={apricart ? "Support queue" : "Support"}
        subtitle={
          apricart
            ? "Queries and complaints raised by portal users"
            : "Your queries and complaints to the Apricart team"
        }
        backHref={home.href}
        backLabel={home.label}
        actions={
          apricart ? null : (
            <NewThreadDialog
              orderId={linkedOrderId}
              orderLabel={linkedOrderLabel}
              open={dialogOpen}
              onOpenChange={setDialogOpen}
              onCreated={() => void mutate()}
            />
          )
        }
      />

      <main className="mx-auto max-w-5xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-[190px]">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any status</SelectItem>
              {SUPPORT_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {(apricart ? SUPPORT_STATUS_LABELS_APRICART : SUPPORT_STATUS_LABELS)[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-[190px]">
              <SelectValue placeholder="Any category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any category</SelectItem>
              {SUPPORT_CATEGORIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {SUPPORT_CATEGORY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {(data?.unreadCount ?? 0) > 0 ? (
              <Badge className="bg-indigo-600 hover:bg-indigo-600">
                {data?.unreadCount} unread
              </Badge>
            ) : null}
            <span>{total} request{total === 1 ? "" : "s"}</span>
          </div>
        </div>

        {renderBody({ isLoading, items, apricart })}

        {lastPage > 1 ? (
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              Page {page} of {lastPage}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= lastPage}
              onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            >
              Next
            </Button>
          </div>
        ) : null}
      </main>
    </>
  )
}

function renderBody({
  isLoading,
  items,
  apricart,
}: {
  isLoading: boolean
  items: SupportThreadRow[]
  apricart: boolean
}) {
  if (isLoading && items.length === 0) {
    return (
      <div className="space-y-2">
        {["a", "b", "c"].map((key) => (
          <Skeleton key={key} className="h-[86px] w-full rounded-lg" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
          <Inbox className="h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="font-semibold text-slate-700 dark:text-slate-200">Nothing here yet</p>
          <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">
            {apricart
              ? "No support requests match this filter."
              : "When you raise a query with the Apricart team it will appear here, with every reply."}
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <ul className="space-y-2">
      {items.map((thread) => (
        <li key={thread.id}>
          <Link
            href={`/support/${thread.id}`}
            className={cn(
              "block rounded-lg border bg-white p-4 transition hover:border-indigo-300 hover:shadow-sm dark:bg-slate-900",
              thread.unread
                ? "border-indigo-200 dark:border-indigo-800"
                : "border-slate-200 dark:border-slate-800",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {thread.unread ? (
                <span
                  aria-label="Unread"
                  className="h-2 w-2 shrink-0 rounded-full bg-indigo-600"
                />
              ) : null}
              <span className="font-mono text-xs text-slate-400">{thread.reference}</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-slate-900 dark:text-slate-50">
                {thread.subject}
              </span>
              <PriorityBadge priority={thread.priority} />
              <StatusBadge status={thread.status} apricart={apricart} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="h-3.5 w-3.5" />
                {thread.messageCount}
              </span>
              <span>
                <CategoryLabel category={thread.category} />
              </span>
              {thread.orderTid ? (
                <span className="inline-flex items-center gap-1">
                  <Paperclip className="h-3.5 w-3.5" />
                  Order {thread.orderTid}
                </span>
              ) : null}
              {apricart ? (
                <span className="truncate">
                  {thread.organizationName}
                  {thread.branchName ? ` · ${thread.branchName}` : ""}
                </span>
              ) : null}
              <span className="truncate">Raised by {thread.createdByName || "a colleague"}</span>
              <span className="ml-auto">{formatWhen(thread.lastMessageAt)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}

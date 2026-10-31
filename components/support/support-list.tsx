"use client"

import { isReadOnlyRole } from "@/lib/viewer-access"
import { useEffect, useId, useMemo, useState } from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Inbox, Loader2, MessageSquare, Package, Paperclip, Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  SUPPORT_ORDER_SEARCH_MAX_LENGTH,
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
import {
  SupportFilterCombobox,
  type SupportFilterOption,
} from "@/components/support/support-filter-combobox"
import { SupportStats } from "@/components/support/support-stats"

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
  productCode: string | null
  productName: string | null
  createdByName: string | null
  assignedToName: string | null
  messageCount: number
  lastMessageAt: string
  lastMessageSide: string
  unread: boolean
}

/** The places the caller has threads at, from `GET /api/v1/support/filters`. */
type SupportFilterOptionsResponse = {
  organizations: Array<{ id: number; name: string }>
  branches: Array<{ id: number; name: string; organizationId: number; groupId: number | null }>
  groups: Array<{ id: number; name: string; organizationId: number }>
}

type SupportListResponse = {
  items: SupportThreadRow[]
  total: number
  unreadCount: number
  page: number
  pageSize: number
}

/** Long enough that typing an order reference does not fire a request per keystroke. */
const SEARCH_DEBOUNCE_MS = 300

export function SupportList() {
  const searchParams = useSearchParams()
  const { role, side, embedded } = useSupportSide()
  const apricart = side === "APRICART"
  const home = homeHrefForRole(role)

  // A deep link from an order or an invoice carries the order it is about, and
  // opens the dialog straight away.
  const linkedOrderId = Number(searchParams.get("orderId")) || null
  const linkedOrderLabel = searchParams.get("orderTid")
  const [dialogOpen, setDialogOpen] = useState(Boolean(linkedOrderId))

  const [status, setStatus] = useState<string>("ALL")
  const [category, setCategory] = useState<string>("ALL")
  const [organizationId, setOrganizationId] = useState<number | null>(null)
  const [branchId, setBranchId] = useState<number | null>(null)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [orderSearch, setOrderSearch] = useState("")
  const [debouncedOrderSearch, setDebouncedOrderSearch] = useState("")
  const [page, setPage] = useState(1)
  const searchId = useId()

  // The queue is searched once the person pauses, not once per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedOrderSearch(orderSearch.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [orderSearch])

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (status !== "ALL") params.set("status", status)
    if (category !== "ALL") params.set("category", category)
    if (organizationId) params.set("organizationId", String(organizationId))
    if (branchId) params.set("branchId", String(branchId))
    if (groupId) params.set("groupId", String(groupId))
    if (debouncedOrderSearch) params.set("orderSearch", debouncedOrderSearch)
    params.set("page", String(page))
    return params.toString()
  }, [status, category, organizationId, branchId, groupId, debouncedOrderSearch, page])

  // Only places the caller already has a thread at; the server scopes the list.
  const { data: filterOptions } = useAPI<SupportFilterOptionsResponse>("/api/v1/support/filters")
  const places = usePlaceFilterOptions(filterOptions, organizationId, groupId)

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
  const filtered =
    status !== "ALL" ||
    category !== "ALL" ||
    organizationId !== null ||
    branchId !== null ||
    groupId !== null ||
    debouncedOrderSearch !== ""

  return (
    <div className={cn(embedded && "mx-auto max-w-5xl")}>
      {/* Inside the portal chrome the sidebar is the way back, so the header
          drops its own link home rather than offering a second one. */}
      <SupportHeader
        embedded={embedded}
        title={apricart ? "Support queue" : "Support"}
        subtitle={
          apricart
            ? "Queries and complaints raised by portal users"
            : "Your queries and complaints to the Apricart team"
        }
        backHref={embedded ? undefined : home?.href}
        backLabel={embedded ? undefined : home?.label}
        actions={
          // The read-only Viewer reads its organization's threads and raises none.
          apricart || isReadOnlyRole(role) ? null : (
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

      <div className={cn("space-y-4", embedded ? "" : "mx-auto max-w-5xl p-4")}>
        <SupportStats
          side={side}
          onSelectStatus={(next) => {
            setStatus(next)
            setPage(1)
          }}
        />

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

          {places.organizations.length > 1 ? (
            <SupportFilterCombobox
              value={organizationId}
              options={places.organizations}
              allLabel="Any organization"
              searchLabel="Search organizations"
              emptyLabel="No organization found."
              onValueChange={(next) => {
                setOrganizationId(next)
                // A branch or group of another organization would match nothing.
                if (next !== null) {
                  if (branchId !== null && places.branchOrganization.get(branchId) !== next) setBranchId(null)
                  if (groupId !== null && places.groupOrganization.get(groupId) !== next) setGroupId(null)
                }
                setPage(1)
              }}
            />
          ) : null}

          {places.groups.length > 0 ? (
            <SupportFilterCombobox
              value={groupId}
              options={places.groups}
              allLabel="Any group"
              searchLabel="Search groups"
              emptyLabel="No group found."
              onValueChange={(next) => {
                setGroupId(next)
                if (next !== null && branchId !== null && places.branchGroup.get(branchId) !== next) {
                  setBranchId(null)
                }
                setPage(1)
              }}
            />
          ) : null}

          {places.branches.length > 1 || branchId !== null ? (
            <SupportFilterCombobox
              value={branchId}
              options={places.branches}
              allLabel="Any branch"
              searchLabel="Search branches"
              emptyLabel="No branch found."
              onValueChange={(next) => {
                setBranchId(next)
                setPage(1)
              }}
            />
          ) : null}

          {/* Support staff work from the order a customer quotes, so the queue
              is searchable by that reference — the order ID or its transaction
              ID — rather than only by its own. */}
          <div className="relative">
            <Label htmlFor={searchId} className="sr-only">
              Search by order ID or transaction ID
            </Label>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            />
            <Input
              id={searchId}
              value={orderSearch}
              maxLength={SUPPORT_ORDER_SEARCH_MAX_LENGTH}
              placeholder="Search by order or transaction ID"
              className="w-[260px] pl-8 pr-8"
              onChange={(event) => {
                setOrderSearch(event.target.value)
                setPage(1)
              }}
            />
            {orderSearch ? (
              <button
                type="button"
                aria-label="Clear the order search"
                onClick={() => {
                  setOrderSearch("")
                  setPage(1)
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm text-slate-400 transition hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

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

        {renderBody({ isLoading, items, apricart, filtered })}

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
      </div>
    </div>
  )
}

/**
 * The filter choices, narrowed to the organization and group already chosen so
 * every option on offer can still match something. Each is labelled with its
 * organization while more than one organization is in view.
 */
function usePlaceFilterOptions(
  data: SupportFilterOptionsResponse | undefined,
  organizationId: number | null,
  groupId: number | null,
) {
  return useMemo(() => {
    const organizationNames = new Map((data?.organizations ?? []).map((row) => [row.id, row.name]))
    const hintFor = (id: number) => (organizationId === null ? organizationNames.get(id) : undefined)

    const allBranches = data?.branches ?? []
    const allGroups = data?.groups ?? []

    const organizations: SupportFilterOption[] = (data?.organizations ?? []).map((row) => ({
      id: row.id,
      label: row.name,
    }))
    const groups: SupportFilterOption[] = allGroups
      .filter((row) => organizationId === null || row.organizationId === organizationId)
      .map((row) => ({ id: row.id, label: row.name, hint: hintFor(row.organizationId) }))
    const branches: SupportFilterOption[] = allBranches
      .filter((row) => organizationId === null || row.organizationId === organizationId)
      .filter((row) => groupId === null || row.groupId === groupId)
      .map((row) => ({ id: row.id, label: row.name, hint: hintFor(row.organizationId) }))

    return {
      organizations,
      groups,
      branches,
      branchOrganization: new Map(allBranches.map((row) => [row.id, row.organizationId])),
      branchGroup: new Map(allBranches.map((row) => [row.id, row.groupId])),
      groupOrganization: new Map(allGroups.map((row) => [row.id, row.organizationId])),
    }
  }, [data, organizationId, groupId])
}

function renderBody({
  isLoading,
  items,
  apricart,
  filtered,
}: {
  isLoading: boolean
  items: SupportThreadRow[]
  apricart: boolean
  filtered: boolean
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
    // A filtered empty list is not the same as an empty queue, and saying so
    // spares the reader wondering whether their search is the reason.
    let emptyMessage: string
    if (filtered) {
      emptyMessage = "No support requests match this filter."
    } else if (apricart) {
      emptyMessage = "No support requests have been raised yet."
    } else {
      emptyMessage =
        "When you raise a query with the Apricart team it will appear here, with every reply."
    }

    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-14 text-center">
          <Inbox className="h-8 w-8 text-slate-300 dark:text-slate-600" />
          <p className="font-semibold text-slate-700 dark:text-slate-200">
            {filtered ? "No matching requests" : "Nothing here yet"}
          </p>
          <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">{emptyMessage}</p>
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
              {thread.productCode ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1"
                  title={thread.productName ?? undefined}
                >
                  <Package className="h-3.5 w-3.5" />
                  <span className="font-mono">{thread.productCode}</span>
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

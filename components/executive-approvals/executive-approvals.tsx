"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR, { useSWRConfig } from "swr"
import { format } from "date-fns"
import { Building2, CheckCircle2, ExternalLink, ImageIcon, Inbox, Loader2, Search, Undo2, XCircle } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useDebounce } from "@/hooks/use-debounce"
import { toast } from "@/hooks/use-toast"
import {
  EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH,
  EXECUTIVE_APPROVAL_TABS,
  type ExecutiveApprovalCounts,
  type ExecutiveApprovalTab,
} from "@/lib/executive-approval-query"
import { fetcher } from "@/lib/fetcher"
import { ORDER_CORRECTION_TEXT_MAX_LENGTH } from "@/lib/order-correction"
import { INTAKE_CHANNEL_LABELS, type IntakeChannel } from "@/lib/order-desk-access"
import { calculateLineCents, formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

/**
 * An Apricart Executive's approvals: the orders Apricart's Order Desk keyed in
 * for the organizations assigned to them, waiting to be approved, rejected or
 * sent back for correction. Presentation only — the server decides what is
 * listed and re-checks every action (`/api/v1/executive/approvals`).
 * Super Admin sees the same list, for every desk order, on Order Desk Team
 * (`audience="super-admin"`); only the wording and the link to the order page
 * differ — what it may do is the server's to say.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md and
 * plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md.
 */

export const EXECUTIVE_APPROVALS_KEY_PREFIX = "/api/v1/executive/approvals"

/** Bounded by the reject schema on the server. */
const REJECTION_REASON_MAX_LENGTH = 2_000

/** One row of `GET /api/v1/executive/approvals`. */
export type ExecutiveApprovalOrder = {
  id: number
  tid: string
  status: string
  organizationName: string | null
  branchName: string | null
  branchCity: string | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  poNumber: string | null
  notes: string | null
  intakeChannel: IntakeChannel | null
  intakeReference: string | null
  hasAttachment: boolean
  enteredBy: string | null
  createdAt: string | null
  updatedAt: string | null
  approvedAt: string | null
  approvedBy: string | null
  rejectedAt: string | null
  rejectionReason: string | null
  returnedForCorrectionAt: string | null
  correctionRequestNote: string | null
  canApprove: boolean
  canReject: boolean
  canReturn: boolean
  items: {
    id: number
    productName: string
    productCode: string | null
    quantity: number
    unit: string | null
    priceCents: number
    /** The Order Desk typed this line's price; `cataloguePriceCents` is what it replaced. */
    priceEnteredManually?: boolean
    cataloguePriceCents?: number | null
    /** False when the branch did not carry the product when it was ordered. */
    inBranchCatalogue?: boolean
  }[]
}

type ApprovalPage = {
  items: ExecutiveApprovalOrder[]
  counts: ExecutiveApprovalCounts
  organizations: { id: number; name: string }[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

const ALL = "all"

const TAB_LABELS: Record<ExecutiveApprovalTab, string> = {
  awaiting_approval: "Awaiting approval",
  returned: "With the desk",
  approved: "Approved",
  rejected: "Rejected",
  all: "All",
}

export type ExecutiveApprovalsAudience = "executive" | "super-admin"

const TAB_HINTS: Record<ExecutiveApprovalTab, string> = {
  awaiting_approval: "Orders the Order Desk entered, newest first. Approve, reject, or send one back for correction.",
  returned: "Sent back for correction. They return to Awaiting approval when the desk resubmits them.",
  approved: "Approved orders, whatever happened to them after.",
  rejected: "Rejected orders. Their stock and budget were released.",
  all: "Every Order Desk order in your organizations.",
}

/** The wording that depends on who is reading. */
const AUDIENCE_COPY: Record<ExecutiveApprovalsAudience, {
  allHint: string
  allOrganizations: string
  afterApproval: string
}> = {
  executive: {
    allHint: TAB_HINTS.all,
    allOrganizations: "All my organizations",
    afterApproval: "Super Admin can now arrange delivery.",
  },
  "super-admin": {
    allHint: "Every order the Order Desk entered, in every organization.",
    allOrganizations: "All organizations",
    afterApproval: "Arrange delivery from the order page.",
  },
}

const EMPTY_MESSAGES: Record<ExecutiveApprovalTab, string> = {
  awaiting_approval: "Nothing is waiting for your approval.",
  returned: "No orders are with the desk for correction.",
  approved: "No approved orders yet.",
  rejected: "No rejected orders.",
  all: "No Order Desk orders yet.",
}

function displayDate(value: string | null) {
  return value ? format(new Date(value), "dd MMM yyyy, HH:mm") : "—"
}

type OpenDialog =
  | { kind: "approve"; order: ExecutiveApprovalOrder }
  | { kind: "reject"; order: ExecutiveApprovalOrder }
  | { kind: "return"; order: ExecutiveApprovalOrder }
  | null

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    const message = typeof data?.error === "string" ? data.error : (typeof data?.message === "string" ? data.message : "")
    return { ok: response.ok, status: response.status, message }
  } catch {
    return { ok: false, status: 0, message: "Check the connection and try again." }
  }
}

function ApprovalCard({
  order,
  busy,
  showOrderLink,
  onAction,
}: Readonly<{
  order: ExecutiveApprovalOrder
  busy: boolean
  /** Super Admin may open the order page; the executive cannot reach it. */
  showOrderLink: boolean
  onAction: (dialog: NonNullable<OpenDialog>) => void
}>) {
  const channel = order.intakeChannel ? INTAKE_CHANNEL_LABELS[order.intakeChannel] : null
  const status = order.status.toUpperCase()

  return (
    <article className={cn("rounded-lg border bg-card shadow-sm", order.canApprove && "border-indigo-200 dark:border-indigo-900")}>
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">{order.tid}</h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">{status}</span>
              {order.returnedForCorrectionAt && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                  With the desk for correction
                </span>
              )}
              {order.items.some((item) => item.priceEnteredManually) && (
                <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-900 dark:bg-indigo-950 dark:text-indigo-100">
                  Custom prices
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Entered {displayDate(order.createdAt)} by {order.enteredBy ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-semibold">{formatPKR(order.totalCents / 100)}</p>
            <p className="text-xs text-muted-foreground">incl. tax {formatPKR(order.taxCents / 100)}</p>
          </div>
        </div>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div className="flex items-start gap-2">
            <Building2 className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate font-medium">{order.organizationName ?? "—"}</p>
              <p className="truncate text-muted-foreground">
                {order.branchName ?? "—"}{order.branchCity ? ` · ${order.branchCity}` : ""}
              </p>
            </div>
          </div>
          <div className="min-w-0">
            <p className="font-medium">{channel ?? "—"}</p>
            <p className="truncate text-muted-foreground" title={order.intakeReference ?? ""}>{order.intakeReference ?? ""}</p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Items in {order.tid}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">Product</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Quantity</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-medium">Price</th>
                <th scope="col" className="py-1.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-1.5 pr-3">
                    {item.productName}
                    {item.inBranchCatalogue === false && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">
                        Not in branch catalogue
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{formatQuantity(item.quantity)} {item.unit ?? ""}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                    {formatPKR(item.priceCents / 100)}
                    {item.priceEnteredManually && (
                      <span className="block text-xs font-normal text-indigo-700 dark:text-indigo-300">
                        Price set by Order Desk
                        {typeof item.cataloguePriceCents === "number"
                          ? <> · catalogue <span className="line-through">{formatPKR(item.cataloguePriceCents / 100)}</span></>
                          : " · no catalogue price"}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right tabular-nums">{formatPKR(calculateLineCents(item.priceCents, item.quantity) / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {(order.poNumber || order.notes) && (
          <dl className="grid gap-1 text-xs text-muted-foreground">
            {order.poNumber && <div><dt className="inline font-medium">PO: </dt><dd className="inline">{order.poNumber}</dd></div>}
            {order.notes && <div><dt className="inline font-medium">Notes: </dt><dd className="inline">{order.notes}</dd></div>}
          </dl>
        )}
        {order.returnedForCorrectionAt && order.correctionRequestNote && (
          <p className="whitespace-pre-line rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <span className="font-medium">Sent back: </span>{order.correctionRequestNote}
          </p>
        )}
        {status === "REJECTED" && order.rejectionReason && (
          <p className="rounded-md bg-muted/50 p-2 text-sm text-muted-foreground">
            Rejected {displayDate(order.rejectedAt)} — {order.rejectionReason}
          </p>
        )}
        {order.approvedAt && (
          <p className="text-xs text-muted-foreground">
            Approved {displayDate(order.approvedAt)}{order.approvedBy ? ` by ${order.approvedBy}` : ""}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/20 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          {showOrderLink && (
            <Link
              href={`/orders/${order.id}`}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open order
            </Link>
          )}
          {order.hasAttachment && (
            <a
              href={`${EXECUTIVE_APPROVALS_KEY_PREFIX}/${order.id}/attachment`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" /> Customer&apos;s message
            </a>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {order.canReturn && (
            <Button size="sm" variant="outline" onClick={() => onAction({ kind: "return", order })}>
              <Undo2 className="mr-1 h-4 w-4" aria-hidden="true" /> Send back
            </Button>
          )}
          {order.canReject && (
            <Button
              size="sm"
              variant="ghost"
              className="text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-400 dark:hover:bg-rose-950/40"
              onClick={() => onAction({ kind: "reject", order })}
            >
              <XCircle className="mr-1 h-4 w-4" aria-hidden="true" /> Reject
            </Button>
          )}
          {order.canApprove && (
            <Button size="sm" disabled={busy} onClick={() => onAction({ kind: "approve", order })}>
              {busy
                ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" />
                : <CheckCircle2 className="mr-1 h-4 w-4" aria-hidden="true" />}
              Approve
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}

/** A reason or comment, required, for reject and send back. */
function TextDecisionDialog({
  order,
  kind,
  onClose,
  onDone,
}: Readonly<{ order: ExecutiveApprovalOrder; kind: "reject" | "return"; onClose: () => void; onDone: () => void }>) {
  const [text, setText] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const reject = kind === "reject"

  const submit = async () => {
    if (saving) return
    const trimmed = text.trim()
    if (!trimmed) {
      setFormError(reject ? "A reason is required" : "Say what the desk should correct")
      return
    }
    setSaving(true)
    setFormError(null)
    const result = await postJson(
      `${EXECUTIVE_APPROVALS_KEY_PREFIX}/${order.id}/${kind}`,
      reject ? { reason: trimmed } : { comment: trimmed },
    )
    setSaving(false)
    if (!result.ok) {
      setFormError(result.message || (reject ? "The order could not be rejected" : "The order could not be sent back"))
      return
    }
    toast({ title: order.tid, description: reject ? "Order rejected" : "Sent back to the Order Desk" })
    onDone()
  }

  const fieldId = `executive-${kind}-text`
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{reject ? `Reject ${order.tid}?` : `Send ${order.tid} back for correction?`}</DialogTitle>
          <DialogDescription>
            {reject
              ? "The order is closed and its stock and budget are released. This cannot be undone."
              : "The Order Desk corrects it and resubmits it for your approval. Nothing is released meanwhile."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor={fieldId}>{reject ? "Reason" : "What should the desk correct?"}</Label>
          <Textarea
            id={fieldId}
            maxLength={reject ? REJECTION_REASON_MAX_LENGTH : ORDER_CORRECTION_TEXT_MAX_LENGTH}
            value={text}
            disabled={saving}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? `${fieldId}-error` : undefined}
            onChange={(event) => { setFormError(null); setText(event.target.value) }}
          />
        </div>
        {formError && <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Back</Button>
          <Button variant={reject ? "destructive" : "default"} onClick={() => { void submit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {reject ? "Reject order" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExecutiveApprovals({ audience = "executive" }: Readonly<{ audience?: ExecutiveApprovalsAudience }> = {}) {
  const copy = AUDIENCE_COPY[audience]
  const [tab, setTab] = useState<ExecutiveApprovalTab>("awaiting_approval")
  const [organizationId, setOrganizationId] = useState(ALL)
  const [searchInput, setSearchInput] = useState("")
  const search = useDebounce(searchInput.trim(), 300)
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const [approvingId, setApprovingId] = useState<number | null>(null)

  const params = new URLSearchParams({ status: tab, page: String(page) })
  if (organizationId !== ALL) params.set("organizationId", organizationId)
  if (search) params.set("q", search)
  const { data, error, isLoading } = useSWR<ApprovalPage>(`${EXECUTIVE_APPROVALS_KEY_PREFIX}?${params.toString()}`, fetcher, {
    keepPreviousData: true,
  })
  // Every approvals read — this list and the workspace's waiting count.
  const { mutate: mutateKeys } = useSWRConfig()
  const refresh = () => mutateKeys((key) => typeof key === "string" && key.startsWith(EXECUTIVE_APPROVALS_KEY_PREFIX))

  const orders = data?.items ?? []
  const counts = data?.counts
  const pagination = data?.pagination
  // Super Admin reaches every desk order, so an empty list is just an empty list.
  const noReach = audience === "executive" && data !== undefined && data.organizations.length === 0

  const chooseTab = (next: ExecutiveApprovalTab) => {
    setTab(next)
    setPage(1)
  }

  const approve = async (order: ExecutiveApprovalOrder) => {
    if (approvingId !== null) return
    setApprovingId(order.id)
    const result = await postJson(`${EXECUTIVE_APPROVALS_KEY_PREFIX}/${order.id}/approve`, { expectedUpdatedAt: order.updatedAt })
    setApprovingId(null)
    if (!result.ok) {
      toast({ title: "Not approved", description: result.message || "The order could not be approved", variant: "destructive" })
      // A 409 means it changed under us: show the current version.
      if (result.status === 409) void refresh()
      return
    }
    toast({ title: `${order.tid} approved`, description: copy.afterApproval })
    await refresh()
  }

  const closeAndRefresh = () => {
    setDialog(null)
    void refresh()
  }

  if (noReach) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
          <Inbox className="h-8 w-8" aria-hidden="true" />
          <p className="font-medium text-foreground">No organizations are assigned to you for approvals.</p>
          <p>Super Admin assigns them from Order Desk Team.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Approval status" className="flex gap-2 overflow-x-auto pb-1">
        {EXECUTIVE_APPROVAL_TABS.map((filter) => {
          const selected = tab === filter
          return (
            <button
              key={filter}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => chooseTab(filter)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                selected ? "border-indigo-600 bg-indigo-600 text-white shadow-sm" : "bg-background text-slate-700 hover:bg-muted dark:text-slate-200",
              )}
            >
              {TAB_LABELS[filter]}
              <span className={cn("rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-white/20 text-white" : "bg-muted text-muted-foreground")}>
                {counts ? counts[filter] : "·"}
              </span>
            </button>
          )
        })}
      </div>

      <Card>
        <CardContent className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_240px]">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="Search orders"
              placeholder="Search by order number or customer reference"
              value={searchInput}
              maxLength={EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH}
              onChange={(event) => { setSearchInput(event.target.value); setPage(1) }}
              className="pl-9"
            />
          </div>
          <Select value={organizationId} onValueChange={(value) => { setOrganizationId(value); setPage(1) }}>
            <SelectTrigger aria-label="Organization" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{copy.allOrganizations}</SelectItem>
              {(data?.organizations ?? []).map((organization) => (
                <SelectItem key={organization.id} value={String(organization.id)}>{organization.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">{tab === "all" ? copy.allHint : TAB_HINTS[tab]}</p>

      {error && <p role="alert" className="text-sm text-destructive">Could not load orders. Refresh the page to try again.</p>}
      {isLoading && !data && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading orders…
        </p>
      )}
      {data && orders.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8" aria-hidden="true" />
            {search ? `No orders match “${search}”.` : EMPTY_MESSAGES[tab]}
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {orders.map((order) => (
          <ApprovalCard
            key={order.id}
            order={order}
            busy={approvingId === order.id}
            showOrderLink={audience === "super-admin"}
            onAction={(next) => setDialog(next)}
          />
        ))}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} orders
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
          </div>
        </div>
      )}

      <AlertDialog open={dialog?.kind === "approve"} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve {dialog?.order.tid}?</AlertDialogTitle>
            <AlertDialogDescription>
              {dialog?.order
                ? `${dialog.order.organizationName ?? ""} · ${dialog.order.branchName ?? ""} — ${formatPKR(dialog.order.totalCents / 100)}. The order becomes Active. ${copy.afterApproval}`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction
              disabled={approvingId !== null}
              onClick={() => {
                const order = dialog?.order
                setDialog(null)
                if (order) void approve(order)
              }}
            >
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {(dialog?.kind === "reject" || dialog?.kind === "return") && (
        <TextDecisionDialog
          key={`${dialog.kind}-${dialog.order.id}`}
          order={dialog.order}
          kind={dialog.kind}
          onClose={() => setDialog(null)}
          onDone={closeAndRefresh}
        />
      )}
    </div>
  )
}

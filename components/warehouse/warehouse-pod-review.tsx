"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { ArrowLeft, CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fetcher } from "@/lib/fetcher"

type AssignmentListItem = {
  assignment: {
    id: number
    status: string
    riderUserId: string
    podSubmittedAt: string | null
  }
  orderTid: string
  riderCode: string
  riderFullName: string | null
  customerName: string
  branchName: string
}

type AssignmentsResponse = { items: AssignmentListItem[] }

type ProofImage = {
  id: number
  uploadedAt: string
  fileUrl: string
}

type OrderLine = {
  name: string
  code: string | null
  quantity: number
  unit: string | null
  priceCents: number
}

type AssignmentDetail = {
  assignment: {
    id: number
    status: string
    podSubmittedAt: string | null
    assignedAt: string
    deliveryAddressText: string | null
    deliveryLat: number
    deliveryLng: number
    deliverySequence: number
  }
  orderTid: string
  orderStatus: string
  fulfillmentStatus: string
  paymentStatus: string | null
  totalCents: number
  subtotalCents: number
  taxCents: number
  approvedAt: string | null
  notes: string | null
  customerName: string
  organizationCode: string | null
  branchName: string
  branchCity: string | null
  branchAddress: string | null
  placerName: string | null
  rider: {
    code: string
    fullName: string | null
    email: string | null
    phone: string | null
    vehicleNumber: string | null
  }
  riderCode: string
  riderFullName: string | null
  items: OrderLine[]
  proofImages: ProofImage[]
}

type Props = {
  onBack: () => void
}

function money(cents: number | null | undefined) {
  const value = Number(cents) || 0
  return `₨ ${(value / 100).toLocaleString("en-PK", { maximumFractionDigits: 0 })}`
}

function when(value: string | null | undefined) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  return date.toLocaleString()
}

/**
 * Warehouse reviews rider POD photos: Mark delivered (approve) or Reject.
 * Approve advances the order to DELIVERED; rider then enters the fulfilment token.
 */
export function WarehousePodReview({ onBack }: Props) {
  const { data, error, isLoading, isValidating, mutate } = useSWR<AssignmentsResponse>(
    "/api/v1/rider-ops/assignments?day=today&status=POD_SUBMITTED",
    fetcher,
    { refreshInterval: 15_000 },
  )

  const pending = useMemo(
    () => (data?.items ?? []).filter((row) => row.assignment.status === "POD_SUBMITTED"),
    [data],
  )

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const detailKey = selectedId
    ? `/api/v1/rider-ops/assignments/${selectedId}`
    : null
  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
    mutate: mutateDetail,
  } = useSWR<AssignmentDetail>(detailKey, fetcher)

  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState("")

  async function approve() {
    if (selectedId == null) return
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/v1/rider-ops/assignments/${selectedId}/pod/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || "Could not mark delivered")
      setSelectedId(null)
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not mark delivered")
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (selectedId == null) return
    const reason = rejectReason.trim()
    if (!reason) {
      setActionError("Rejection reason is required")
      return
    }
    setBusy(true)
    setActionError(null)
    try {
      const res = await fetch(`/api/v1/rider-ops/assignments/${selectedId}/pod/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error || "Could not reject POD")
      setRejectOpen(false)
      setRejectReason("")
      setSelectedId(null)
      await mutate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reject POD")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Riders
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">POD review</h2>
          <p className="text-sm text-muted-foreground">
            See who submitted proof, review the order, then mark delivered or reject.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void mutate()
            void mutateDetail()
          }}
          disabled={isValidating}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isValidating ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Awaiting review</CardTitle>
            <p className="text-xs text-muted-foreground">{pending.length} submitted today</p>
          </CardHeader>
          <CardContent className="max-h-[70vh] space-y-1.5 overflow-y-auto">
            {error && (
              <p role="alert" className="text-sm text-destructive">
                Could not load POD queue.
              </p>
            )}
            {isLoading && !data && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            )}
            {!isLoading && pending.length === 0 && (
              <p className="text-sm text-muted-foreground">No PODs waiting for review.</p>
            )}
            {pending.map((row) => (
              <button
                key={row.assignment.id}
                type="button"
                onClick={() => {
                  setSelectedId(row.assignment.id)
                  setActionError(null)
                }}
                className={`w-full rounded-md border px-2 py-2 text-left text-sm transition-colors ${
                  selectedId === row.assignment.id
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                    : "hover:bg-muted/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{row.orderTid}</span>
                  <Badge variant="secondary" className="shrink-0 text-[10px]">
                    {row.riderCode}
                  </Badge>
                </div>
                <div className="mt-0.5 truncate text-xs font-medium text-slate-700 dark:text-slate-200">
                  Rider: {row.riderFullName || row.riderCode}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {row.customerName} · {row.branchName}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Submission detail</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[70vh] space-y-4 overflow-y-auto">
            {!selectedId && (
              <p className="text-sm text-muted-foreground">Select a submission on the left.</p>
            )}
            {selectedId && detailLoading && !detail && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading proof…
              </p>
            )}
            {detailError && (
              <p role="alert" className="text-sm text-destructive">
                Could not load this POD.
              </p>
            )}
            {detail && (
              <>
                <section className="space-y-2 rounded-md border p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Submitted by rider
                  </h3>
                  <div className="text-sm font-semibold">
                    {detail.rider.fullName || detail.riderCode}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {detail.rider.code}
                    </span>
                  </div>
                  <dl className="grid gap-1 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Phone</dt>
                      <dd>{detail.rider.phone || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Vehicle</dt>
                      <dd>{detail.rider.vehicleNumber || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Email</dt>
                      <dd className="truncate">{detail.rider.email || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">POD submitted</dt>
                      <dd>{when(detail.assignment.podSubmittedAt)}</dd>
                    </div>
                  </dl>
                </section>

                <section className="space-y-2 rounded-md border p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Order
                  </h3>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{detail.orderTid}</span>
                    <Badge variant="outline">{detail.orderStatus}</Badge>
                    <Badge variant="secondary">{detail.fulfillmentStatus}</Badge>
                    {detail.paymentStatus && (
                      <Badge variant="outline">{detail.paymentStatus}</Badge>
                    )}
                  </div>
                  <dl className="grid gap-1.5 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Customer / org</dt>
                      <dd className="font-medium">
                        {detail.customerName}
                        {detail.organizationCode ? ` (${detail.organizationCode})` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Branch</dt>
                      <dd className="font-medium">
                        {detail.branchName}
                        {detail.branchCity ? ` · ${detail.branchCity}` : ""}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">Branch address</dt>
                      <dd>{detail.branchAddress || "—"}</dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground">Drop pin / delivery address</dt>
                      <dd>
                        {detail.assignment.deliveryAddressText || "—"}
                        <span className="mt-0.5 block text-muted-foreground">
                          #{detail.assignment.deliverySequence} · {detail.assignment.deliveryLat},{" "}
                          {detail.assignment.deliveryLng}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Placed by</dt>
                      <dd>{detail.placerName || "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Approved</dt>
                      <dd>{when(detail.approvedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Assigned to rider</dt>
                      <dd>{when(detail.assignment.assignedAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Total</dt>
                      <dd className="font-medium">{money(detail.totalCents)}</dd>
                    </div>
                    {detail.notes && (
                      <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Notes</dt>
                        <dd>{detail.notes}</dd>
                      </div>
                    )}
                  </dl>
                </section>

                <section className="space-y-2 rounded-md border p-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Line items
                  </h3>
                  {(detail.items ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No line items.</p>
                  ) : (
                    <ul className="divide-y text-sm">
                      {detail.items.map((item, index) => (
                        <li key={`${item.code ?? item.name}-${index}`} className="flex justify-between gap-3 py-1.5">
                          <span className="min-w-0">
                            <span className="font-medium">{item.name}</span>
                            {item.code && (
                              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                                {item.code}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {item.quantity}
                            {item.unit ? ` ${item.unit}` : ""} · {money(item.priceCents * item.quantity)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Proof photos
                  </h3>
                  {(detail.proofImages ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No images attached.</p>
                  ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {detail.proofImages.map((image) => (
                        <a
                          key={image.id}
                          href={image.fileUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="block overflow-hidden rounded-md border bg-muted/30"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={image.fileUrl}
                            alt={`POD ${image.id}`}
                            className="aspect-square w-full object-cover"
                          />
                          <div className="px-1.5 py-1 text-[10px] text-muted-foreground">
                            {when(image.uploadedAt)}
                          </div>
                        </a>
                      ))}
                    </div>
                  )}
                </section>

                {actionError && (
                  <p role="alert" className="text-sm text-destructive">
                    {actionError}
                  </p>
                )}

                {detail.assignment.status === "POD_SUBMITTED" && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={busy} onClick={() => void approve()}>
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="mr-2 h-4 w-4" />
                      )}
                      Mark delivered
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setRejectReason("")
                        setRejectOpen(true)
                      }}
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject POD</DialogTitle>
            <DialogDescription>
              The rider can re-upload photos. The order stays out for delivery until you approve a
              later POD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="pod-reject-reason">Reason</Label>
            <Textarea
              id="pod-reject-reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder="e.g. Photo unclear — need door number visible"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void reject()}>
              Reject POD
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

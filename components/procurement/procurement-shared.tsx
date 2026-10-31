"use client"

import { useState } from "react"
import useSWR from "swr"
import { Loader2, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { fetcher } from "@/lib/fetcher"
import { PURCHASE_ORDER_STATUS_LABELS, type PurchaseOrderStatus } from "@/lib/procurement"
import { formatPKR } from "@/lib/utils"

/**
 * Pieces every purchasing screen shares. The server decides every rule; these
 * only show and ask. See plans/OF-PROCUREMENT-purchasing.md.
 */

/** Production's WAF refuses JSON bodies over 8 KB; say so before sending one. */
const MAX_BODY_BYTES = 8000

export async function sendJson<T = Record<string, unknown>>(url: string, method: "POST" | "PATCH" | "PUT", body: unknown): Promise<T> {
  const payload = JSON.stringify(body)
  if (new TextEncoder().encode(payload).length > MAX_BODY_BYTES) {
    throw new Error("This document is too large to send at once. Split it into two.")
  }
  const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: payload })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "The request could not be completed.")
  return result as T
}

export const money = (cents: number): string => formatPKR(cents / 100)

export function formatQty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  PENDING_APPROVAL: "bg-amber-100 text-amber-800",
  APPROVED: "bg-blue-100 text-blue-800",
  PARTIALLY_RECEIVED: "bg-indigo-100 text-indigo-800",
  RECEIVED: "bg-emerald-100 text-emerald-800",
  CLOSED: "bg-slate-200 text-slate-700",
  REJECTED: "bg-red-100 text-red-800",
  CANCELLED: "bg-slate-200 text-slate-600",
  SUBMITTED: "bg-amber-100 text-amber-800",
  CONVERTED: "bg-emerald-100 text-emerald-800",
  RECORDED: "bg-amber-100 text-amber-800",
  PAID: "bg-emerald-100 text-emerald-800",
  PENDING: "bg-amber-100 text-amber-800",
  MATCHED: "bg-emerald-100 text-emerald-800",
  EXCEPTION: "bg-red-100 text-red-800",
}

const LABELS: Record<string, string> = {
  ...PURCHASE_ORDER_STATUS_LABELS,
  SUBMITTED: "Waiting",
  CONVERTED: "Ordered",
  RECORDED: "Recorded",
  PAID: "Paid",
  PENDING: "Pending",
  MATCHED: "Matched",
  EXCEPTION: "Does not match",
}

export function StatusBadge({ status }: Readonly<{ status: string }>) {
  return (
    <Badge variant="outline" className={`border-0 ${STATUS_TONE[status] ?? ""}`}>
      {LABELS[status] ?? PURCHASE_ORDER_STATUS_LABELS[status as PurchaseOrderStatus] ?? status}
    </Badge>
  )
}

export type PickerProduct = { id: number; name: string; productCode: string; unit: string; allowDecimalQuantity: boolean }

/** Search the active catalogue and pick one product. */
export function ProductPicker({
  endpoint,
  onPick,
  excludeIds = [],
}: Readonly<{ endpoint: string; onPick: (product: PickerProduct) => void; excludeIds?: readonly number[] }>) {
  const [query, setQuery] = useState("")
  const trimmed = query.trim()
  const { data, isLoading } = useSWR<{ items: PickerProduct[] }>(
    trimmed.length >= 2 ? `${endpoint}?q=${encodeURIComponent(trimmed)}` : null,
    fetcher,
  )
  const results = (data?.items ?? []).filter((product) => !excludeIds.includes(product.id))

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search products by name or code"
          className="pl-8"
          aria-label="Search products"
        />
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Searching…</p>}
      {trimmed.length >= 2 && !isLoading && results.length === 0 && (
        <p className="text-xs text-muted-foreground">No products match.</p>
      )}
      {results.length > 0 && (
        <ul className="max-h-48 divide-y overflow-y-auto rounded-md border">
          {results.map((product) => (
            <li key={product.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                onClick={() => { onPick(product); setQuery("") }}
              >
                <span>{product.name}</span>
                <span className="text-xs text-muted-foreground">{product.productCode} · {product.unit}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Ask for a reason before a decision that needs one. */
export function ReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  optional = false,
  onClose,
  onConfirm,
}: Readonly<{
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  optional?: boolean
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}>) {
  const [reason, setReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const trimmed = reason.trim()
  const ready = optional ? trimmed.length === 0 || trimmed.length >= 3 : trimmed.length >= 3

  const confirm = async () => {
    setSubmitting(true)
    setFailure(null)
    try {
      await onConfirm(trimmed)
      setReason("")
      onClose()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : "Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="procurement-reason">Reason{optional ? " (optional)" : ""}</Label>
          <Textarea id="procurement-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={3} />
          {failure && <p className="text-sm text-red-600" role="alert">{failure}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button type="button" onClick={confirm} disabled={!ready || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Loading, error and empty, the same way everywhere. */
export function ListState({
  isLoading,
  error,
  empty,
  emptyText,
}: Readonly<{ isLoading: boolean; error: unknown; empty: boolean; emptyText: string }>) {
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (error) {
    return (
      <p className="text-sm text-red-600" role="alert">
        {error instanceof Error ? error.message : "Could not load this list."}
      </p>
    )
  }
  if (empty) return <p className="text-sm text-muted-foreground">{emptyText}</p>
  return null
}

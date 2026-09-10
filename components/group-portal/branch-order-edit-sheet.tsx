"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2, Plus, Search, Trash2 } from "lucide-react"

import { QuantityStepper } from "@/components/group-portal/quantity-stepper"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ListSkeleton } from "@/components/ui/skeleton"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { calculateLineCents, formatQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

import type { CatalogItem, CatalogResponse, ScopedBranch } from "./types"

/**
 * Editing a branch order from the Group Order Portal.
 *
 * The branch owns its orders, so a group requester may adjust a pending order
 * raised by that branch's own staff, exactly as the Order Portal may adjust a
 * group order raised for it. Both go through the same
 * `PUT /api/v1/orders/{id}`, which re-reads and re-prices every line and locks
 * the branch's budget — nothing priced or totalled here is authoritative, and
 * the running total below is a preview only.
 *
 * Products are added from the group catalogue narrowed to this one branch, so a
 * line can never be added that the branch could not have ordered itself.
 */

type EditableLine = {
  organizationInventoryId: number
  name: string
  unit: string | null
  priceCents: number | null
  quantity: number
  step: number
}

type OrderDetailResponse = {
  item?: {
    id: number
    status: string
    poNumber?: string | null
    pricesHidden?: boolean
    orderItems?: Array<{
      productName: string
      unit?: string | null
      priceCents?: number | null
      quantity: number | string
      organizationInventoryId?: number | null
      allowDecimalQuantity?: boolean | null
      quantityStep?: number | null
    }>
  }
}

type ScopeResponse = { item?: { branches?: ScopedBranch[] } }

const CATALOG_PAGE_SIZE = 20

function lineTotalCents(line: EditableLine): number {
  return line.priceCents === null ? 0 : calculateLineCents(line.priceCents, line.quantity)
}

type EditableOrder = {
  id: number
  tid: string
  branchId: number
  branchName?: string | null
}

export function BranchOrderEditSheet({
  order,
  onClose,
  onSaved,
}: Readonly<{
  order: EditableOrder | null
  onClose: () => void
  onSaved: () => void
}>) {
  const { toast } = useToast()
  const [lines, setLines] = useState<EditableLine[] | null>(null)
  const [poNumber, setPoNumber] = useState("")
  const [search, setSearch] = useState("")
  const [saving, setSaving] = useState(false)
  const debouncedSearch = useDebounce(search.trim(), 300)

  const { data, error, isLoading } = useSWR<OrderDetailResponse>(
    order ? `/api/v1/orders/${order.id}` : null,
    fetcher,
  )
  const { data: scopeData } = useSWR<ScopeResponse>(
    order ? "/api/v1/group-portal/scope" : null,
    fetcher,
  )

  const detail = data?.item
  const pricesHidden = Boolean(detail?.pricesHidden)

  // The group the order's branch sits in, which is what narrows the catalogue.
  const groupId = useMemo(() => {
    const branch = scopeData?.item?.branches?.find((entry) => entry.id === order?.branchId)
    return branch?.groupId ?? null
  }, [order?.branchId, scopeData])

  // Seed the editor once the order arrives. Afterwards the local state is the
  // edit in progress, so a background revalidation must not overwrite it.
  useEffect(() => {
    if (!detail || lines !== null) return
    setLines((detail.orderItems ?? [])
      .filter((item) => typeof item.organizationInventoryId === "number")
      .map((item) => ({
        organizationInventoryId: item.organizationInventoryId as number,
        name: item.productName,
        unit: item.unit ?? null,
        priceCents: typeof item.priceCents === "number" ? item.priceCents : null,
        quantity: Number(item.quantity) || 0,
        step: sanitizeQuantityStep(Boolean(item.allowDecimalQuantity), item.quantityStep),
      })))
    setPoNumber(detail.poNumber ?? "")
  }, [detail, lines])

  const catalogKey = order && debouncedSearch
    ? `/api/v1/group-portal/catalog?branchIds=${order.branchId}`
      + `${groupId === null ? "" : `&groupId=${groupId}`}`
      + `&search=${encodeURIComponent(debouncedSearch)}&limit=${CATALOG_PAGE_SIZE}`
    : null
  const { data: catalog, isLoading: catalogLoading } = useSWR<CatalogResponse>(catalogKey, fetcher)

  const closeSheet = () => {
    setLines(null)
    setSearch("")
    setPoNumber("")
    onClose()
  }

  const setQuantity = (organizationInventoryId: number, quantity: number) => {
    setLines((current) => (current ?? [])
      .map((line) => (line.organizationInventoryId === organizationInventoryId
        ? { ...line, quantity }
        : line))
      // A stepper commits zero for "remove this line", as the storefront does.
      .filter((line) => line.quantity > 0))
  }

  const addProduct = (item: CatalogItem) => {
    const step = sanitizeQuantityStep(item.allowDecimalQuantity, item.quantityStep)
    setLines((current) => {
      const lineup = current ?? []
      const alreadyOnOrder = lineup.some(
        (line) => line.organizationInventoryId === item.organizationInventoryId,
      )
      if (alreadyOnOrder) {
        return lineup.map((line) => (
          line.organizationInventoryId === item.organizationInventoryId
            ? { ...line, quantity: line.quantity + step }
            : line
        ))
      }
      return [...lineup, {
        organizationInventoryId: item.organizationInventoryId,
        name: item.name,
        unit: item.unit,
        priceCents: item.priceCents,
        quantity: step,
        step,
      }]
    })
    setSearch("")
  }

  const totalCents = (lines ?? []).reduce((sum, line) => sum + lineTotalCents(line), 0)

  const save = async () => {
    if (!order || !lines || lines.length === 0 || saving) return
    setSaving(true)
    try {
      const response = await fetch(`/api/v1/orders/${order.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: lines.map((line) => ({
            organizationInventoryId: line.organizationInventoryId,
            quantity: line.quantity,
          })),
          poNumber: poNumber.trim() || undefined,
        }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || "The order could not be updated.")

      toast({ title: "Order updated", description: `Order ${order.tid} was saved.` })
      onSaved()
      closeSheet()
    } catch (saveError) {
      toast({
        variant: "destructive",
        title: "Update failed",
        description: saveError instanceof Error
          ? saveError.message
          : "The order could not be updated.",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={Boolean(order)} onOpenChange={(open) => { if (!open) closeSheet() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono text-base">Edit {order?.tid}</SheetTitle>
          <SheetDescription>
            {order?.branchName || `Branch ${order?.branchId}`} — the person who raised this order
            is told that you changed it.
          </SheetDescription>
        </SheetHeader>

        <EditBody loading={isLoading && !data} error={Boolean(error)}>
          <div className="mt-5 space-y-5">
            <section className="space-y-2">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Items
              </h3>
              <ul className="space-y-2">
                {(lines ?? []).map((line) => (
                  <li
                    key={line.organizationInventoryId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                        {line.name}
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {formatQuantity(line.quantity)} {line.unit || "units"}
                        {!pricesHidden && line.priceCents !== null && (
                          <> · {formatPKR(lineTotalCents(line) / 100)}</>
                        )}
                      </p>
                    </div>
                    <QuantityStepper
                      value={line.quantity}
                      step={line.step}
                      label={`Quantity for ${line.name}`}
                      disabled={saving}
                      onChange={(next) => setQuantity(line.organizationInventoryId, next)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={saving}
                      aria-label={`Remove ${line.name}`}
                      onClick={() => setQuantity(line.organizationInventoryId, 0)}
                    >
                      <Trash2 className="h-4 w-4 text-rose-500" />
                    </Button>
                  </li>
                ))}
                {lines?.length === 0 && (
                  <li className="rounded-xl border border-dashed border-rose-200 p-4 text-center text-xs text-rose-600 dark:border-rose-900 dark:text-rose-400">
                    An order needs at least one item. Add a product below, or close without saving.
                  </li>
                )}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Add a product
              </h3>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search this branch's catalogue"
                  className="pl-9"
                  disabled={saving}
                  aria-label="Search the catalogue for a product to add"
                />
              </div>
              {catalogLoading && <p className="text-xs text-slate-400">Searching…</p>}
              <ul className="space-y-1.5">
                {(catalog?.items ?? []).map((item) => (
                  <li key={item.organizationInventoryId}>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => addProduct(item)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40 disabled:opacity-50 dark:border-slate-800 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-900 dark:text-slate-100">
                          {item.name}
                        </span>
                        {!pricesHidden && (
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {formatPKR(item.priceCents / 100)} per {item.unit}
                          </span>
                        )}
                      </span>
                      <Plus className="h-4 w-4 shrink-0 text-indigo-500" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-1.5">
              <label
                htmlFor="group-edit-po-number"
                className="text-[10px] font-bold uppercase tracking-wider text-slate-400"
              >
                Purchase order number (optional)
              </label>
              <Input
                id="group-edit-po-number"
                value={poNumber}
                onChange={(event) => setPoNumber(event.target.value)}
                placeholder="e.g. PO-2026-0148"
                disabled={saving}
              />
            </section>

            {!pricesHidden && (
              <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm font-bold dark:border-slate-800">
                <span className="text-slate-500">New total</span>
                <span className="text-slate-900 dark:text-white">{formatPKR(totalCents / 100)}</span>
              </div>
            )}

            <div className="flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                disabled={saving}
                onClick={closeSheet}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={saving || !lines || lines.length === 0}
                onClick={() => { void save() }}
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </div>
        </EditBody>
      </SheetContent>
    </Sheet>
  )
}

function EditBody({
  loading,
  error,
  children,
}: Readonly<{ loading: boolean; error: boolean; children: React.ReactNode }>) {
  if (loading) return <div className="mt-6"><ListSkeleton rows={4} /></div>
  if (error) {
    return (
      <p role="alert" className="mt-6 text-sm text-slate-700 dark:text-slate-300">
        This order could not be loaded for editing. Please try again.
      </p>
    )
  }
  return <>{children}</>
}

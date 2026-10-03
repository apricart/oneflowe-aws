"use client"

import { useState } from "react"
import useSWR from "swr"
import { Check, Plus, Search, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { calculateLineCents, formatQuantity, roundQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

import { QuantityStepper } from "./quantity-stepper"
import { entryTotalCents } from "./group-order-plan"
import { setCartLineQuantity, setCartQuantity } from "./storefront/storefront-plan"
import type { BranchPlan, CatalogItem, CatalogResponse, SelectedLine } from "./types"

const CATALOG_PAGE_SIZE = 20

/**
 * Edit what one location receives, from the review screen.
 *
 * The storefront builds one cart for every ticked location; this is where a
 * single location is made to differ — products added that only it needs, or
 * removed that it does not. The edit is drafted here and applied as a whole,
 * so Cancel leaves the location exactly as it was.
 *
 * Products come from the group catalogue narrowed to this one location, so a
 * line can only be added that the location could have ordered on its own. Like
 * everything else on the review screen, the prices and totals here are a
 * preview: the server re-scopes, re-prices and re-checks every line at
 * submission.
 */
export function ReviewLocationEditor({
  plan,
  groupId,
  onClose,
  onApply,
}: Readonly<{
  plan: BranchPlan | null
  groupId: number | null
  onClose: () => void
  /** False when the edit was refused; the sheet then stays open with the draft intact. */
  onApply: (lines: SelectedLine[]) => boolean
}>) {
  return (
    <Sheet open={plan !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {plan && (
          // Keyed by location so opening another one starts from its own lines,
          // never from a draft left behind by the last.
          <EditorBody
            key={plan.branch.id}
            plan={plan}
            groupId={groupId}
            onClose={onClose}
            onApply={onApply}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function EditorBody({
  plan,
  groupId,
  onClose,
  onApply,
}: Readonly<{
  plan: BranchPlan
  groupId: number | null
  onClose: () => void
  onApply: (lines: SelectedLine[]) => boolean
}>) {
  const [lines, setLines] = useState<SelectedLine[]>(plan.lines)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const debouncedSearch = useDebounce(search.trim(), 300)

  const params = new URLSearchParams({
    branchIds: String(plan.branch.id),
    page: String(page),
    limit: String(CATALOG_PAGE_SIZE),
    sort: "name",
  })
  if (groupId !== null) params.set("groupId", String(groupId))
  if (debouncedSearch) params.set("search", debouncedSearch)

  const { data: catalog, error: catalogError, isLoading: catalogLoading } = useSWR<CatalogResponse>(
    `/api/v1/group-portal/catalog?${params.toString()}`,
    fetcher,
    { revalidateOnFocus: false, keepPreviousData: true },
  )

  const quantityByInventoryId = new Map(lines.map((line) => [line.organizationInventoryId, line.quantity]))
  const totalPages = catalog ? Math.max(1, Math.ceil(catalog.total / catalog.limit)) : 1

  /** One more step of the product, or its first step when it is not on the order yet. */
  const addProduct = (item: CatalogItem) => {
    const step = sanitizeQuantityStep(item.allowDecimalQuantity, item.quantityStep)
    const current = quantityByInventoryId.get(item.organizationInventoryId) ?? 0
    setLines((existing) => setCartQuantity(existing, item, roundQuantity(current + step)))
  }

  const apply = () => {
    if (lines.length === 0) return
    if (onApply(lines)) onClose()
  }

  return (
    <>
      <SheetHeader>
        <SheetTitle className="text-base">Edit {plan.branch.name}</SheetTitle>
        <SheetDescription>
          Changes here apply to this location only. Every other location in the group order keeps
          its own items.
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-5 px-4 pb-4">
        <section className="space-y-2">
          <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            Items for this location
          </h3>
          <ul className="space-y-2">
            {lines.map((line) => (
              <li
                key={line.organizationInventoryId}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={line.name}>
                    {line.name}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {formatQuantity(line.quantity)} {line.unit}
                    {" · "}
                    {formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)}
                  </p>
                </div>
                <QuantityStepper
                  value={line.quantity}
                  step={sanitizeQuantityStep(Boolean(line.allowDecimalQuantity), line.quantityStep ?? 1)}
                  label={`Quantity of ${line.name} for ${plan.branch.name}`}
                  onChange={(quantity) =>
                    setLines((existing) => setCartLineQuantity(existing, line.organizationInventoryId, quantity))}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${line.name} from ${plan.branch.name}`}
                  onClick={() =>
                    setLines((existing) => setCartLineQuantity(existing, line.organizationInventoryId, 0))}
                >
                  <Trash2 className="h-4 w-4 text-rose-500" />
                </Button>
              </li>
            ))}
            {lines.length === 0 && (
              <li className="rounded-xl border border-dashed border-rose-200 p-4 text-center text-xs text-rose-600 dark:border-rose-900 dark:text-rose-400">
                This location has no items left. Add a product below — or, to leave this location
                out of the group order, close this and remove the location instead.
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
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(1)
              }}
              placeholder={`Search ${plan.branch.name}'s catalogue`}
              className="pl-9"
              aria-label={`Search the catalogue for a product to add to ${plan.branch.name}`}
            />
          </div>
          <CatalogResults
            items={catalog?.items ?? []}
            loading={catalogLoading && !catalog}
            failed={Boolean(catalogError)}
            quantityByInventoryId={quantityByInventoryId}
            onAdd={addProduct}
          />
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-3 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1 || catalogLoading}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages || catalogLoading}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </section>

        <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm font-bold dark:border-slate-800">
          <span className="text-slate-500">Location total</span>
          <span className="text-slate-900 dark:text-white">{formatPKR(entryTotalCents(lines) / 100)}</span>
        </div>

        <div className="flex gap-3">
          <Button type="button" variant="outline" className="flex-1" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" className="flex-1" disabled={lines.length === 0} onClick={apply}>
            Apply to this location
          </Button>
        </div>
      </div>
    </>
  )
}

function CatalogResults({
  items,
  loading,
  failed,
  quantityByInventoryId,
  onAdd,
}: Readonly<{
  items: CatalogItem[]
  loading: boolean
  failed: boolean
  quantityByInventoryId: Map<number, number>
  onAdd: (item: CatalogItem) => void
}>) {
  if (loading) return <p className="text-xs text-slate-400">Loading products…</p>
  if (failed) {
    return (
      <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
        The catalogue could not be loaded. Please try again.
      </p>
    )
  }
  if (items.length === 0) {
    return <p className="text-xs text-slate-500 dark:text-slate-400">No products match this search here.</p>
  }

  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const onOrder = quantityByInventoryId.get(item.organizationInventoryId) ?? 0
        const outOfStock = item.stockQuantity <= 0
        return (
          <li key={item.organizationInventoryId}>
            <button
              type="button"
              disabled={outOfStock}
              onClick={() => onAdd(item)}
              aria-label={`Add ${item.name}`}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-100 p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:hover:border-indigo-800 dark:hover:bg-indigo-950/20"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-slate-900 dark:text-slate-100" title={item.name}>
                  {item.name}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {formatPKR(item.priceCents / 100)} per {item.unit}
                  {outOfStock && " · Out of stock"}
                </span>
              </span>
              {onOrder > 0 ? (
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  {formatQuantity(onOrder)} {item.unit}
                </span>
              ) : (
                <Plus className="h-4 w-4 shrink-0 text-indigo-500" />
              )}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

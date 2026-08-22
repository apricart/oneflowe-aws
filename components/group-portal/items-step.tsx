"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { AlertTriangle, Info, Minus, Package, Plus, Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ListSkeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import { formatQuantity, parseQuantity, roundQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

import type { CatalogItem, CatalogResponse, SelectedLine } from "./types"

const SEARCH_DEBOUNCE_MS = 300

/**
 * Step 3 — choose products and quantities for the selected branches.
 *
 * The catalogue is the intersection across those branches: a product appears
 * only if every selected branch can receive it. That is what makes one
 * selection valid for all of them, and the count of products left out is shown
 * so an unexpectedly short list is never silent.
 *
 * Quantities are per branch, not shared: entering 10 for three branches creates
 * three orders of 10, which is stated on screen rather than left to inference.
 */
export function ItemsStep({
  groupId,
  branchIds,
  branchCount,
  lines,
  onChange,
}: Readonly<{
  groupId: number | null
  branchIds: number[]
  branchCount: number
  lines: SelectedLine[]
  onChange: (lines: SelectedLine[]) => void
}>) {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const catalogUrl = useMemo(() => {
    if (branchIds.length === 0) return null
    const params = new URLSearchParams({
      branchIds: [...branchIds].sort((left, right) => left - right).join(","),
      page: String(page),
    })
    if (groupId !== null) params.set("groupId", String(groupId))
    if (search.trim()) params.set("search", search.trim())
    return `/api/v1/group-portal/catalog?${params.toString()}`
  }, [branchIds, groupId, page, search])

  const { data, error, isLoading } = useSWR<CatalogResponse>(catalogUrl, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  })

  const quantityByInventoryId = useMemo(
    () => new Map(lines.map((line) => [line.organizationInventoryId, line.quantity])),
    [lines],
  )

  const setQuantity = (item: CatalogItem, quantity: number) => {
    const next = roundQuantity(quantity)
    const without = lines.filter((line) => line.organizationInventoryId !== item.organizationInventoryId)
    if (next <= 0) {
      onChange(without)
      return
    }
    onChange([...without, {
      organizationInventoryId: item.organizationInventoryId,
      quantity: next,
      name: item.name,
      unit: item.unit,
      priceCents: item.priceCents,
    }])
  }

  const items = data?.items ?? []
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Select items</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Each quantity below is ordered <span className="font-medium">per branch</span>, for the{" "}
          {branchCount === 1 ? "1 branch" : `${branchCount} branches`} you selected.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search products by name or code"
          className="pl-9"
          aria-label="Search products"
        />
        {searchInput && (
          <button
            type="button"
            onClick={() => setSearchInput("")}
            aria-label="Clear product search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {data && data.excludedProductCount > 0 && (
        <Card className="rounded-xl border-sky-200 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20">
          <CardContent className="flex items-start gap-2 p-3 text-xs text-slate-700 dark:text-slate-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
            <span>
              {data.excludedProductCount} product{data.excludedProductCount === 1 ? " is" : "s are"} hidden
              because {data.excludedProductCount === 1 ? "it is" : "they are"} not stocked at every branch you
              selected. Deselect those branches to see {data.excludedProductCount === 1 ? "it" : "them"}.
            </span>
          </CardContent>
        </Card>
      )}

      {(() => {
        if (isLoading && items.length === 0) {
          return (
            <Card className="rounded-2xl">
              <CardContent className="p-6"><ListSkeleton rows={5} /></CardContent>
            </Card>
          )
        }
        if (error) {
          return (
            <Card role="alert" className="rounded-2xl border-rose-200 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20">
              <CardContent className="p-5 text-sm text-slate-700 dark:text-slate-300">
                The catalogue could not be loaded. Please try again.
              </CardContent>
            </Card>
          )
        }
        if (items.length === 0) {
          return (
            <Card className="rounded-2xl">
              <CardContent className="p-6 text-sm text-slate-500 dark:text-slate-400">
                No products are available for every branch you selected.
              </CardContent>
            </Card>
          )
        }
        return (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <ProductCard
                key={item.organizationInventoryId}
                item={item}
                branchCount={branchCount}
                quantity={quantityByInventoryId.get(item.organizationInventoryId) ?? 0}
                onQuantityChange={(quantity) => setQuantity(item, quantity)}
              />
            ))}
          </ul>
        )
      })()}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Page {page} of {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function ProductCard({
  item,
  branchCount,
  quantity,
  onQuantityChange,
}: Readonly<{
  item: CatalogItem
  branchCount: number
  quantity: number
  onQuantityChange: (quantity: number) => void
}>) {
  const step = sanitizeQuantityStep(item.allowDecimalQuantity, item.quantityStep)
  const isSelected = quantity > 0

  // Stock is held once per branch order, so the whole batch draws on it.
  const totalAcrossBranches = roundQuantity(quantity * branchCount)
  const exceedsStock = isSelected && totalAcrossBranches > item.stockQuantity
  const exceedsAllocation = isSelected
    && item.quantityBudgetRemaining !== null
    && quantity > item.quantityBudgetRemaining

  return (
    <li
      className={cn(
        "flex flex-col rounded-2xl border p-3 transition",
        isSelected
          ? "border-indigo-500 bg-indigo-50/40 dark:border-indigo-500 dark:bg-indigo-950/20"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-100 bg-slate-50 dark:border-slate-800 dark:bg-slate-800">
          {item.imageUrl
            ? <img src={item.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            : <Package className="h-5 w-5 text-slate-400" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={item.name}>
            {item.name}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400">
            {item.productCode && <span>{item.productCode}</span>}
            <span>{formatPKR(item.priceCents / 100)} / {item.unit}</span>
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <QuantityStepper
          value={quantity}
          step={step}
          label={`Quantity of ${item.name}`}
          onChange={onQuantityChange}
        />
        {isSelected && (
          <span className="text-right text-xs text-slate-500 dark:text-slate-400">
            <span className="block font-medium text-slate-700 dark:text-slate-200">
              {formatQuantity(totalAcrossBranches)} {item.unit}
            </span>
            across {branchCount === 1 ? "1 branch" : `${branchCount} branches`}
          </span>
        )}
      </div>

      {(exceedsStock || exceedsAllocation) && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {exceedsStock
              ? `Only ${formatQuantity(item.stockQuantity)} ${item.unit} in stock for all branches combined.`
              : `One or more branches have only ${formatQuantity(item.quantityBudgetRemaining ?? 0)} ${item.unit} allocated.`}
            {" "}Those branches may be skipped.
          </span>
        </p>
      )}

      {item.quantityBudgetRemaining !== null && !exceedsAllocation && (
        <Badge variant="secondary" className="mt-2 w-fit text-[10px]">
          {formatQuantity(item.quantityBudgetRemaining)} {item.unit} allocated per branch
        </Badge>
      )}
    </li>
  )
}

function QuantityStepper({
  value,
  step,
  label,
  onChange,
}: Readonly<{
  value: number
  step: number
  label: string
  onChange: (value: number) => void
}>) {
  const [draft, setDraft] = useState<string | null>(null)

  const commit = (raw: string) => {
    const parsed = parseQuantity(raw)
    onChange(Number.isFinite(parsed) && parsed > 0 ? parsed : 0)
    setDraft(null)
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        aria-label={`Decrease ${label}`}
        disabled={value <= 0}
        onClick={() => onChange(Math.max(0, roundQuantity(value - step)))}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <Input
        value={draft ?? (value > 0 ? String(value) : "")}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur()
        }}
        inputMode="decimal"
        placeholder="0"
        aria-label={label}
        className="h-8 w-16 text-center"
      />
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-8 w-8"
        aria-label={`Increase ${label}`}
        onClick={() => onChange(roundQuantity(value + step))}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

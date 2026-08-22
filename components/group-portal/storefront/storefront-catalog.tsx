"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { Building2, Info, Loader2, Package, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher } from "@/lib/fetcher"
import { sanitizeQuantityStep } from "@/lib/quantity"
import { cn } from "@/lib/utils"

import type { CatalogItem, CatalogResponse, CatalogSort, SelectedLine } from "../types"
import { StorefrontProductCard } from "./storefront-product-card"

const SEARCH_DEBOUNCE_MS = 300
const SKELETON_COUNT = 8

const SORT_OPTIONS: Array<{ value: CatalogSort; label: string }> = [
  { value: "name", label: "Sort: Name (A-Z)" },
  { value: "price-low", label: "Price: Low to High" },
  { value: "price-high", label: "Price: High to Low" },
]

/** The quantity a card starts on before the user touches it. */
function defaultSelection(item: CatalogItem, step: number): number {
  return item.stockQuantity > 0 ? step : 0
}

/**
 * The storefront's product surface for the locations currently ticked.
 *
 * The catalogue is the intersection across those locations: a product appears
 * only if every ticked location can receive it. That is what makes one cart
 * valid for all of them, and the number of products left out is shown so an
 * unexpectedly short list is never silent.
 *
 * Search, sort, and category all resolve on the server, because the list is
 * paged there — filtering only the page in hand would quietly hide products the
 * user asked to see.
 */
export function StorefrontCatalog({
  groupId,
  branchIds,
  lines,
  onSetQuantity,
  onOpenCart,
}: Readonly<{
  groupId: number | null | undefined
  branchIds: number[]
  lines: SelectedLine[]
  onSetQuantity: (item: CatalogItem, quantity: number) => void
  onOpenCart: () => void
}>) {
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<CatalogSort>("name")
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [selections, setSelections] = useState<Record<number, number>>({})
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  // A location coming or going changes which products are orderable at all, so
  // the paging position it was read at no longer means anything.
  const branchKey = useMemo(
    () => [...branchIds].sort((left, right) => left - right).join(","),
    [branchIds],
  )
  useEffect(() => {
    setPage(1)
    setCategoryId(null)
  }, [branchKey])

  const catalogUrl = useMemo(() => {
    if (branchIds.length === 0) return null
    const params = new URLSearchParams({ branchIds: branchKey, page: String(page), sort })
    if (groupId !== null && groupId !== undefined) params.set("groupId", String(groupId))
    if (search.trim()) params.set("search", search.trim())
    if (categoryId !== null) params.set("subCategory", String(categoryId))
    return `/api/v1/group-portal/catalog?${params.toString()}`
  }, [branchIds.length, branchKey, categoryId, groupId, page, search, sort])

  const { data, error, isLoading } = useSWR<CatalogResponse>(catalogUrl, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  })

  const quantityByInventoryId = useMemo(
    () => new Map(lines.map((line) => [line.organizationInventoryId, line.quantity])),
    [lines],
  )

  const items = data?.items ?? []
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1
  // A page change or a search keeps the previous results on screen, so say when
  // what is being looked at is about to be replaced.
  const isRefreshing = isLoading && items.length > 0

  /** Paging from the bottom of a long grid should not leave the user there. */
  const changePage = (next: number) => {
    setPage(next)
    const prefersReducedMotion = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    listRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    })
  }

  if (branchIds.length === 0) {
    return <NoLocationsSelected hasGroup={groupId !== undefined} />
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search products by name or code..."
            aria-label="Search products"
            className="h-11 pl-9"
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
        <select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as CatalogSort)
            setPage(1)
          }}
          aria-label="Sort products"
          className="h-11 rounded-lg border bg-white px-3 text-sm font-medium dark:bg-slate-800"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <CategoryRibbon
        categories={data?.categoryFacets ?? []}
        activeId={categoryId}
        onSelect={(next) => {
          setCategoryId(next)
          setPage(1)
        }}
      />

      {data && data.excludedProductCount > 0 && (
        <Card className="rounded-xl border-sky-200 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20">
          <CardContent className="flex items-start gap-2 p-3 text-xs text-slate-700 dark:text-slate-300">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
            <span>
              {data.excludedProductCount} product{data.excludedProductCount === 1 ? " is" : "s are"} hidden
              because {data.excludedProductCount === 1 ? "it is" : "they are"} not stocked at every
              location you ticked. Untick those locations to see {data.excludedProductCount === 1 ? "it" : "them"}.
            </span>
          </CardContent>
        </Card>
      )}

      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Products
          </h2>
          <p className="text-xs text-muted-foreground">
            Showing items orderable at{" "}
            {branchIds.length === 1 ? "the selected location" : `all ${branchIds.length} selected locations`}.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {isRefreshing && (
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Updating…
            </span>
          )}
          {data && data.total > 0 && (
            <span>{data.total} item{data.total === 1 ? "" : "s"} found</span>
          )}
        </div>
      </div>

      <div ref={listRef} className="scroll-mt-24">
        <CatalogGrid
          items={items}
          loading={isLoading}
          failed={Boolean(error)}
          refreshing={isRefreshing}
          branchCount={branchIds.length}
          quantityByInventoryId={quantityByInventoryId}
          selections={selections}
          onSelectionChange={(id, quantity) => setSelections((current) => ({ ...current, [id]: quantity }))}
          onSetQuantity={onSetQuantity}
          onOpenCart={onOpenCart}
        />
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-3 pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1 || isLoading}
            onClick={() => changePage(page - 1)}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages || isLoading}
            onClick={() => changePage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}

function NoLocationsSelected({ hasGroup }: Readonly<{ hasGroup: boolean }>) {
  return (
    <Card className="rounded-2xl border-dashed">
      <CardContent className="flex flex-col items-center gap-2 px-6 py-16 text-center">
        <Building2 className="h-10 w-10 text-muted-foreground opacity-40" />
        <p className="text-base font-medium text-slate-700 dark:text-slate-200">
          {hasGroup ? "Tick at least one location" : "Choose a group to start"}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {hasGroup
            ? "Products are shown once you pick the locations this order is for. Every quantity you enter is ordered for each ticked location."
            : "Pick one of your groups in the menu, then tick the locations you are ordering for."}
        </p>
      </CardContent>
    </Card>
  )
}

function CategoryRibbon({
  categories,
  activeId,
  onSelect,
}: Readonly<{
  categories: Array<{ id: number; name: string }>
  activeId: number | null
  onSelect: (categoryId: number | null) => void
}>) {
  if (categories.length === 0) return null

  const chips: Array<{ id: number | null; name: string }> = [{ id: null, name: "All" }, ...categories]

  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <div className="flex items-center gap-2">
        {chips.map((chip) => (
          <Button
            key={chip.id ?? "all"}
            type="button"
            onClick={() => onSelect(chip.id)}
            variant={activeId === chip.id ? "default" : "outline"}
            className={cn(
              "whitespace-nowrap rounded-full px-5 py-2 text-xs font-bold transition-all",
              activeId !== chip.id && "bg-white/50 backdrop-blur-md dark:bg-slate-800/50",
            )}
          >
            {chip.name}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** The grid and every state it can be in, kept apart from the filters above it. */
function CatalogGrid({
  items,
  loading,
  failed,
  refreshing,
  branchCount,
  quantityByInventoryId,
  selections,
  onSelectionChange,
  onSetQuantity,
  onOpenCart,
}: Readonly<{
  items: CatalogItem[]
  loading: boolean
  failed: boolean
  refreshing: boolean
  branchCount: number
  quantityByInventoryId: Map<number, number>
  selections: Record<number, number>
  onSelectionChange: (organizationInventoryId: number, quantity: number) => void
  onSetQuantity: (item: CatalogItem, quantity: number) => void
  onOpenCart: () => void
}>) {
  if (loading && items.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: SKELETON_COUNT }, (_, index) => `catalog-skeleton-${index}`).map((key) => (
          <Card key={key} className="flex h-full flex-col overflow-hidden">
            <Skeleton className="h-40 w-full" />
            <div className="flex flex-1 flex-col gap-3 p-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <div className="flex-1" />
              <Skeleton className="h-9 w-full" />
            </div>
          </Card>
        ))}
      </div>
    )
  }

  if (failed) {
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
      <div className="py-16 text-center">
        <Package className="mx-auto mb-4 h-12 w-12 text-muted-foreground opacity-50" />
        <p className="text-lg font-medium text-muted-foreground">No products found</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing matches this search at every location you ticked.
        </p>
      </div>
    )
  }

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 transition-opacity sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
        refreshing && "opacity-50",
      )}
    >
      {items.map((item) => {
        const step = sanitizeQuantityStep(item.allowDecimalQuantity, item.quantityStep)
        const cartQuantity = quantityByInventoryId.get(item.organizationInventoryId) ?? 0
        const selectionQuantity = selections[item.organizationInventoryId]
          ?? (cartQuantity > 0 ? cartQuantity : defaultSelection(item, step))

        return (
          <StorefrontProductCard
            key={item.organizationInventoryId}
            item={item}
            branchCount={branchCount}
            cartQuantity={cartQuantity}
            selectionQuantity={selectionQuantity}
            step={step}
            onSelectionChange={(quantity) => onSelectionChange(item.organizationInventoryId, quantity)}
            onAddToCart={() => onSetQuantity(item, selectionQuantity)}
            onOpenCart={onOpenCart}
          />
        )
      })}
    </div>
  )
}

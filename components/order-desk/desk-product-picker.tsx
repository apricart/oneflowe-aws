"use client"

import { useState } from "react"
import useSWR from "swr"
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react"

import { QuantityStepper } from "@/components/group-portal/quantity-stepper"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDebounce } from "@/hooks/use-debounce"
import { fetcher } from "@/lib/fetcher"
import { DESK_CATALOGUE_SEARCH_MAX_LENGTH, deskCatalogueUrl } from "@/lib/order-desk-catalogue-query"
import {
  chosenLines,
  isDeskPriceChanged,
  lineProductOf,
  parseDeskPriceInput,
  type DeskCatalogueItem,
  type DeskDraftLine,
  type DeskLineProduct,
  type DeskLines,
} from "@/lib/order-desk-draft"
import { formatQuantity, parseQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

type CataloguePage = {
  items: DeskCatalogueItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

type PickerHandlers = Readonly<{
  disabled: boolean
  onQuantity: (product: DeskLineProduct, quantity: string) => void
  onPrice: (product: DeskLineProduct, price: string) => void
}>

function quantityOf(line: DeskDraftLine | undefined): number {
  const quantity = parseQuantity(line?.quantity || 0)
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0
}

function CatalogueLabel({ product }: Readonly<{ product: DeskLineProduct }>) {
  if (!product.assignedToBranch) {
    return <span className="rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-100">Not in branch catalogue</span>
  }
  return (
    <span className="rounded bg-emerald-100 px-1.5 py-0.5 font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
      {product.cataloguePriceCents === null ? "In branch catalogue" : `Branch price ${formatPKR(product.cataloguePriceCents / 100)}`}
    </span>
  )
}

/**
 * One product: its quantity, and the price the customer agreed, including tax.
 * The price box starts empty for every product — whatever the branch is
 * normally charged — and once the product is ordered it must be filled in.
 */
export function DeskProductRow({
  product,
  line,
  disabled,
  onQuantity,
  onPrice,
}: Readonly<{ product: DeskLineProduct; line: DeskDraftLine | undefined }> & PickerHandlers) {
  const quantity = quantityOf(line)
  const ordered = quantity > 0
  const price = parseDeskPriceInput(line?.price, product.name)
  // Blank is only a problem once the product is ordered; a malformed figure always is.
  const priceProblem = price.kind === "invalid" || (ordered && price.kind === "missing") ? price : null
  const errorId = `desk-price-error-${product.globalProductId}`
  const outOfStock = product.stockQuantity !== undefined && product.stockQuantity <= 0
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 transition-colors", ordered && "bg-indigo-50/70 dark:bg-indigo-950/30")}>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate font-medium">{product.name}</p>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{product.productCode ?? "—"} · per {product.unit}</span>
          {product.stockQuantity !== undefined && (
            <span className={cn(outOfStock && "font-medium text-amber-700 dark:text-amber-400")}>
              · {outOfStock ? "Out of stock" : `${formatQuantity(product.stockQuantity)} in stock`}
            </span>
          )}
          <CatalogueLabel product={product} />
          {line && isDeskPriceChanged(line) && <span className="font-medium text-indigo-700 dark:text-indigo-300">Differs from branch price</span>}
        </p>
        {priceProblem && (
          <p id={errorId} className="text-xs font-medium text-rose-600 dark:text-rose-400">
            {priceProblem.kind === "missing" ? "Price required" : priceProblem.error}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <div className="relative w-32">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" aria-hidden="true">Rs</span>
          <Input
            aria-label={`Price per ${product.unit} of ${product.name}, in rupees including tax`}
            aria-required={ordered}
            aria-invalid={Boolean(priceProblem)}
            aria-describedby={priceProblem ? errorId : undefined}
            inputMode="decimal"
            placeholder="Price incl. tax"
            value={line?.price ?? ""}
            disabled={disabled}
            onChange={(event) => onPrice(product, event.target.value)}
            className={cn("h-9 pl-8 text-right tabular-nums", priceProblem && "border-rose-400 focus-visible:ring-rose-400")}
          />
        </div>
        <QuantityStepper
          value={quantity}
          step={sanitizeQuantityStep(product.allowDecimalQuantity, product.quantityStep)}
          label={`Quantity of ${product.name}`}
          disabled={disabled}
          onChange={(next) => onQuantity(product, next > 0 ? String(next) : "")}
        />
      </div>
    </li>
  )
}

function CatalogueResults({
  url,
  lines,
  handlers,
  onPage,
}: Readonly<{ url: string; lines: DeskLines; handlers: PickerHandlers; onPage: (page: number) => void }>) {
  const { data, error, isLoading } = useSWR<CataloguePage>(url, fetcher, { keepPreviousData: true })
  if (error) return <p role="alert" className="text-sm text-destructive">Could not load Apricart&apos;s products.</p>
  if (!data && isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading products…
      </p>
    )
  }
  if (!data || data.items.length === 0) return <p className="text-sm text-muted-foreground">No product matches.</p>
  const { page, totalPages, total } = data.pagination
  return (
    <div className="space-y-2">
      <ul className="max-h-[460px] divide-y overflow-auto rounded-md border" aria-label="Apricart products">
        {data.items.map((item) => (
          <DeskProductRow
            key={item.globalProductId}
            product={lines[item.globalProductId]?.product ?? lineProductOf(item)}
            line={lines[item.globalProductId]}
            {...handlers}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{total} product{total === 1 ? "" : "s"} · page {page} of {Math.max(totalPages, 1)}</span>
        <div className="flex gap-1">
          <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Apricart's whole active catalogue for one branch the desk reaches, searched
 * and paged on the server, with the products already chosen one click away.
 * Chosen lines live in the caller's draft, keyed by product, so they survive
 * a new search or another page.
 */
export function DeskProductPicker({
  organizationId,
  branchId,
  lines,
  initialView = "all",
  ...handlers
}: Readonly<{
  organizationId: number
  branchId: number
  lines: DeskLines
  initialView?: "all" | "selected"
}> & PickerHandlers) {
  const [view, setView] = useState<"all" | "selected">(initialView)
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebounce(search.trim(), 300)
  // The page belongs to one search: a new search starts again at page 1.
  const [paging, setPaging] = useState({ search: "", page: 1 })
  const page = paging.search === debouncedSearch ? paging.page : 1
  const chosen = chosenLines(lines)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which products to show">
        <Button type="button" size="sm" variant={view === "all" ? "default" : "outline"} aria-pressed={view === "all"} onClick={() => setView("all")}>
          All products
        </Button>
        <Button type="button" size="sm" variant={view === "selected" ? "default" : "outline"} aria-pressed={view === "selected"} onClick={() => setView("selected")}>
          Selected ({chosen.length})
        </Button>
      </div>

      {view === "selected" ? (
        chosen.length === 0
          ? <p className="text-sm text-muted-foreground">No products chosen yet.</p>
          : (
            <ul className="max-h-[460px] divide-y overflow-auto rounded-md border" aria-label="Selected products">
              {chosen.map((line) => (
                <DeskProductRow key={line.product.globalProductId} product={line.product} line={line} {...handlers} />
              ))}
            </ul>
          )
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              aria-label="Search products"
              placeholder="Search Apricart products by name or code"
              maxLength={DESK_CATALOGUE_SEARCH_MAX_LENGTH}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
            />
          </div>
          <CatalogueResults
            url={deskCatalogueUrl({ organizationId, branchId, search: debouncedSearch, page })}
            lines={lines}
            handlers={handlers}
            onPage={(next) => setPaging({ search: debouncedSearch, page: next })}
          />
        </>
      )}
    </div>
  )
}

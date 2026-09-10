"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Loader2, Package, Search, X } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"

/**
 * Choosing the product a query is about.
 *
 * Reads as the Category select beside it — a trigger showing the current
 * choice, a panel of options under it — with a search box at the head of the
 * panel, because a tenant's catalogue is thousands of rows rather than five.
 *
 * Assembled from a button and a listbox rather than a Popover/Command pairing:
 * this lives inside the raise-a-query Dialog, and nesting one Radix portal with
 * its own focus trap inside another is a reliable source of focus bugs. An
 * inline panel needs neither.
 *
 * The search runs on the server, scoped to the caller's organization — the list
 * is never filtered client-side, because only the first twenty matches are
 * fetched and filtering those again would hide results the server did return.
 */

export type SupportProduct = {
  id: number
  productCode: string
  name: string
}

type ProductSearchResponse = { items: SupportProduct[] }

/** Long enough that typing does not fire a request per keystroke. */
const DEBOUNCE_MS = 250

/** Mirrors `SelectTrigger`, so the field sits level with the Category select. */
const TRIGGER_CLASS =
  "flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50"

export function ProductPicker({
  value,
  onChange,
  required = false,
  error = null,
  disabled = false,
}: Readonly<{
  value: SupportProduct | null
  onChange: (product: SupportProduct | null) => void
  /** Set by the category: everything but `OTHER` must name a product. */
  required?: boolean
  /** Shown under the field once a submission has been refused for want of one. */
  error?: string | null
  disabled?: boolean
}>) {
  const triggerId = useId()
  const listId = useId()
  const errorId = useId()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  // Only searched while the panel is open, so opening the dialog does not fetch
  // a catalogue nobody asked for. An empty term lists the first page of it,
  // which is what makes the closed field behave like a select.
  const { data, isLoading } = useAPI<ProductSearchResponse>(
    open ? `/api/v1/support/products?q=${encodeURIComponent(debounced)}` : null,
    { keepPreviousData: true },
  )

  const items = useMemo(() => data?.items ?? [], [data])

  useEffect(() => {
    setActiveIndex(0)
  }, [debounced])

  // Typing goes to the search box, so it takes focus as the panel opens.
  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  function close({ restoreFocus }: { restoreFocus: boolean }) {
    setOpen(false)
    setQuery("")
    if (restoreFocus) triggerRef.current?.focus()
  }

  function choose(product: SupportProduct) {
    onChange(product)
    close({ restoreFocus: true })
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, items.length - 1))
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === "Enter") {
      event.preventDefault()
      const item = items[activeIndex]
      if (item) choose(item)
    } else if (event.key === "Escape") {
      // Closes the panel and stops there, rather than the Dialog behind it.
      event.preventDefault()
      event.stopPropagation()
      close({ restoreFocus: true })
    }
  }

  const invalid = Boolean(error)
  const clearable = Boolean(value) && !required && !disabled

  return (
    <div className="space-y-1.5">
      <Label htmlFor={triggerId}>
        Product
        {required ? null : (
          <span className="font-normal text-muted-foreground"> (optional)</span>
        )}
      </Label>

      <div
        ref={containerRef}
        className="relative"
        onBlur={(event) => {
          // Focus moving within the field — trigger to search box, say — is not
          // a dismissal; focus leaving it is.
          if (containerRef.current?.contains(event.relatedTarget)) return
          close({ restoreFocus: false })
        }}
      >
        <button
          id={triggerId}
          ref={triggerRef}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-invalid={invalid}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setOpen(true)
            }
          }}
          className={cn(
            TRIGGER_CLASS,
            clearable && "pr-14",
            invalid && "border-destructive ring-[3px] ring-destructive/20 dark:ring-destructive/40",
          )}
        >
          {value ? (
            <span className="flex min-w-0 items-center gap-2">
              <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                <span className="font-mono font-semibold">{value.productCode}</span>
                <span className="text-muted-foreground"> · {value.name}</span>
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Select a product</span>
          )}
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </button>

        {clearable && value ? (
          <button
            type="button"
            aria-label={`Remove product ${value.productCode}`}
            onClick={() => onChange(null)}
            className="absolute right-8 top-1/2 -translate-y-1/2 rounded-sm text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}

        {open ? (
          <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <div className="relative border-b p-2">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchRef}
                value={query}
                autoComplete="off"
                aria-label="Search products by code or name"
                aria-controls={listId}
                aria-autocomplete="list"
                placeholder="Search by code or name"
                className="h-8 pl-8 pr-8"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
              />
              {isLoading ? (
                <Loader2 className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            <ProductOptions
              listId={listId}
              items={items}
              isLoading={isLoading}
              activeIndex={activeIndex}
              selectedId={value?.id ?? null}
              onHighlight={setActiveIndex}
              onChoose={choose}
            />
          </div>
        ) : null}
      </div>

      {invalid ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** The matches themselves, kept apart so the field above stays readable. */
function ProductOptions({
  listId,
  items,
  isLoading,
  activeIndex,
  selectedId,
  onHighlight,
  onChoose,
}: Readonly<{
  listId: string
  items: SupportProduct[]
  isLoading: boolean
  activeIndex: number
  selectedId: number | null
  onHighlight: (index: number) => void
  onChoose: (product: SupportProduct) => void
}>) {
  return (
    <ul
      id={listId}
      role="listbox"
      aria-label="Matching products"
      className="max-h-52 overflow-y-auto p-1"
    >
      {items.length === 0 ? (
        <li className="px-2 py-2 text-sm text-muted-foreground">
          {isLoading ? "Searching…" : "No product matches that."}
        </li>
      ) : (
        items.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              role="option"
              aria-selected={item.id === selectedId}
              // Keeps focus in the search box, so the click lands before the
              // field's blur handler can close the panel under it.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => onHighlight(index)}
              onClick={() => onChoose(item)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-left text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              <span className="font-mono text-xs font-semibold text-muted-foreground">
                {item.productCode}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.id === selectedId ? <Check className="h-4 w-4 shrink-0" /> : null}
            </button>
          </li>
        ))
      )}
    </ul>
  )
}

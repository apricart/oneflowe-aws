"use client"

import { AlertTriangle, Package, Plus, RefreshCw, ShoppingBag, Zap } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { formatQuantity, roundQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

import { QuantityStepper } from "../quantity-stepper"
import type { CatalogItem } from "../types"

/** The label the action button carries, given what is selected and what is in the cart. */
function CardActionContent({
  modified,
  inCart,
  selectionQuantity,
}: Readonly<{
  modified: boolean
  inCart: boolean
  selectionQuantity: number
}>) {
  if (modified) {
    return (
      <>
        {inCart ? <RefreshCw className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        <span>{inCart ? "Update cart" : `Add ${formatQuantity(selectionQuantity)} to cart`}</span>
      </>
    )
  }
  if (inCart) {
    return (
      <>
        <ShoppingBag className="h-4 w-4" />
        <span>Open cart</span>
      </>
    )
  }
  return (
    <>
      <Plus className="h-4 w-4" />
      <span>Add to cart</span>
    </>
  )
}

/**
 * A shortfall this product will hit at one or more of the ticked locations.
 *
 * Stock is held once per branch order, so the whole batch draws on the same
 * pool; an allocation, by contrast, is per branch and the catalogue already
 * reports the smallest one. Both are warnings rather than blocks: the server
 * decides per branch at submission, and a branch that cannot be served is
 * skipped with its own reason rather than failing the group order.
 */
function shortfallMessage(
  item: CatalogItem,
  quantity: number,
  branchCount: number,
): string | null {
  if (quantity <= 0) return null

  if (roundQuantity(quantity * branchCount) > item.stockQuantity) {
    return `Only ${formatQuantity(item.stockQuantity)} ${item.unit} in stock for all locations combined.`
  }
  if (item.quantityBudgetRemaining !== null && quantity > item.quantityBudgetRemaining) {
    return `One or more locations have only ${formatQuantity(item.quantityBudgetRemaining)} ${item.unit} allocated.`
  }
  return null
}

/**
 * One product, as the storefront presents it.
 *
 * The quantity shown is what each ticked location receives, not the total — the
 * card states the combined figure separately so the two are never confused.
 * Nothing here decides whether an order can be placed; it reports what the
 * catalogue said so the user can correct course before submitting.
 */
export function StorefrontProductCard({
  item,
  branchCount,
  cartQuantity,
  selectionQuantity,
  step,
  onSelectionChange,
  onAddToCart,
  onOpenCart,
}: Readonly<{
  item: CatalogItem
  branchCount: number
  cartQuantity: number
  selectionQuantity: number
  step: number
  onSelectionChange: (quantity: number) => void
  onAddToCart: () => void
  onOpenCart: () => void
}>) {
  const inCart = cartQuantity > 0
  const modified = roundQuantity(selectionQuantity) !== roundQuantity(cartQuantity)
  const outOfStock = item.stockQuantity <= 0
  const totalAcrossLocations = roundQuantity(selectionQuantity * branchCount)
  const shortfall = shortfallMessage(item, selectionQuantity, branchCount)

  return (
    <Card
      className={cn(
        "flex h-full flex-col overflow-hidden shadow-sm ring-1 ring-black/5 transition-all duration-300",
        "bg-white/60 backdrop-blur-xl hover:-translate-y-1 hover:shadow-xl dark:bg-slate-900/60",
        inCart
          ? "border-[color:var(--color-brand-primary)]"
          : "border-white/20 dark:border-slate-800/50",
      )}
    >
      <div className="relative h-40 w-full overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700">
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Package className="h-14 w-14 text-slate-400 opacity-30" />
          </div>
        )}

        <Badge
          className="absolute left-2 top-2 border-0 px-2 py-0.5 text-[11px] font-medium text-white"
          style={{ background: "color-mix(in oklab, var(--color-brand-primary), transparent 10%)" }}
        >
          <Zap className="mr-1 h-3 w-3" />
          Trending
        </Badge>

        <Badge
          className={cn(
            "absolute right-2 top-2 border-0 text-white shadow-sm",
            outOfStock ? "bg-rose-500" : "bg-emerald-500",
          )}
        >
          {outOfStock ? "Out of stock" : `${formatQuantity(item.stockQuantity)} in stock`}
        </Badge>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <h3
            className="line-clamp-2 text-sm font-bold text-slate-900 dark:text-white"
            title={item.name}
          >
            {item.name}
          </h3>
          {item.productCode && (
            <p className="font-mono text-xs text-muted-foreground">{item.productCode}</p>
          )}
          {item.description && (
            <p className="mt-1 line-clamp-1 text-xs text-slate-500 dark:text-slate-400">
              {item.description}
            </p>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-baseline justify-between border-t border-slate-200 pt-2 dark:border-slate-700">
          <p className="text-xl font-bold text-[color:var(--color-brand-primary)]">
            {formatPKR(item.priceCents / 100)}
          </p>
          <p className="text-xs text-muted-foreground">per {item.unit}</p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <QuantityStepper
            value={selectionQuantity}
            step={step}
            label={`Quantity of ${item.name} per location`}
            onChange={onSelectionChange}
          />
          {branchCount > 1 && selectionQuantity > 0 && (
            <span className="text-right text-[11px] leading-tight text-slate-500 dark:text-slate-400">
              <span className="block font-medium text-slate-700 dark:text-slate-200">
                {formatQuantity(totalAcrossLocations)} {item.unit}
              </span>
              across {branchCount} locations
            </span>
          )}
        </div>

        {item.quantityBudgetRemaining !== null && !shortfall && (
          <Badge variant="secondary" className="w-fit text-[10px]">
            {formatQuantity(item.quantityBudgetRemaining)} {item.unit} allocated per location
          </Badge>
        )}

        {shortfall && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{shortfall} Those locations may be skipped.</span>
          </p>
        )}

        <Button
          type="button"
          variant={modified || !inCart ? "default" : "outline"}
          className="w-full gap-2"
          disabled={modified && selectionQuantity <= 0 && !inCart}
          onClick={modified ? onAddToCart : onOpenCart}
        >
          <CardActionContent
            modified={modified}
            inCart={inCart}
            selectionQuantity={selectionQuantity}
          />
        </Button>
      </div>
    </Card>
  )
}

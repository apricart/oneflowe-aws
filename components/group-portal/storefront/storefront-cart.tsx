"use client"

import { ArrowRight, Building2, ShoppingBag, Trash2 } from "lucide-react"

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
import { calculateLineCents, sanitizeQuantityStep } from "@/lib/quantity"
import { formatPKR } from "@/lib/utils"

import { entryTotalCents } from "../group-order-plan"
import { QuantityStepper } from "../quantity-stepper"
import type { ScopedBranch, SelectedLine } from "../types"

/**
 * The cart, which holds one set of items for every ticked location.
 *
 * The distinction that matters here is per-location versus combined: a quantity
 * of 5 across three locations is fifteen units and three separate orders. Both
 * figures are stated rather than left to be worked out, because the combined
 * one is what the budgets are actually spent against.
 */
export function StorefrontCart({
  open,
  lines,
  branches,
  onOpenChange,
  onQuantityChange,
  onRemove,
  onClear,
  onCheckout,
}: Readonly<{
  open: boolean
  lines: SelectedLine[]
  branches: ScopedBranch[]
  onOpenChange: (open: boolean) => void
  onQuantityChange: (organizationInventoryId: number, quantity: number) => void
  onRemove: (organizationInventoryId: number) => void
  onClear: () => void
  onCheckout: () => void
}>) {
  const perLocationCents = entryTotalCents(lines)
  const locationCount = branches.length
  const combinedCents = perLocationCents * locationCount
  const canCheckout = lines.length > 0 && locationCount > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5" />
            Your cart
          </DialogTitle>
          <DialogDescription>
            Every quantity below is ordered for each selected location.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <LocationSummary branches={branches} />

          {lines.length === 0 ? (
            <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
              Your cart is empty. Add products from the storefront to get started.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {lines.map((line) => (
                <li key={line.organizationInventoryId} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={line.name}>
                      {line.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatPKR(line.priceCents / 100)} per {line.unit}
                    </p>
                  </div>
                  <QuantityStepper
                    value={line.quantity}
                    step={sanitizeQuantityStep(Boolean(line.allowDecimalQuantity), line.quantityStep ?? 1)}
                    label={`Quantity of ${line.name} per location`}
                    onChange={(quantity) => onQuantityChange(line.organizationInventoryId, quantity)}
                  />
                  <span className="w-24 text-right font-mono text-sm tabular-nums text-slate-800 dark:text-slate-200">
                    {formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-slate-400 hover:text-rose-600"
                    aria-label={`Remove ${line.name} from the cart`}
                    onClick={() => onRemove(line.organizationInventoryId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {lines.length > 0 && (
            <dl className="space-y-1 rounded-xl bg-slate-50 p-4 text-sm dark:bg-slate-800/50">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Per location</dt>
                <dd className="font-mono tabular-nums">{formatPKR(perLocationCents / 100)}</dd>
              </div>
              <div className="flex items-center justify-between text-base font-semibold">
                <dt>
                  Combined
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    ({locationCount} {locationCount === 1 ? "location" : "locations"})
                  </span>
                </dt>
                <dd className="font-mono tabular-nums">{formatPKR(combinedCents / 100)}</dd>
              </div>
            </dl>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            className="text-rose-600 hover:text-rose-700"
            disabled={lines.length === 0}
            onClick={onClear}
          >
            Clear cart
          </Button>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Continue shopping
            </Button>
            <Button type="button" className="gap-2" disabled={!canCheckout} onClick={onCheckout}>
              Review order
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Which locations this cart will be raised for, named rather than counted. */
function LocationSummary({ branches }: Readonly<{ branches: ScopedBranch[] }>) {
  if (branches.length === 0) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-slate-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-slate-300">
        No locations are ticked, so this cart cannot be submitted yet. Tick at least one location in
        the menu.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 p-3 dark:border-slate-800">
      <span className="mr-1 flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300">
        <Building2 className="h-3.5 w-3.5" />
        Ordering for
      </span>
      {branches.map((branch) => (
        <Badge key={branch.id} variant="secondary" className="text-[11px]">
          {branch.name}
        </Badge>
      ))}
    </div>
  )
}

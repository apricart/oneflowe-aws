import { MAX_PRICE_CENTS } from "@/lib/price-ladder"

/**
 * The price an order line is charged, when the Order Desk may have typed one
 * (plans/OF-ORDER-DESK-line-price-entry.md).
 *
 * The catalogue price comes from the price ladder (`resolveEffectivePriceCents`)
 * and is passed in; this only decides between it and what the desk entered.
 * Who may enter one is `lib/pricing-access.ts` (`orderLinePriceFailure`).
 *
 * Both figures are tax-inclusive, exactly like a catalogue price, so the line's
 * tax split is computed from the result the same way either way.
 */

/** The smallest entered price: a desk line is never given away for nothing. */
export const MIN_ENTERED_UNIT_PRICE_CENTS = 1

export function isValidEnteredUnitPriceCents(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= MIN_ENTERED_UNIT_PRICE_CENTS
    && value <= MAX_PRICE_CENTS
}

export type ResolvedOrderLinePrice =
  | {
    ok: true
    /** What the line is charged per unit. */
    priceCents: number
    /** True when the desk's figure replaced the catalogue's. */
    priceEnteredManually: boolean
    /** The catalogue price it replaced; null unless `priceEnteredManually`. */
    cataloguePriceCents: number | null
  }
  | { ok: false; reason: "no-price" | "invalid-entered-price" }

/**
 * No entered price charges the catalogue price, as every order always has. An
 * entered price equal to the catalogue price is the catalogue price — re-typing
 * the same figure is not a price change, and must not be flagged as one.
 */
export function resolveOrderLinePrice(input: {
  cataloguePriceCents: number | null | undefined
  enteredPriceCents?: number | null
}): ResolvedOrderLinePrice {
  const catalogue = input.cataloguePriceCents
  const hasCatalogue = typeof catalogue === "number" && Number.isSafeInteger(catalogue) && catalogue >= 0
  const entered = input.enteredPriceCents

  if (entered === undefined || entered === null) {
    return hasCatalogue
      ? { ok: true, priceCents: catalogue, priceEnteredManually: false, cataloguePriceCents: null }
      : { ok: false, reason: "no-price" }
  }
  if (!isValidEnteredUnitPriceCents(entered)) return { ok: false, reason: "invalid-entered-price" }
  if (hasCatalogue && entered === catalogue) {
    return { ok: true, priceCents: catalogue, priceEnteredManually: false, cataloguePriceCents: null }
  }
  return {
    ok: true,
    priceCents: entered,
    priceEnteredManually: true,
    cataloguePriceCents: hasCatalogue ? catalogue : null,
  }
}

export type EnteredPriceLine = {
  organizationInventoryId: number | null
  productName: string
  priceCents: number
  cataloguePriceCents: number | null
}

/** The hand-priced lines of an order, with both figures, for its audit row. */
export function enteredPriceLines(items: readonly {
  organizationInventoryId?: number | null
  productName: string
  priceCents: number
  priceEnteredManually?: boolean
  cataloguePriceCents?: number | null
}[]): EnteredPriceLine[] {
  return items
    .filter((item) => item.priceEnteredManually === true)
    .map((item) => ({
      organizationInventoryId: item.organizationInventoryId ?? null,
      productName: item.productName,
      priceCents: item.priceCents,
      cataloguePriceCents: item.cataloguePriceCents ?? null,
    }))
}

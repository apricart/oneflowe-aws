/**
 * Tax-inclusive pricing.
 *
 * Product prices in this system are entered *inclusive* of sales tax: the
 * number an admin types into the catalogue is the gross amount a branch pays.
 * Orders still have to record the two components separately so the accounts
 * team can file output tax, so every order splits its gross line amounts into
 * a net subtotal and a tax figure at the moment it is written.
 *
 * The split never changes what is charged. `net + tax === gross` holds for each
 * individual line, and therefore for the order as a whole, which is what keeps
 * `orders.total_cents` — and every budget hold taken from it — byte-identical
 * to what the same order would have recorded before tax existed.
 *
 * Rates are stored in basis points (1800 = 18%) to match the convention already
 * used for percentage discounts on `global_products`.
 */

export const TAX_RATE_SETTING_KEY = "tax_rate"

/** 18%, the standard sales-tax rate applied unless a product overrides it. */
export const DEFAULT_TAX_RATE_BP = 1800

export const MAX_TAX_RATE_BP = 10000

export const BASIS_POINTS_PER_UNIT = 10000

export interface TaxSplitCents {
  netCents: number
  taxCents: number
  grossCents: number
}

export function isValidTaxRateBp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_TAX_RATE_BP
}

/**
 * Percent as entered by a human (18) to basis points (1800).
 *
 * Accepts fractional percentages such as 17.5 because provincial rates are not
 * always whole numbers; anything that does not land on a whole basis point is
 * rejected rather than silently rounded, since a rounded tax rate is wrong on
 * every order that ever uses it.
 */
export function taxRatePercentToBp(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null

  const bp = percent * 100
  if (!Number.isInteger(Math.round(bp * 1e6) / 1e6)) return null

  const rounded = Math.round(bp)
  return isValidTaxRateBp(rounded) ? rounded : null
}

export function taxRateBpToPercent(bp: number): number {
  return bp / 100
}

/**
 * Resolve the rate that applies to one product.
 *
 * A product-level rate of `null` means "follow the organization", so changing
 * the organization default moves every product that has not been given an
 * explicit override. That is deliberate: the alternative — stamping the default
 * onto each product row — freezes today's rate into rows nobody will remember
 * to revisit when the rate changes.
 */
export function resolveTaxRateBp(
  productTaxRateBp: unknown,
  organizationTaxRateBp: unknown,
): number {
  if (isValidTaxRateBp(productTaxRateBp)) return productTaxRateBp
  if (isValidTaxRateBp(organizationTaxRateBp)) return organizationTaxRateBp
  return DEFAULT_TAX_RATE_BP
}

/**
 * Split a tax-inclusive gross amount into its net and tax components.
 *
 * `tax` is derived by subtraction rather than computed independently so the two
 * parts always reconstruct the gross exactly. Computing both by multiplication
 * would let rounding put them a paisa apart, and an invoice whose components do
 * not add up to its total is the one thing accounts will always catch.
 */
export function splitInclusiveCents(grossCents: number, rateBp: number): TaxSplitCents {
  if (!Number.isSafeInteger(grossCents) || grossCents < 0) {
    throw new Error("grossCents must be a non-negative safe integer")
  }
  if (!isValidTaxRateBp(rateBp)) {
    throw new Error("rateBp must be an integer between 0 and 10000")
  }

  if (rateBp === 0) return { netCents: grossCents, taxCents: 0, grossCents }

  const netCents = Math.round((grossCents * BASIS_POINTS_PER_UNIT) / (BASIS_POINTS_PER_UNIT + rateBp))
  return { netCents, taxCents: grossCents - netCents, grossCents }
}

export interface TaxableLine {
  grossCents: number
  taxRateBp: number
}

export interface OrderTaxTotals extends TaxSplitCents {
  lines: TaxSplitCents[]
}

/**
 * Split a whole order, line by line.
 *
 * Lines are split individually and then summed, rather than the order total
 * being split in one go, because products may carry different rates. Summing
 * per-line results keeps `net + tax === gross` true at both levels, since each
 * line already reconciles on its own.
 */
export function splitOrderInclusiveCents(lines: TaxableLine[]): OrderTaxTotals {
  const split = lines.map((line) => splitInclusiveCents(line.grossCents, line.taxRateBp))

  return {
    lines: split,
    netCents: split.reduce((sum, line) => sum + line.netCents, 0),
    taxCents: split.reduce((sum, line) => sum + line.taxCents, 0),
    grossCents: split.reduce((sum, line) => sum + line.grossCents, 0),
  }
}

/**
 * Marks a product whose stored price excludes tax, unlike the rest of the
 * catalogue. Activating one would put a net-priced product into a system that
 * assumes gross, understating both the price base and the tax on every order
 * using it, so `getHistoricalProductActivationError` holds it back until an
 * admin restates the price.
 *
 * No product currently carries this marker. The K-Electric import used to set
 * it on everything it created, on the assumption that the legacy export was
 * net-priced. That assumption was wrong — K-Electric confirmed the export is
 * tax-inclusive — so the marker was cleared from all 147 of its products and
 * the importer no longer writes it. The mechanism is kept for a future import
 * whose source genuinely is net-priced.
 */
export function isHistoricalOnlyProduct(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false
  return (metadata as Record<string, unknown>).historicalOnly === true
}

import { isValidEnteredUnitPriceCents, resolveOrderLinePrice } from "@/lib/order-line-price"
import { calculateLineCents, validateProductQuantity } from "@/lib/quantity"
import { resolveTaxRateBp, splitInclusiveCents } from "@/lib/tax"

/**
 * An Order Desk order's lines, as pure rules
 * (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md).
 *
 * A desk line names an active Apricart **global product** — whether or not the
 * branch carries it — with a quantity and the price the customer agreed,
 * including tax. The price is required on every line and is what the line is
 * charged; the branch's own catalogue price, when the branch carries the
 * product, is only recorded beside it for the approving executive.
 *
 * Creation and the desk's edit both price through `priceDeskOrderLines`, so the
 * figure the executive approves and the figure an edit re-computes cannot
 * follow different rules. Who may send a desk line is `lib/pricing-access.ts`;
 * which branch it may be sent for is the desk's reach, checked by the caller.
 */

export type DeskOrderLineRequest = {
  globalProductId: number
  quantity: number
  /** Required: the agreed unit price, tax-inclusive, in cents. */
  unitPriceCents: number
}

/** The global product row a desk line is priced from, as locked by the caller. */
export type DeskLineProduct = {
  id: number
  name: string
  productCode: string | null
  unit: string
  status: string | null
  deletedAt: Date | string | null
  allowDecimalQuantity: boolean
  quantityStep: number | null
  taxRateBp: number | null
}

/**
 * Where the branch carries the product today: the organization-inventory row
 * behind an active, visible branch assignment, and the price the ladder gives
 * that branch. Absent when the branch does not carry it.
 */
export type DeskLineLineage = {
  organizationInventoryId: number
  cataloguePriceCents: number | null
}

export type PricedDeskLine = {
  /** Lineage only — never what made the product orderable. Null when the branch does not carry it. */
  organizationInventoryId: number | null
  globalProductId: number
  quantity: number
  priceCents: number
  priceEnteredManually: boolean
  cataloguePriceCents: number | null
  taxRateBp: number
  taxCents: number
  productName: string
  productCode: string | null
  unit: string
}

export type PricedDeskLines = {
  items: PricedDeskLine[]
  subtotalCents: number
  taxCents: number
  totalCents: number
}

export class DeskLineRefusal extends Error {}

export function isActiveDeskProduct(product: Pick<DeskLineProduct, "status" | "deletedAt"> | undefined): boolean {
  return Boolean(product) && product!.status === "active" && !product!.deletedAt
}

/**
 * Price, tax and validate every requested line. Throws `DeskLineRefusal` with a
 * message fit for the desk user on the first line it cannot honour; stock is
 * the caller's, because creation and an edit count it differently.
 *
 * The entered price is gross: `quantity × price` is the line amount and the
 * tax is the part of it `splitInclusiveCents` says it is, so net + tax equals
 * the gross exactly and no tax is ever added on top.
 */
export function priceDeskOrderLines(
  requested: readonly DeskOrderLineRequest[],
  context: {
    productById: ReadonlyMap<number, DeskLineProduct>
    lineageByProductId: ReadonlyMap<number, DeskLineLineage>
    organizationTaxRateBp: number
  },
): PricedDeskLines {
  let subtotalCents = 0
  let taxCents = 0
  let totalCents = 0
  const seen = new Set<number>()
  const items = requested.map((line) => {
    if (seen.has(line.globalProductId)) throw new DeskLineRefusal("Each product can only appear once in an order")
    seen.add(line.globalProductId)

    const product = context.productById.get(line.globalProductId)
    if (!product || !isActiveDeskProduct(product)) throw new DeskLineRefusal("A product in this order is no longer available")

    const quantity = validateProductQuantity(line.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!quantity.ok) throw new DeskLineRefusal(quantity.error)

    if (!isValidEnteredUnitPriceCents(line.unitPriceCents)) {
      throw new DeskLineRefusal(`Enter a price above zero for ${product.name}`)
    }
    const lineage = context.lineageByProductId.get(product.id)
    const price = resolveOrderLinePrice({
      cataloguePriceCents: lineage?.cataloguePriceCents ?? null,
      enteredPriceCents: line.unitPriceCents,
    })
    if (!price.ok) throw new DeskLineRefusal(`Enter a price above zero for ${product.name}`)

    const taxRateBp = resolveTaxRateBp(product.taxRateBp, context.organizationTaxRateBp)
    const split = splitInclusiveCents(calculateLineCents(price.priceCents, quantity.quantity), taxRateBp)
    subtotalCents += split.netCents
    taxCents += split.taxCents
    totalCents += split.grossCents
    return {
      organizationInventoryId: lineage?.organizationInventoryId ?? null,
      globalProductId: product.id,
      quantity: quantity.quantity,
      priceCents: price.priceCents,
      priceEnteredManually: price.priceEnteredManually,
      cataloguePriceCents: price.cataloguePriceCents,
      taxRateBp,
      taxCents: split.taxCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) throw new DeskLineRefusal("Calculated order total is invalid")
  return { items, subtotalCents, taxCents, totalCents }
}

/**
 * The printed shape of an invoice: a flat, numbered list of lines and the
 * totals block beneath it.
 *
 * Invoices are stored as a snapshot on the order, and snapshots written before
 * tax existed carry only a gross rate and line total. Every reader here falls
 * back to those older fields, so an invoice issued last year still prints the
 * figures it has always printed — the layout changes, the numbers do not.
 *
 * Both the on-screen invoice and the downloadable PDF build their rows from
 * this module so the two can never drift apart.
 */

export interface InvoiceLine {
  serial: number
  description: string
  quantity: number
  /** Unit price excluding tax. Null when prices are hidden for the role. */
  rate: number | null
  /** Null when the line carries no recorded tax rate. */
  taxPercent: number | null
  tax: number | null
  /** Line value excluding tax. Null when prices are hidden for the role. */
  amount: number | null
}

export interface InvoiceTotals {
  subTotal: number | null
  taxLabel: string
  taxAmount: number | null
  discount: number
  deliveryCharges: number
  refund: number
  rounding: number | null
  total: number | null
}

/** Prices are nulled out by the redaction layer for price-restricted roles. */
function toMoney(value: unknown): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toAmount(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Every item in the snapshot, in printed order.
 *
 * Snapshots nest items under main and sub categories. The invoice prints one
 * continuous numbered list instead, so the nesting is walked and discarded
 * here rather than in each renderer.
 */
function collectSnapshotItems(receiptData: any): any[] {
  const categories: any[] = Array.isArray(receiptData?.items) ? receiptData.items : []

  return categories.flatMap((category) => {
    const subCategories = Array.isArray(category?.subCategories) && category.subCategories.length > 0
      ? category.subCategories
      : [{ items: category?.items }]

    return subCategories.flatMap((subCategory: any) =>
      Array.isArray(subCategory?.items) ? subCategory.items : []
    )
  })
}

/**
 * `netRate` and `netAmount` are only present on snapshots written since tax
 * was recorded. Older ones fall back to the gross rate and total they have
 * always stored, which is exactly what those invoices print today.
 */
function toInvoiceLine(item: any, serial: number): InvoiceLine {
  const rate = item?.netRate === undefined ? toMoney(item?.rate) : toMoney(item.netRate)
  const amount = item?.netAmount === undefined ? toMoney(item?.total) : toMoney(item.netAmount)
  const taxPercent = toMoney(item?.taxPercent)

  return {
    serial,
    description: typeof item?.description === "string" ? item.description : "",
    quantity: toAmount(item?.quantity),
    rate,
    taxPercent: taxPercent === null || taxPercent === 0 ? null : taxPercent,
    tax: toMoney(item?.tax),
    amount,
  }
}

export function buildInvoiceLines(receiptData: any): InvoiceLine[] {
  return collectSnapshotItems(receiptData).map((item, index) => toInvoiceLine(item, index + 1))
}

/**
 * Name the tax row after the rate actually charged.
 *
 * A single rate across the invoice is named outright, matching the issued
 * paper format. Mixed rates cannot honestly claim one percentage, and neither
 * can an older snapshot that recorded tax only as an order-level figure, so
 * both fall back to the plain label.
 */
export function getInvoiceTaxLabel(lines: InvoiceLine[]): string {
  const rates = new Set(
    lines
      .filter((line) => line.taxPercent !== null && Number(line.tax || 0) !== 0)
      .map((line) => line.taxPercent as number)
  )

  if (rates.size !== 1) return "Sales Tax"

  const [rate] = [...rates]
  return `Standard Rate (${Number(rate.toFixed(2))}%)`
}

/**
 * The totals block.
 *
 * `rounding` is the residue between the components and the recorded total. It
 * is zero for invoices priced by this system, because a line's net and tax are
 * defined to reconstruct its gross exactly. It exists so that any snapshot
 * whose stored total does not match its own parts still prints an invoice that
 * adds up, rather than one that silently disagrees with itself.
 */
export function buildInvoiceTotals(
  receiptData: any,
  lines: InvoiceLine[],
  refundAmount: number,
): InvoiceTotals {
  const subTotal = toMoney(receiptData?.subtotal)
  const taxAmount = toMoney(receiptData?.tax)
  const total = toMoney(receiptData?.totalAmount)
  const discount = toAmount(receiptData?.discount)
  const deliveryCharges = toAmount(receiptData?.deliveryCharges)
  const refund = toAmount(refundAmount)

  const componentsKnown = subTotal !== null && taxAmount !== null && total !== null
  const rounding = componentsKnown
    ? roundToPaisa(total - (subTotal + taxAmount + deliveryCharges - discount - refund))
    : null

  return {
    subTotal,
    taxLabel: getInvoiceTaxLabel(lines),
    taxAmount,
    discount,
    deliveryCharges,
    refund,
    rounding,
    total,
  }
}

/** Keeps a residue of floating-point noise from printing as a rounding line. */
function roundToPaisa(value: number): number {
  return Math.round(value * 100) / 100
}

export function formatInvoiceMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—"
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/** Quantities print with two decimals on the invoice, as on the paper format. */
export function formatInvoiceQuantity(value: number): string {
  if (!Number.isFinite(value)) return "0.00"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function formatInvoiceTaxPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—"
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

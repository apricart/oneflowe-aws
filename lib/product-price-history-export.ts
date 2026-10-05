import {
  productPriceHistoryScopeLabel,
  productPriceHistorySourceLabel,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryProduct,
} from "./product-price-history"

/**
 * Rows for the Product Price History download. The export carries exactly the
 * records the "Price change records" table shows — the caller passes the same
 * filtered points, newest first — so a download can never disclose a price the
 * screen withholds. Prices are PKR numbers (not formatted strings) so a
 * spreadsheet can sort and sum them.
 */

export const PRODUCT_PRICE_HISTORY_EXPORT_HEADERS = [
  "Changed (PKT)",
  "Product code",
  "Product",
  "Previous price (PKR)",
  "New price (PKR)",
  "Change (PKR)",
  "Scope",
  "Organization",
  "Group",
  "Branch",
  "Source",
] as const

export type ProductPriceHistoryExportHeader = (typeof PRODUCT_PRICE_HISTORY_EXPORT_HEADERS)[number]
export type ProductPriceHistoryExportRow = Record<ProductPriceHistoryExportHeader, string | number>

const karachiParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** `YYYY-MM-DD HH:mm` in Karachi time: sorts correctly as text in any spreadsheet. */
export function karachiTimestamp(value: string): string {
  const parts = Object.fromEntries(karachiParts.formatToParts(new Date(value)).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

const pkr = (cents: number) => Math.round(cents) / 100

export function buildProductPriceHistoryExportRows(
  product: Pick<ProductPriceHistoryProduct, "productCode" | "name">,
  points: readonly ProductPriceHistoryPoint[],
): ProductPriceHistoryExportRow[] {
  return points.map((point) => {
    const previous = point.previousPriceCents !== null && point.previousPriceCents > 0 ? point.previousPriceCents : null
    return {
      "Changed (PKT)": karachiTimestamp(point.changedAt),
      "Product code": product.productCode,
      "Product": product.name,
      "Previous price (PKR)": previous === null ? "" : pkr(previous),
      "New price (PKR)": pkr(point.priceCents),
      "Change (PKR)": previous === null ? "" : pkr(point.priceCents - previous),
      "Scope": productPriceHistoryScopeLabel(point.scope),
      "Organization": point.organizationName ?? (point.scope === "GLOBAL" ? "All organizations" : ""),
      "Group": point.groupName ?? "",
      "Branch": point.branchName ?? "",
      "Source": productPriceHistorySourceLabel(point.source),
    }
  })
}

/** A file name safe on every OS: product code plus the date of the download. */
export function productPriceHistoryExportFileName(
  product: Pick<ProductPriceHistoryProduct, "productCode">,
  extension: "csv" | "xlsx" | "pdf",
  now = new Date(),
): string {
  const code = product.productCode.replaceAll(/[^A-Za-z0-9_-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "product"
  return `price-history-${code}-${now.toISOString().slice(0, 10)}.${extension}`
}

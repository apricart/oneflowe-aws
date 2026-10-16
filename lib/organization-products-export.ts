/**
 * Rows for the Organization Products download (`/inventory/org`). The export
 * carries exactly what the two tabs show — the caller passes the same lists,
 * already narrowed by the page's search and category filters — so a download
 * never discloses a product or price the screen withholds. Prices are PKR
 * numbers (not formatted strings) so a spreadsheet can sort and sum them.
 */

export type OrganizationProductsExportList = "not-assigned" | "assigned"

export interface NotAssignedExportProduct {
  productCode: string
  name: string
  categoryName?: string | null
  parentCategoryName?: string | null
  /** Global base price, in cents. */
  basePrice: number
  unit: string
}

export interface AssignedExportProduct {
  productCode: string
  productName: string
  customName: string | null
  categoryName?: string | null
  parentCategoryName?: string | null
  /** Organization price, in cents; null or 0 when none is set. */
  customPrice: number | null
  globalStatus?: string | null
}

export const NOT_ASSIGNED_EXPORT_HEADERS = [
  "Product code",
  "Product",
  "Category",
  "Subcategory",
  "Base price (PKR)",
  "Unit",
] as const

export const ASSIGNED_EXPORT_HEADERS = [
  "Product code",
  "Product",
  "Category",
  "Subcategory",
  "Custom price (PKR)",
  "Status",
] as const

export type NotAssignedExportRow = Record<(typeof NOT_ASSIGNED_EXPORT_HEADERS)[number], string | number>
export type AssignedExportRow = Record<(typeof ASSIGNED_EXPORT_HEADERS)[number], string | number>

export const ORGANIZATION_PRODUCTS_LIST_LABELS: Record<OrganizationProductsExportList, string> = {
  "not-assigned": "Not Assigned",
  assigned: "Assigned",
}

const UNCATEGORIZED = "Uncategorized"

const pkr = (cents: number) => Math.round(cents) / 100

/** Mirrors the table: an unset (null or 0) organization price reads "Not set". */
export function assignedPriceCents(product: Pick<AssignedExportProduct, "customPrice">): number | null {
  return product.customPrice ? product.customPrice : null
}

export function assignedStatusLabel(product: Pick<AssignedExportProduct, "globalStatus">): "Active" | "Inactive" {
  return product.globalStatus === "active" ? "Active" : "Inactive"
}

export function buildNotAssignedExportRows(products: readonly NotAssignedExportProduct[]): NotAssignedExportRow[] {
  return products.map((product) => ({
    "Product code": product.productCode,
    "Product": product.name,
    "Category": product.parentCategoryName || UNCATEGORIZED,
    "Subcategory": product.categoryName || UNCATEGORIZED,
    "Base price (PKR)": pkr(product.basePrice),
    "Unit": product.unit,
  }))
}

export function buildAssignedExportRows(products: readonly AssignedExportProduct[]): AssignedExportRow[] {
  return products.map((product) => {
    const priceCents = assignedPriceCents(product)
    return {
      "Product code": product.productCode,
      "Product": product.customName || product.productName,
      "Category": product.parentCategoryName || UNCATEGORIZED,
      "Subcategory": product.categoryName || UNCATEGORIZED,
      "Custom price (PKR)": priceCents === null ? "" : pkr(priceCents),
      "Status": assignedStatusLabel(product),
    }
  })
}

/** A file name safe on every OS: organization name, list and the date of the download. */
export function organizationProductsExportFileName(
  organizationName: string,
  list: OrganizationProductsExportList | "all",
  extension: "xlsx" | "pdf",
  now = new Date(),
): string {
  const org = organizationName.replaceAll(/[^A-Za-z0-9_-]+/g, "-").replaceAll(/^-+|-+$/g, "") || "organization"
  return `organization-products-${org}-${list}-${now.toISOString().slice(0, 10)}.${extension}`
}

/** The filters a download was taken under, printed on the PDF so a reader knows the list may be partial. */
export function organizationProductsFilterDescription(filters: {
  search?: string | null
  category?: string | null
  subcategory?: string | null
}): string {
  const parts: string[] = []
  const search = filters.search?.trim()
  if (search) parts.push(`Search: "${search}"`)
  if (filters.category) parts.push(`Category: ${filters.category}`)
  if (filters.subcategory) parts.push(`Subcategory: ${filters.subcategory}`)
  return parts.length > 0 ? `Filters: ${parts.join(" · ")}` : "Filters: none (all products)"
}

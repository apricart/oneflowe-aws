import { z } from "zod"

import { MAX_BUSINESS_QUANTITY } from "@/lib/business-rules"
import { MAX_PRICE_CENTS } from "@/lib/price-ladder"
import { roundQuantity } from "@/lib/quantity"

/**
 * A Head Office request for a product the catalogue does not carry.
 *
 * Head Office cannot add a global product — the catalogue and every price on it
 * are Super Admin's — so this is the channel it asks through. A request is
 * information only: approving one creates no product and sets no price. Super
 * Admin adds the product through the ordinary Add Product flow, which is where
 * `lib/pricing-access.ts` applies. See
 * `plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`.
 *
 * Pure: no database, no session. The route re-reads the requester's tenant, and
 * `lib/server/product-requests.ts` checks the category ids and the image path
 * against what actually exists.
 */

export const PRODUCT_REQUEST_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const
export type ProductRequestStatus = (typeof PRODUCT_REQUEST_STATUSES)[number]

/** The outcomes a reviewer may record. `PENDING` is where every request starts. */
export const PRODUCT_REQUEST_DECISIONS = ["APPROVED", "REJECTED"] as const
export type ProductRequestDecision = (typeof PRODUCT_REQUEST_DECISIONS)[number]

export const PRODUCT_REQUEST_STATUS_LABELS: Record<ProductRequestStatus, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
}

export function isProductRequestStatus(value: unknown): value is ProductRequestStatus {
  return typeof value === "string" && PRODUCT_REQUEST_STATUSES.includes(value as ProductRequestStatus)
}

/** Column widths, shared by the schema, the form's `maxLength`, and the migration. */
export const PRODUCT_REQUEST_LIMITS = {
  productName: 255,
  brand: 255,
  description: 1000,
  unit: 64,
  packSize: 128,
  barcode: 64,
  preferredSupplier: 255,
  referenceUrl: 2048,
  notes: 1000,
  imageUrl: 512,
  reviewNote: 1000,
} as const

/**
 * The largest request body the form will send. The production WAF's Core Rule
 * Set refuses any body over 8 KB outside the upload paths, with an opaque 403
 * page, so the form stops short of it and says why. Character limits alone
 * cannot guarantee this: Urdu text is two bytes a character in UTF-8.
 */
export const PRODUCT_REQUEST_MAX_BODY_BYTES = 8000

export const PRODUCT_REQUEST_PAGE_SIZE_DEFAULT = 20
export const PRODUCT_REQUEST_PAGE_SIZE_MAX = 50
/** Far beyond any real queue; stops a caller asking Postgres to skip an absurd OFFSET. */
export const PRODUCT_REQUEST_PAGE_MAX = 10_000

/**
 * Free text. Trimmed, and blank means "not given" — the form sends every box,
 * and an empty one must not count as the field being filled in.
 */
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label} must not exceed ${max} characters`)
    .nullish()
    .transform((value) => (value ? value : null))

const optionalId = (label: string) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .positive(`${label} must be positive`)
    .nullish()
    .transform((value) => value ?? null)

/**
 * A link to the product elsewhere — a supplier page, a listing. Only `http`
 * and `https`, and never with credentials in it: the value is rendered as a
 * link on Super Admin's screen, so a `javascript:` URL would be a stored XSS.
 */
export function normalizeReferenceUrl(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** Where the upload route files a product image; the table's CHECK holds the same prefix. */
export const PRODUCT_REQUEST_IMAGE_PREFIX = "/api/v1/images/products/"

/**
 * Whether a value may be rendered as a request's picture. Display only — the
 * write path checks the exact key shape with `isStoredImagePath`, which lives
 * beside the S3 client and cannot be imported into client code.
 */
export function isProductRequestImagePath(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(PRODUCT_REQUEST_IMAGE_PREFIX) && !value.includes("..")
}

const REFERENCE_URL_MESSAGE = "Reference link must be a full http:// or https:// address"

const referenceUrlField = z
  .string()
  .trim()
  .max(PRODUCT_REQUEST_LIMITS.referenceUrl, `Reference link must not exceed ${PRODUCT_REQUEST_LIMITS.referenceUrl} characters`)
  .nullish()
  .transform((value, ctx) => {
    if (!value) return null
    const normalized = normalizeReferenceUrl(value)
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: REFERENCE_URL_MESSAGE })
      return z.NEVER
    }
    return normalized
  })

/**
 * The expected price, in integer cents, exactly as every other amount reaches
 * this API — the browser converts what was typed with `parsePriceInput` and
 * never sends a float. Information for Super Admin only; nothing prices from it.
 */
const expectedPriceField = z
  .number({ error: "Expected price must be an amount in cents" })
  .int("Expected price must be a whole number of cents")
  .min(0, "Expected price cannot be negative")
  .max(MAX_PRICE_CENTS, "Expected price is too large")
  .nullish()
  .transform((value) => value ?? null)

const monthlyQuantityField = z
  .number({ error: "Estimated monthly quantity must be a number" })
  .min(0, "Estimated monthly quantity cannot be negative")
  .max(MAX_BUSINESS_QUANTITY, `Estimated monthly quantity must not exceed ${MAX_BUSINESS_QUANTITY}`)
  .nullish()
  .transform((value) => (value === null || value === undefined ? null : roundQuantity(value)))

/**
 * What Head Office may send. Every field is optional, but the request as a
 * whole must ask for something.
 *
 * Strict: a body naming `organizationId`, `status`, `requestedByUserId` or any
 * other key is refused rather than having the key ignored, so a caller cannot
 * find out by trial which fields are quietly dropped.
 */
export const productRequestCreateSchema = z
  .object({
    productName: optionalText(PRODUCT_REQUEST_LIMITS.productName, "Product name"),
    brand: optionalText(PRODUCT_REQUEST_LIMITS.brand, "Brand"),
    description: optionalText(PRODUCT_REQUEST_LIMITS.description, "Description"),
    categoryId: optionalId("Category"),
    subcategoryId: optionalId("Subcategory"),
    unit: optionalText(PRODUCT_REQUEST_LIMITS.unit, "Unit"),
    packSize: optionalText(PRODUCT_REQUEST_LIMITS.packSize, "Pack size"),
    barcode: optionalText(PRODUCT_REQUEST_LIMITS.barcode, "Barcode"),
    expectedPriceCents: expectedPriceField,
    estimatedMonthlyQuantity: monthlyQuantityField,
    preferredSupplier: optionalText(PRODUCT_REQUEST_LIMITS.preferredSupplier, "Preferred supplier"),
    referenceUrl: referenceUrlField,
    notes: optionalText(PRODUCT_REQUEST_LIMITS.notes, "Notes"),
    // Its shape is checked on the server against `isStoredImagePath`, which
    // lives beside the S3 client and cannot be imported into this pure module.
    imageUrl: optionalText(PRODUCT_REQUEST_LIMITS.imageUrl, "Image"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!hasAnyProductRequestContent(value)) {
      ctx.addIssue({
        code: "custom",
        message: "Fill in at least one field — the product name is the most useful",
      })
    }
  })

export type ProductRequestInput = z.output<typeof productRequestCreateSchema>

/** True when at least one field of a normalized request carries a value. */
export function hasAnyProductRequestContent(value: Readonly<Record<string, unknown>>): boolean {
  return Object.values(value).some((field) => field !== null && field !== undefined && field !== "")
}

export const productRequestReviewSchema = z
  .object({
    status: z.enum(PRODUCT_REQUEST_DECISIONS, { error: "Status must be APPROVED or REJECTED" }),
    reviewNote: optionalText(PRODUCT_REQUEST_LIMITS.reviewNote, "Review note"),
  })
  .strict()

export type ProductRequestReview = z.output<typeof productRequestReviewSchema>

/** Only a pending request can be decided; a decision is final. */
export function canReviewProductRequestInStatus(status: string): boolean {
  return status === "PENDING"
}

export type ProductRequestListQuery = {
  status: ProductRequestStatus | null
  organizationId: number | null
  page: number
  pageSize: number
}

export type ProductRequestListQueryResult =
  | { ok: true; value: ProductRequestListQuery }
  | { ok: false; error: string }

function optionalPositiveInteger(raw: string | null): { ok: boolean; value: number | null } {
  if (raw === null || raw.trim() === "") return { ok: true, value: null }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? { ok: true, value } : { ok: false, value: null }
}

/**
 * The list's query string. Filters come from an allowlist; a malformed value is
 * refused rather than treated as "no filter", which would silently return more
 * than was asked for.
 */
export function parseProductRequestListQuery(
  params: Pick<URLSearchParams, "get">,
): ProductRequestListQueryResult {
  const rawStatus = params.get("status")
  let status: ProductRequestStatus | null = null
  if (rawStatus !== null && rawStatus !== "" && rawStatus !== "all") {
    if (!isProductRequestStatus(rawStatus)) return { ok: false, error: "Invalid status filter" }
    status = rawStatus
  }

  const organization = optionalPositiveInteger(params.get("organizationId"))
  if (!organization.ok) return { ok: false, error: "Invalid organization filter" }

  const page = optionalPositiveInteger(params.get("page"))
  if (!page.ok || (page.value ?? 1) > PRODUCT_REQUEST_PAGE_MAX) return { ok: false, error: "Invalid page" }

  const pageSize = optionalPositiveInteger(params.get("pageSize"))
  if (!pageSize.ok) return { ok: false, error: "Invalid page size" }

  return {
    ok: true,
    value: {
      status,
      organizationId: organization.value,
      page: page.value ?? 1,
      pageSize: Math.min(pageSize.value ?? PRODUCT_REQUEST_PAGE_SIZE_DEFAULT, PRODUCT_REQUEST_PAGE_SIZE_MAX),
    },
  }
}

/** One request as `GET /api/v1/product-requests` returns it. */
export type ProductRequestListItem = {
  id: number
  status: ProductRequestStatus
  productName: string | null
  brand: string | null
  description: string | null
  category: { id: number; name: string } | null
  subcategory: { id: number; name: string } | null
  unit: string | null
  packSize: string | null
  barcode: string | null
  expectedPriceCents: number | null
  estimatedMonthlyQuantity: number | null
  preferredSupplier: string | null
  referenceUrl: string | null
  notes: string | null
  imageUrl: string | null
  reviewNote: string | null
  reviewedAt: string | null
  reviewedBy: { id: string; fullName: string | null } | null
  createdAt: string
  organization: { id: number; name: string }
  requestedBy: { id: string; fullName: string | null; email: string; role: string | null }
}

export type ProductRequestList = {
  items: ProductRequestListItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<ProductRequestStatus, number>
  /** Organizations that have raised a request — the Super Admin filter. Empty for Head Office. */
  organizations: Array<{ id: number; name: string }>
}

/** What a request is called in a list: its product name, else its brand. */
export function productRequestTitle(request: {
  productName: string | null
  brand: string | null
}): string {
  return request.productName || request.brand || "Unnamed product"
}

/**
 * What the request would cost a month at the expected price — the expected
 * price per unit times the estimated monthly quantity, in whole cents. Null
 * unless both were given, so the detail view never shows a figure that half
 * of was guessed. Indicative only: the expected price is never charged.
 */
export function estimatedMonthlyValueCents(
  expectedPriceCents: number | null,
  estimatedMonthlyQuantity: number | null,
): number | null {
  if (expectedPriceCents === null || estimatedMonthlyQuantity === null) return null
  if (!Number.isFinite(expectedPriceCents) || !Number.isFinite(estimatedMonthlyQuantity)) return null
  const cents = Math.round(expectedPriceCents * estimatedMonthlyQuantity)
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null
}

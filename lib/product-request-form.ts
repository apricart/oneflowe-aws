import { parsePriceInput } from "@/lib/group-price-input"
import { PRODUCT_REQUEST_MAX_BODY_BYTES, hasAnyProductRequestContent } from "@/lib/product-request"
import { parseQuantity } from "@/lib/quantity"

/**
 * Turning the request form's boxes into the body `POST /api/v1/product-requests`
 * accepts.
 *
 * Kept out of the component so it can be tested directly. The server re-checks
 * everything here; this exists so the person filling the form hears about a
 * mistyped amount before they submit, and so the browser sends the expected
 * price as integer cents rather than a float (`parsePriceInput`).
 */

export type ProductRequestFormState = {
  productName: string
  brand: string
  description: string
  categoryId: string
  subcategoryId: string
  unit: string
  packSize: string
  barcode: string
  expectedPrice: string
  estimatedMonthlyQuantity: string
  preferredSupplier: string
  referenceUrl: string
  notes: string
  imageUrl: string
}

export const EMPTY_PRODUCT_REQUEST_FORM: ProductRequestFormState = {
  productName: "",
  brand: "",
  description: "",
  categoryId: "",
  subcategoryId: "",
  unit: "",
  packSize: "",
  barcode: "",
  expectedPrice: "",
  estimatedMonthlyQuantity: "",
  preferredSupplier: "",
  referenceUrl: "",
  notes: "",
  imageUrl: "",
}

export type ProductRequestPayload = {
  productName: string | null
  brand: string | null
  description: string | null
  categoryId: number | null
  subcategoryId: number | null
  unit: string | null
  packSize: string | null
  barcode: string | null
  expectedPriceCents: number | null
  estimatedMonthlyQuantity: number | null
  preferredSupplier: string | null
  referenceUrl: string | null
  notes: string | null
  imageUrl: string | null
}

export type ProductRequestPayloadResult =
  | { ok: true; payload: ProductRequestPayload }
  | { ok: false; field: keyof ProductRequestFormState | null; error: string }

const text = (value: string): string | null => value.trim() || null

function id(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === "") return null
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function buildProductRequestPayload(state: ProductRequestFormState): ProductRequestPayloadResult {
  const price = parsePriceInput(state.expectedPrice)
  if (!price.ok) {
    return {
      ok: false,
      field: "expectedPrice",
      error: price.error === "too-large"
        ? "Expected price is too large"
        : "Enter the expected price as an amount, for example 450 or 450.50",
    }
  }

  let estimatedMonthlyQuantity: number | null = null
  if (state.estimatedMonthlyQuantity.trim() !== "") {
    const quantity = parseQuantity(state.estimatedMonthlyQuantity.trim())
    if (Number.isNaN(quantity) || quantity < 0) {
      return {
        ok: false,
        field: "estimatedMonthlyQuantity",
        error: "Enter the estimated monthly quantity as a number, for example 120",
      }
    }
    estimatedMonthlyQuantity = quantity
  }

  const payload: ProductRequestPayload = {
    productName: text(state.productName),
    brand: text(state.brand),
    description: text(state.description),
    categoryId: id(state.categoryId),
    subcategoryId: id(state.subcategoryId),
    unit: text(state.unit),
    packSize: text(state.packSize),
    barcode: text(state.barcode),
    expectedPriceCents: price.cents,
    estimatedMonthlyQuantity,
    preferredSupplier: text(state.preferredSupplier),
    referenceUrl: text(state.referenceUrl),
    notes: text(state.notes),
    imageUrl: text(state.imageUrl),
  }

  if (!hasAnyProductRequestContent(payload)) {
    return { ok: false, field: null, error: "Fill in at least one field — the product name is the most useful" }
  }

  if (new TextEncoder().encode(JSON.stringify(payload)).length > PRODUCT_REQUEST_MAX_BODY_BYTES) {
    return {
      ok: false,
      field: null,
      error: "This request is too long to send. Shorten the description or notes and try again.",
    }
  }

  return { ok: true, payload }
}

/**
 * How many of the form's details have been given, for the progress meter in
 * the form's footer. Every field counts once; whitespace is not a detail.
 * Presentation only — nothing is required, and the server never reads this.
 */
export function productRequestCompleteness(state: ProductRequestFormState): { filled: number; total: number } {
  const values = Object.values(state)
  return {
    filled: values.filter((value) => value.trim() !== "").length,
    total: values.length,
  }
}

import { describe, expect, it } from "vitest"

import { PRODUCT_REQUEST_LIMITS, productRequestCreateSchema } from "@/lib/product-request"
import {
  EMPTY_PRODUCT_REQUEST_FORM,
  buildProductRequestPayload,
  productRequestCompleteness,
  type ProductRequestFormState,
} from "@/lib/product-request-form"

const form = (overrides: Partial<ProductRequestFormState>): ProductRequestFormState => ({
  ...EMPTY_PRODUCT_REQUEST_FORM,
  ...overrides,
})

describe("buildProductRequestPayload", () => {
  it("refuses an untouched form, because it asks for nothing", () => {
    expect(buildProductRequestPayload(EMPTY_PRODUCT_REQUEST_FORM)).toEqual({
      ok: false,
      field: null,
      error: "Fill in at least one field — the product name is the most useful",
    })
  })

  it("refuses a form holding only whitespace", () => {
    expect(buildProductRequestPayload(form({ productName: "  ", notes: "\n" })).ok).toBe(false)
  })

  it("sends a single field and nulls everything else", () => {
    const result = buildProductRequestPayload(form({ productName: " Hand sanitiser " }))
    expect(result).toEqual({
      ok: true,
      payload: {
        productName: "Hand sanitiser",
        brand: null,
        description: null,
        categoryId: null,
        subcategoryId: null,
        unit: null,
        packSize: null,
        barcode: null,
        expectedPriceCents: null,
        estimatedMonthlyQuantity: null,
        preferredSupplier: null,
        referenceUrl: null,
        notes: null,
        imageUrl: null,
      },
    })
  })

  it("converts a typed price to integer cents without floating-point drift", () => {
    const result = buildProductRequestPayload(form({ expectedPrice: "12.35" }))
    expect(result.ok && result.payload.expectedPriceCents).toBe(1235)
  })

  it("counts an expected price of zero as something asked for", () => {
    const result = buildProductRequestPayload(form({ expectedPrice: "0" }))
    expect(result.ok && result.payload.expectedPriceCents).toBe(0)
  })

  it.each(["abc", "-5", "1.234", "1,000"])("flags a malformed price %s against its field", (expectedPrice) => {
    expect(buildProductRequestPayload(form({ productName: "Soap", expectedPrice }))).toMatchObject({
      ok: false,
      field: "expectedPrice",
    })
  })

  it("flags a price above the ledger maximum", () => {
    expect(buildProductRequestPayload(form({ productName: "Soap", expectedPrice: "99999999999" }))).toEqual({
      ok: false,
      field: "expectedPrice",
      error: "Expected price is too large",
    })
  })

  it("rounds the monthly quantity to the quantity scale", () => {
    const result = buildProductRequestPayload(form({ estimatedMonthlyQuantity: "2.5" }))
    expect(result.ok && result.payload.estimatedMonthlyQuantity).toBe(2.5)
  })

  it.each(["abc", "-1"])("flags a monthly quantity of %s against its field", (estimatedMonthlyQuantity) => {
    expect(buildProductRequestPayload(form({ productName: "Soap", estimatedMonthlyQuantity }))).toMatchObject({
      ok: false,
      field: "estimatedMonthlyQuantity",
    })
  })

  it("sends the selected category ids as numbers", () => {
    const result = buildProductRequestPayload(form({ categoryId: "3", subcategoryId: "9" }))
    expect(result.ok && [result.payload.categoryId, result.payload.subcategoryId]).toEqual([3, 9])
  })

  it("sends a form filled to every character limit in plain text", () => {
    const result = buildProductRequestPayload(form({
      productName: "a".repeat(PRODUCT_REQUEST_LIMITS.productName),
      brand: "b".repeat(PRODUCT_REQUEST_LIMITS.brand),
      description: "c".repeat(PRODUCT_REQUEST_LIMITS.description),
      unit: "d".repeat(PRODUCT_REQUEST_LIMITS.unit),
      packSize: "e".repeat(PRODUCT_REQUEST_LIMITS.packSize),
      barcode: "f".repeat(PRODUCT_REQUEST_LIMITS.barcode),
      preferredSupplier: "g".repeat(PRODUCT_REQUEST_LIMITS.preferredSupplier),
      referenceUrl: `https://example.com/${"h".repeat(PRODUCT_REQUEST_LIMITS.referenceUrl - 20)}`,
      notes: "i".repeat(PRODUCT_REQUEST_LIMITS.notes),
      imageUrl: "/api/v1/images/products/11111111-1111-4111-8111-111111111111.png",
      expectedPrice: "999999.99",
      estimatedMonthlyQuantity: "999999",
    }))
    expect(result.ok).toBe(true)
  })

  it("refuses a body the edge firewall would block, rather than letting it fail opaquely", () => {
    // Urdu is two bytes a character in UTF-8: every text box full of it, with
    // a long link, is within every character limit and over 8 KB on the wire.
    const urdu = (length: number) => "ک".repeat(length)
    const result = buildProductRequestPayload(form({
      productName: urdu(PRODUCT_REQUEST_LIMITS.productName),
      brand: urdu(PRODUCT_REQUEST_LIMITS.brand),
      description: urdu(PRODUCT_REQUEST_LIMITS.description),
      unit: urdu(PRODUCT_REQUEST_LIMITS.unit),
      packSize: urdu(PRODUCT_REQUEST_LIMITS.packSize),
      barcode: urdu(PRODUCT_REQUEST_LIMITS.barcode),
      preferredSupplier: urdu(PRODUCT_REQUEST_LIMITS.preferredSupplier),
      notes: urdu(PRODUCT_REQUEST_LIMITS.notes),
      referenceUrl: `https://example.com/${"h".repeat(PRODUCT_REQUEST_LIMITS.referenceUrl - 20)}`,
    }))
    expect(result).toEqual({
      ok: false,
      field: null,
      error: "This request is too long to send. Shorten the description or notes and try again.",
    })
  })

  it("produces a body the server's own schema accepts", () => {
    const result = buildProductRequestPayload(form({
      productName: "Hand sanitiser",
      brand: "Dettol",
      categoryId: "3",
      subcategoryId: "9",
      expectedPrice: "450.50",
      estimatedMonthlyQuantity: "120",
      referenceUrl: "https://example.com/p",
      imageUrl: "/api/v1/images/products/11111111-1111-4111-8111-111111111111.png",
    }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(productRequestCreateSchema.safeParse(result.payload).success).toBe(true)
  })
})

describe("productRequestCompleteness", () => {
  it("counts every field once and ignores whitespace", () => {
    const total = Object.keys(EMPTY_PRODUCT_REQUEST_FORM).length
    expect(productRequestCompleteness(EMPTY_PRODUCT_REQUEST_FORM)).toEqual({ filled: 0, total })
    expect(productRequestCompleteness({ ...EMPTY_PRODUCT_REQUEST_FORM, productName: "Soap", brand: "   ", categoryId: "4" }))
      .toEqual({ filled: 2, total })
  })
})

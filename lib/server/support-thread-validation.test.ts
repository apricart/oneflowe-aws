import { describe, expect, it } from "vitest"

import { supportThreadCreateSchema } from "./mutation-validation"

/**
 * What a client may send when raising a query.
 *
 * The boundary, not the rule: whether the caller may *cite* the order or the
 * product it names is decided server-side against those rows
 * (`verifyOrderReference`, `verifyProductReference`). This only says what shape
 * is accepted at all.
 */

function body(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Invoice total does not match the delivered items",
    category: "INVOICE",
    message: "The invoice shows twelve cases but nine were delivered.",
    // INVOICE is one of the categories that must name a product, so the
    // baseline body carries one and the tests below take it away deliberately.
    productId: 42,
    ...overrides,
  }
}

describe("raising a query", () => {
  it("accepts a well-formed request", () => {
    const parsed = supportThreadCreateSchema.safeParse(body())
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.priority).toBe("NORMAL")
      expect(parsed.data.category).toBe("INVOICE")
    }
  })

  it("refuses a retired category", () => {
    // BILLING is still readable and still filterable; it is simply no longer
    // raisable, and a client that sends it anyway is a 400 rather than a row.
    const parsed = supportThreadCreateSchema.safeParse(body({ category: "BILLING" }))
    expect(parsed.success).toBe(false)
  })

  it("accepts every category the dialog still offers", () => {
    for (const category of ["INVOICE", "ORDER", "DELIVERY", "PRODUCT", "OTHER"]) {
      expect(
        supportThreadCreateSchema.safeParse(body({ category })).success,
        `${category} must be raisable`,
      ).toBe(true)
    }
  })

  it("takes the product the query is about", () => {
    const parsed = supportThreadCreateSchema.safeParse(body({ productId: 42 }))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.productId).toBe(42)
  })

  it("requires a product for every category that is about one", () => {
    // The rule is `isProductRequiredForCategory`, and it is applied here as
    // well as in the dialog — a caller posting straight at the endpoint never
    // sees the dialog, and a hidden requirement is not a requirement.
    for (const category of ["INVOICE", "ORDER", "DELIVERY", "PRODUCT"]) {
      expect(
        supportThreadCreateSchema.safeParse(body({ category, productId: undefined })).success,
        `${category} must name a product`,
      ).toBe(false)

      // An explicit null is a stated absence, and refused for the same reason.
      expect(
        supportThreadCreateSchema.safeParse(body({ category, productId: null })).success,
        `${category} must not accept an explicit null`,
      ).toBe(false)
    }
  })

  it("names the field it is complaining about", () => {
    // The route hands the first issue's message back, and the path is what a
    // client would use to mark the field.
    const parsed = supportThreadCreateSchema.safeParse(body({ productId: undefined }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["productId"])
      expect(parsed.error.issues[0]?.message).toContain("product")
    }
  })

  it("leaves the product optional under OTHER, which is not about one", () => {
    for (const productId of [undefined, null, 42]) {
      expect(
        supportThreadCreateSchema.safeParse(body({ category: "OTHER", productId })).success,
        `OTHER must accept productId ${JSON.stringify(productId)}`,
      ).toBe(true)
    }
  })

  it("refuses a product id that is not a positive integer", () => {
    for (const productId of [0, -1, 1.5, "abc", {}]) {
      expect(
        supportThreadCreateSchema.safeParse(body({ productId })).success,
        `productId ${JSON.stringify(productId)} must be refused`,
      ).toBe(false)
    }
  })

  it("coerces a numeric string, as every other id in this schema does", () => {
    // `positiveId` is `z.coerce.number()` repo-wide, so a form value arriving
    // as a string is the same id. Asserted so the coercion is a decision on
    // record rather than a surprise.
    const parsed = supportThreadCreateSchema.safeParse(body({ productId: "42" }))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.productId).toBe(42)
  })

  it("rejects an unknown field rather than ignoring it", () => {
    // `.strict()` is what stops a caller smuggling organizationId or status in
    // beside the fields the endpoint means to accept.
    const parsed = supportThreadCreateSchema.safeParse(body({ organizationId: 2 }))
    expect(parsed.success).toBe(false)
  })

  it("requires a subject and a message", () => {
    expect(supportThreadCreateSchema.safeParse(body({ subject: "   " })).success).toBe(false)
    expect(supportThreadCreateSchema.safeParse(body({ message: "" })).success).toBe(false)
  })
})

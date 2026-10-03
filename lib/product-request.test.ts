import { describe, expect, it } from "vitest"

import { MAX_BUSINESS_QUANTITY } from "@/lib/business-rules"
import { MAX_PRICE_CENTS } from "@/lib/price-ladder"
import {
  PRODUCT_REQUEST_AVAILABILITY_MAX_DAYS,
  PRODUCT_REQUEST_LIMITS,
  PRODUCT_REQUEST_PAGE_MAX,
  PRODUCT_REQUEST_PAGE_SIZE_DEFAULT,
  PRODUCT_REQUEST_PAGE_SIZE_MAX,
  addDaysToDay,
  canReviewProductRequestInStatus,
  canStartProductRequestReview,
  formatProductRequestDay,
  hasAnyProductRequestContent,
  isCalendarDay,
  isProductRequestImagePath,
  isProductRequestStatus,
  normalizeReferenceUrl,
  parseProductRequestListQuery,
  productRequestCreateSchema,
  productRequestAvailabilityBounds,
  productRequestAvailabilityRefusal,
  productRequestReviewSchema,
  productRequestTitle,
  productRequestTransitionRefusal,
  estimatedMonthlyValueCents,
} from "@/lib/product-request"

const parse = (body: unknown) => productRequestCreateSchema.safeParse(body)
const firstMessage = (body: unknown) => {
  const result = parse(body)
  if (result.success) throw new Error("expected the body to be refused")
  return result.error.issues[0]?.message
}

const EMPTY_REQUEST = {
  productName: null,
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
}

describe("a new product request", () => {
  it("accepts a request that names only the product", () => {
    const result = parse({ productName: "Hand sanitiser 500 ml" })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ ...EMPTY_REQUEST, productName: "Hand sanitiser 500 ml" })
  })

  it("accepts a request with every field filled in", () => {
    const result = parse({
      productName: " Hand sanitiser ",
      brand: "Dettol",
      description: "Alcohol based",
      categoryId: 3,
      subcategoryId: 9,
      unit: "bottle",
      packSize: "500 ml, carton of 12",
      barcode: "8961014001234",
      expectedPriceCents: 45_000,
      estimatedMonthlyQuantity: 120,
      preferredSupplier: "Reckitt",
      referenceUrl: "https://example.com/p/1",
      notes: "Needed for every branch",
      imageUrl: "/api/v1/images/products/11111111-1111-4111-8111-111111111111.png",
    })
    expect(result.success).toBe(true)
    expect(result.data?.productName).toBe("Hand sanitiser")
    expect(result.data?.expectedPriceCents).toBe(45_000)
  })

  it("accepts any single optional field on its own", () => {
    expect(parse({ brand: "Dettol" }).success).toBe(true)
    expect(parse({ notes: "Please add a sanitiser" }).success).toBe(true)
    expect(parse({ categoryId: 3 }).success).toBe(true)
    expect(parse({ expectedPriceCents: 0 }).success).toBe(true)
    expect(parse({ estimatedMonthlyQuantity: 0 }).success).toBe(true)
  })

  it.each([
    ["an empty body", {}],
    ["every field null", EMPTY_REQUEST],
    ["only blank strings", { productName: "   ", brand: "", notes: "\n" }],
  ])("refuses %s, because it asks for nothing", (_label, body) => {
    expect(firstMessage(body)).toBe("Fill in at least one field — the product name is the most useful")
  })

  it("turns a blank box into null rather than an empty string", () => {
    expect(parse({ productName: "Soap", brand: "  " }).data?.brand).toBeNull()
  })

  it.each(["organizationId", "status", "requestedByUserId", "reviewedByUserId", "basePrice"])(
    "refuses a body carrying %s instead of ignoring it",
    (key) => {
      expect(firstMessage({ productName: "Soap", [key]: 1 })).toBeDefined()
      const result = parse({ productName: "Soap", [key]: 1 })
      expect(result.success).toBe(false)
      expect(result.error?.issues.some((issue) => issue.code === "unrecognized_keys")).toBe(true)
    },
  )

  it.each(Object.entries({
    productName: PRODUCT_REQUEST_LIMITS.productName,
    brand: PRODUCT_REQUEST_LIMITS.brand,
    description: PRODUCT_REQUEST_LIMITS.description,
    unit: PRODUCT_REQUEST_LIMITS.unit,
    packSize: PRODUCT_REQUEST_LIMITS.packSize,
    barcode: PRODUCT_REQUEST_LIMITS.barcode,
    preferredSupplier: PRODUCT_REQUEST_LIMITS.preferredSupplier,
    notes: PRODUCT_REQUEST_LIMITS.notes,
    imageUrl: PRODUCT_REQUEST_LIMITS.imageUrl,
  }))("holds %s to %i characters", (field, max) => {
    expect(parse({ [field]: "a".repeat(max) }).success).toBe(true)
    expect(parse({ [field]: "a".repeat(max + 1) }).success).toBe(false)
  })

  it.each([
    ["a string", "3"],
    ["zero", 0],
    ["a negative id", -1],
    ["a fraction", 1.5],
  ])("refuses a category id that is %s", (_label, categoryId) => {
    expect(parse({ categoryId }).success).toBe(false)
    expect(parse({ subcategoryId: categoryId }).success).toBe(false)
  })

  describe("expected price", () => {
    it("is integer cents, bounded by the ledger's own maximum", () => {
      expect(parse({ expectedPriceCents: MAX_PRICE_CENTS }).success).toBe(true)
      expect(parse({ expectedPriceCents: MAX_PRICE_CENTS + 1 }).success).toBe(false)
    })

    it.each([
      ["negative", -1],
      ["a float", 12.5],
      ["a string", "450"],
      ["infinite", Number.POSITIVE_INFINITY],
    ])("refuses an amount that is %s", (_label, expectedPriceCents) => {
      expect(parse({ expectedPriceCents }).success).toBe(false)
    })
  })

  describe("estimated monthly quantity", () => {
    it("rounds to the quantity scale", () => {
      expect(parse({ estimatedMonthlyQuantity: 1.23456 }).data?.estimatedMonthlyQuantity).toBe(1.235)
    })

    it("is bounded by the business maximum", () => {
      expect(parse({ estimatedMonthlyQuantity: MAX_BUSINESS_QUANTITY }).success).toBe(true)
      expect(parse({ estimatedMonthlyQuantity: MAX_BUSINESS_QUANTITY + 1 }).success).toBe(false)
    })

    it("refuses a negative quantity", () => {
      expect(parse({ estimatedMonthlyQuantity: -1 }).success).toBe(false)
    })
  })

  describe("reference link", () => {
    it("keeps an http or https address, normalized", () => {
      expect(parse({ referenceUrl: "https://Example.com/a b" }).data?.referenceUrl).toBe("https://example.com/a%20b")
      expect(parse({ referenceUrl: "http://example.com" }).data?.referenceUrl).toBe("http://example.com/")
    })

    it.each([
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.com/file",
      "https://user:secret@example.com/",
      "example.com/no-scheme",
      "/relative/path",
    ])("refuses %s", (referenceUrl) => {
      expect(firstMessage({ referenceUrl })).toBe("Reference link must be a full http:// or https:// address")
    })

    it("holds the link to its column width", () => {
      const long = `https://example.com/${"a".repeat(PRODUCT_REQUEST_LIMITS.referenceUrl)}`
      expect(parse({ referenceUrl: long }).success).toBe(false)
    })
  })
})

describe("normalizeReferenceUrl", () => {
  it("returns null for anything that is not a web address", () => {
    expect(normalizeReferenceUrl("not a url")).toBeNull()
    expect(normalizeReferenceUrl("javascript:void(0)")).toBeNull()
  })
})

describe("isProductRequestImagePath", () => {
  it("accepts a stored product image path", () => {
    expect(isProductRequestImagePath("/api/v1/images/products/11111111-1111-4111-8111-111111111111.png")).toBe(true)
  })

  it.each([
    ["an empty value", ""],
    ["null", null],
    ["a data URL", "data:image/png;base64,AAAA"],
    ["an external address", "https://evil.example/x.png"],
    ["a support attachment", "/api/v1/images/support/11111111-1111-4111-8111-111111111111.png"],
    ["a traversal", "/api/v1/images/products/../support/x.png"],
  ])("refuses %s", (_label, value) => {
    expect(isProductRequestImagePath(value)).toBe(false)
  })
})

describe("hasAnyProductRequestContent", () => {
  it("counts zero as content — an expected price of zero was still stated", () => {
    expect(hasAnyProductRequestContent({ ...EMPTY_REQUEST, expectedPriceCents: 0 })).toBe(true)
  })

  it("does not count null, undefined or an empty string", () => {
    expect(hasAnyProductRequestContent({ a: null, b: undefined, c: "" })).toBe(false)
  })
})

describe("a review", () => {
  it.each([
    ["marking it under review", { status: "UNDER_REVIEW" }],
    ["an approval with its date", { status: "APPROVED", estimatedAvailableOn: "2026-10-15" }],
    ["a rejection", { status: "REJECTED" }],
  ])("accepts %s", (_label, body) => {
    expect(productRequestReviewSchema.safeParse(body).success).toBe(true)
  })

  it("keeps a trimmed note and turns a blank one into null", () => {
    expect(productRequestReviewSchema.parse({ status: "REJECTED", reviewNote: " Not stocked " })).toEqual({
      status: "REJECTED",
      reviewNote: "Not stocked",
    })
    expect(
      productRequestReviewSchema.parse({ status: "APPROVED", reviewNote: "  ", estimatedAvailableOn: " 2026-10-15 " }),
    ).toEqual({ status: "APPROVED", reviewNote: null, estimatedAvailableOn: "2026-10-15" })
  })

  it.each([
    ["back to pending", { status: "PENDING" }],
    ["an unknown status", { status: "DONE" }],
    ["no status", {}],
    ["an approval with no date", { status: "APPROVED" }],
    ["an approval with a blank date", { status: "APPROVED", estimatedAvailableOn: "" }],
    ["an approval with a day the calendar lacks", { status: "APPROVED", estimatedAvailableOn: "2026-02-30" }],
    ["an approval with a timestamp for a date", { status: "APPROVED", estimatedAvailableOn: "2026-10-15T00:00:00Z" }],
    ["a date on a rejection", { status: "REJECTED", estimatedAvailableOn: "2026-10-15" }],
    ["a note on a review start", { status: "UNDER_REVIEW", reviewNote: "Looking" }],
    ["a date on a review start", { status: "UNDER_REVIEW", estimatedAvailableOn: "2026-10-15" }],
    [
      "an over-long note",
      { status: "APPROVED", estimatedAvailableOn: "2026-10-15", reviewNote: "a".repeat(PRODUCT_REQUEST_LIMITS.reviewNote + 1) },
    ],
    ["an unknown field", { status: "REJECTED", organizationId: 1 }],
  ])("refuses %s", (_label, body) => {
    expect(productRequestReviewSchema.safeParse(body).success).toBe(false)
  })
})

describe("how a request moves", () => {
  it("can be decided while pending or under review, and never again after", () => {
    expect(canReviewProductRequestInStatus("PENDING")).toBe(true)
    expect(canReviewProductRequestInStatus("UNDER_REVIEW")).toBe(true)
    expect(canReviewProductRequestInStatus("APPROVED")).toBe(false)
    expect(canReviewProductRequestInStatus("REJECTED")).toBe(false)
    expect(canReviewProductRequestInStatus("DONE")).toBe(false)
  })

  it("can be put under review only while pending", () => {
    expect(canStartProductRequestReview("PENDING")).toBe(true)
    expect(canStartProductRequestReview("UNDER_REVIEW")).toBe(false)
    expect(canStartProductRequestReview("APPROVED")).toBe(false)
    expect(canStartProductRequestReview("REJECTED")).toBe(false)
  })

  it.each([
    ["PENDING", "UNDER_REVIEW"],
    ["PENDING", "APPROVED"],
    ["PENDING", "REJECTED"],
    ["UNDER_REVIEW", "APPROVED"],
    ["UNDER_REVIEW", "REJECTED"],
  ] as const)("allows %s → %s", (from, to) => {
    expect(productRequestTransitionRefusal(from, to)).toBeNull()
  })

  it.each([
    ["UNDER_REVIEW", "UNDER_REVIEW", "This request is already under review"],
    ["APPROVED", "UNDER_REVIEW", "This request has already been approved"],
    ["APPROVED", "REJECTED", "This request has already been approved"],
    ["REJECTED", "APPROVED", "This request has already been rejected"],
    ["DONE", "APPROVED", "This request is in an unknown state"],
  ] as const)("refuses %s → %s, saying why", (from, to, message) => {
    expect(productRequestTransitionRefusal(from, to)).toBe(message)
  })

  it("recognises exactly the four statuses", () => {
    expect(isProductRequestStatus("PENDING")).toBe(true)
    expect(isProductRequestStatus("UNDER_REVIEW")).toBe(true)
    expect(isProductRequestStatus("pending")).toBe(false)
    expect(isProductRequestStatus(null)).toBe(false)
  })
})

describe("the expected availability date", () => {
  // 3 Oct 2026, 10:00 in Karachi.
  const now = new Date("2026-10-03T05:00:00.000Z")

  it("runs from today in Karachi to a year ahead", () => {
    expect(productRequestAvailabilityBounds(now)).toEqual({ min: "2026-10-03", max: "2027-10-03" })
    expect(productRequestAvailabilityRefusal("2026-10-03", now)).toBeNull()
    expect(productRequestAvailabilityRefusal(addDaysToDay("2026-10-03", PRODUCT_REQUEST_AVAILABILITY_MAX_DAYS), now)).toBeNull()
  })

  it("refuses yesterday and a day past the horizon", () => {
    expect(productRequestAvailabilityRefusal("2026-10-02", now)).toBe("Expected availability date cannot be in the past")
    expect(productRequestAvailabilityRefusal("2027-10-04", now)).toBe(
      `Expected availability date must be within ${PRODUCT_REQUEST_AVAILABILITY_MAX_DAYS} days`,
    )
  })

  it("counts today in Karachi, not in UTC", () => {
    // 20:00 UTC on 2 Oct is already 01:00 on 3 Oct in Karachi.
    const lateUtc = new Date("2026-10-02T20:00:00.000Z")
    expect(productRequestAvailabilityBounds(lateUtc).min).toBe("2026-10-03")
    expect(productRequestAvailabilityRefusal("2026-10-02", lateUtc)).toBe("Expected availability date cannot be in the past")
  })

  it("refuses a value that is not a calendar day", () => {
    expect(productRequestAvailabilityRefusal("2026-02-29", now)).toMatch(/real date/)
    expect(productRequestAvailabilityRefusal("15/10/2026", now)).toMatch(/real date/)
  })

  it("knows which days the calendar has", () => {
    expect(isCalendarDay("2028-02-29")).toBe(true)
    expect(isCalendarDay("2026-02-29")).toBe(false)
    expect(isCalendarDay("2026-13-01")).toBe(false)
    expect(isCalendarDay("2026-1-01")).toBe(false)
  })

  it("moves a day across month and year ends", () => {
    expect(addDaysToDay("2026-10-31", 1)).toBe("2026-11-01")
    expect(addDaysToDay("2026-12-25", 14)).toBe("2027-01-08")
  })

  it("is shown as the day it names, whatever the reader's time zone", () => {
    expect(formatProductRequestDay("2026-10-15")).toBe("15 Oct 2026")
    expect(formatProductRequestDay(null)).toBeNull()
    expect(formatProductRequestDay("not a day")).toBeNull()
  })
})

describe("the list query", () => {
  const query = (values: Record<string, string>) => parseProductRequestListQuery(new URLSearchParams(values))

  it("defaults to every status, page one, the default page size", () => {
    expect(query({})).toEqual({
      ok: true,
      value: { status: null, organizationId: null, page: 1, pageSize: PRODUCT_REQUEST_PAGE_SIZE_DEFAULT },
    })
  })

  it("reads a status, an organization and a page", () => {
    expect(query({ status: "PENDING", organizationId: "4", page: "2", pageSize: "10" })).toEqual({
      ok: true,
      value: { status: "PENDING", organizationId: 4, page: 2, pageSize: 10 },
    })
  })

  it("treats `all` as no status filter", () => {
    expect(query({ status: "all" })).toMatchObject({ ok: true, value: { status: null } })
  })

  it("caps the page size rather than honouring an unbounded one", () => {
    expect(query({ pageSize: "100000" })).toMatchObject({ ok: true, value: { pageSize: PRODUCT_REQUEST_PAGE_SIZE_MAX } })
  })

  it.each([
    ["an unknown status", { status: "DONE" }],
    ["a lowercase status", { status: "pending" }],
    ["a non-numeric organization", { organizationId: "abc" }],
    ["organization zero", { organizationId: "0" }],
    ["a negative page", { page: "-1" }],
    ["a page beyond the maximum", { page: String(PRODUCT_REQUEST_PAGE_MAX + 1) }],
    ["a fractional page size", { pageSize: "2.5" }],
  ])("refuses %s", (_label, values) => {
    expect(query(values).ok).toBe(false)
  })
})

describe("productRequestTitle", () => {
  it("prefers the product name, then the brand", () => {
    expect(productRequestTitle({ productName: "Soap", brand: "Lux" })).toBe("Soap")
    expect(productRequestTitle({ productName: null, brand: "Lux" })).toBe("Lux")
    expect(productRequestTitle({ productName: null, brand: null })).toBe("Unnamed product")
  })
})

describe("estimatedMonthlyValueCents", () => {
  it("is the expected price times the monthly quantity, in whole cents", () => {
    // Rs 6,000.00 × 40,000 = Rs 240,000,000.00
    expect(estimatedMonthlyValueCents(600_000, 40_000)).toBe(24_000_000_000)
    // Rs 450.50 × 2.5 = Rs 1,126.25
    expect(estimatedMonthlyValueCents(45_050, 2.5)).toBe(112_625)
  })

  it("is null unless both halves were given, so nothing half-guessed is shown", () => {
    expect(estimatedMonthlyValueCents(null, 10)).toBeNull()
    expect(estimatedMonthlyValueCents(1_000, null)).toBeNull()
  })

  it("is zero for a zero quantity, and null for anything that is not a safe amount", () => {
    expect(estimatedMonthlyValueCents(1_000, 0)).toBe(0)
    expect(estimatedMonthlyValueCents(Number.MAX_SAFE_INTEGER, 10)).toBeNull()
    expect(estimatedMonthlyValueCents(Number.NaN, 1)).toBeNull()
    expect(estimatedMonthlyValueCents(-100, 1)).toBeNull()
  })
})

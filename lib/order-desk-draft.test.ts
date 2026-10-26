import { describe, expect, it } from "vitest"

import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/server/upload-security"

import {
  buildDeskEditRequest,
  buildDeskOrderRequest,
  buildDeskRefundRequest,
  chosenLines,
  deskDraftChecklist,
  deskLinesFromOrder,
  deskLineUnitPriceCents,
  estimateDraftTotalCents,
  isDeskPriceChanged,
  lineProductOf,
  parseDeskPriceInput,
  SCREENSHOT_MAX_BYTES,
  screenshotFileError,
  withLinePrice,
  withLineQuantity,
  withoutLine,
  type DeskCatalogueItem,
  type DeskDraft,
  type DeskLineProduct,
  type DeskLines,
} from "./order-desk-draft"

const SCREENSHOT_KEY = "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"

const catalogueItem = (overrides: Partial<DeskCatalogueItem> & Pick<DeskCatalogueItem, "globalProductId" | "name">): DeskCatalogueItem => ({
  organizationInventoryId: null,
  productCode: `P-${overrides.globalProductId}`,
  unit: "piece",
  allowDecimalQuantity: false,
  quantityStep: 1,
  stockQuantity: 100,
  assignedToBranch: false,
  cataloguePriceCents: null,
  ...overrides,
})

// Rice: carried by the branch at Rs 250, sold in halves. Boxes: carried at Rs 10.
// Tape: an Apricart product the branch does not carry.
const rice = lineProductOf(catalogueItem({ globalProductId: 1, name: "Rice", organizationInventoryId: 11, assignedToBranch: true, cataloguePriceCents: 25_000, allowDecimalQuantity: true, quantityStep: 0.5, unit: "kg" }))
const boxes = lineProductOf(catalogueItem({ globalProductId: 2, name: "Boxes", organizationInventoryId: 12, assignedToBranch: true, cataloguePriceCents: 1_000 }))
const tape = lineProductOf(catalogueItem({ globalProductId: 3, name: "Tape" }))

const linesOf = (...entries: [DeskLineProduct, string, string][]): DeskLines =>
  Object.fromEntries(entries.map(([product, quantity, price]) => [product.globalProductId, { product, quantity, price }]))

const draft = (overrides: Partial<DeskDraft> = {}): DeskDraft => ({
  organizationId: 7,
  branchId: 70,
  lines: linesOf([rice, "1.5", "240"], [boxes, "4", "10.50"]),
  intakeChannel: "WHATSAPP",
  intakeReference: "  Sana, 09:40  ",
  poNumber: "",
  notes: "",
  intakeAttachmentKey: SCREENSHOT_KEY,
  ...overrides,
})

describe("the price box", () => {
  it("is required: blank is missing, never the catalogue price", () => {
    expect(parseDeskPriceInput("", "Rice")).toEqual({ kind: "missing", error: "Enter the price for Rice, including tax" })
    expect(parseDeskPriceInput("   ", "Rice").kind).toBe("missing")
    expect(parseDeskPriceInput(undefined, "Rice").kind).toBe("missing")
  })

  it("reads rupees with up to two decimals as cents", () => {
    expect(parseDeskPriceInput("250", "Rice")).toEqual({ kind: "entered", cents: 25_000 })
    expect(parseDeskPriceInput("250.5", "Rice")).toEqual({ kind: "entered", cents: 25_050 })
    expect(parseDeskPriceInput("0.01", "Rice")).toEqual({ kind: "entered", cents: 1 })
  })

  it.each([
    ["zero", "0", /must be more than zero/],
    ["zero with decimals", "0.00", /must be more than zero/],
    ["a negative price", "-5", /in rupees/],
    ["three decimals", "1.005", /in rupees/],
    ["words", "fifty", /in rupees/],
    ["a price over the ceiling", "20000001", /too large/],
  ])("refuses %s", (_label, raw, message) => {
    const result = parseDeskPriceInput(raw, "Rice")
    expect(result.kind).toBe("invalid")
    expect(result.kind === "invalid" && result.error).toMatch(message)
  })
})

describe("the lines a draft holds", () => {
  it("keeps a line's quantity and price apart, and its product snapshot from the first touch", () => {
    let lines: DeskLines = {}
    lines = withLinePrice(lines, tape, "75")
    // A price alone does not order the product.
    expect(chosenLines(lines)).toEqual([])
    lines = withLineQuantity(lines, { ...tape, name: "Renamed on a later page" }, "2")
    expect(lines[3]).toEqual({ product: tape, quantity: "2", price: "75" })
    expect(chosenLines(lines).map((line) => line.product.name)).toEqual(["Tape"])
    expect(withoutLine(lines, 3)).toEqual({})
  })

  it("orders by product name and leaves out blank and zero quantities, but not a malformed one", () => {
    const lines = linesOf([tape, "1", "1"], [boxes, "0", "1"], [rice, " ", "1"], [{ ...rice, globalProductId: 9, name: "Apples" }, "lots", "1"])
    expect(chosenLines(lines).map((line) => line.product.name)).toEqual(["Apples", "Tape"])
  })

  it("estimates the total at the typed prices, which already include tax", () => {
    // 1.5 kg × 240 + 4 × 10.50 — nothing added for tax.
    expect(estimateDraftTotalCents(draft().lines)).toBe(36_000 + 4_200)
  })

  it("leaves a line out of the estimate until both its price and quantity are valid", () => {
    expect(estimateDraftTotalCents(linesOf([rice, "2", ""], [boxes, "1", "10"]))).toBe(1_000)
    expect(estimateDraftTotalCents(linesOf([rice, "2", "0"], [boxes, "abc", "10"]))).toBe(0)
  })

  it("marks a typed price that differs from the branch's catalogue price, and only that", () => {
    expect(isDeskPriceChanged({ product: boxes, price: "12" })).toBe(true)
    expect(isDeskPriceChanged({ product: boxes, price: "10.00" })).toBe(false)
    expect(isDeskPriceChanged({ product: boxes, price: "" })).toBe(false)
    // A product the branch does not carry has nothing to differ from.
    expect(isDeskPriceChanged({ product: tape, price: "75" })).toBe(false)
    expect(deskLineUnitPriceCents({ product: tape, price: "75" })).toBe(7_500)
    expect(deskLineUnitPriceCents({ product: tape, price: "" })).toBeNull()
  })
})

describe("turning the desk's draft into an order", () => {
  it("sends every ordered line by global product, with its price in cents", () => {
    expect(buildDeskOrderRequest(draft({ lines: { ...draft().lines, ...linesOf([tape, "3", "75"]) } }))).toEqual({
      ok: true,
      body: {
        organizationId: 7,
        branchId: 70,
        items: [
          { globalProductId: 2, quantity: 4, unitPriceCents: 1_050 },
          { globalProductId: 1, quantity: 1.5, unitPriceCents: 24_000 },
          { globalProductId: 3, quantity: 3, unitPriceCents: 7_500 },
        ],
        intakeChannel: "WHATSAPP",
        intakeReference: "Sana, 09:40",
        intakeAttachmentKey: SCREENSHOT_KEY,
      },
    })
  })

  it("refuses an ordered line without a price, even one the branch has a catalogue price for", () => {
    expect(buildDeskOrderRequest(draft({ lines: linesOf([boxes, "4", ""]) })))
      .toEqual({ ok: false, error: "Enter the price for Boxes, including tax" })
  })

  it("refuses a zero price", () => {
    expect(buildDeskOrderRequest(draft({ lines: linesOf([tape, "1", "0"]) })))
      .toEqual({ ok: false, error: "The price for Tape must be more than zero" })
  })

  it("does not send a product that was priced but not ordered", () => {
    const result = buildDeskOrderRequest(draft({ lines: { ...draft().lines, ...linesOf([tape, "", "75"]) } }))
    expect(result.ok && result.body.items.map((item) => item.globalProductId)).toEqual([2, 1])
  })

  it("requires the customer's screenshot", () => {
    expect(buildDeskOrderRequest(draft({ intakeAttachmentKey: null })))
      .toEqual({ ok: false, error: "Attach a screenshot of the customer's message" })
  })

  it("carries the optional PO number and notes when given", () => {
    const result = buildDeskOrderRequest(draft({ poNumber: " PO-11 ", notes: " deliver by noon " }))
    expect(result.ok && result.body).toMatchObject({ poNumber: "PO-11", notes: "deliver by noon" })
  })

  it.each([
    ["no organization", { organizationId: null }, /organization/],
    ["no branch", { branchId: null }, /branch/],
    ["no products", { lines: {} }, /at least one product/],
    ["a fractional box", { lines: linesOf([boxes, "1.5", "10"]) }, /whole number/],
    ["a malformed quantity", { lines: linesOf([boxes, "lots", "10"]) }, /Quantity for Boxes/],
    ["no channel", { intakeChannel: "" as const }, /came from/],
    ["no reference", { intakeReference: "   " }, /reference/],
    ["an overlong reference", { intakeReference: "x".repeat(256) }, /at most 255/],
  ])("refuses %s", (_label, overrides, message) => {
    const result = buildDeskOrderRequest(draft(overrides as Partial<DeskDraft>))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(message)
  })

  it("lists what the order still needs, a price for every product among it", () => {
    const pending = (lines: DeskLines) => deskDraftChecklist(draft({ lines })).find((check) => check.key === "prices")?.done
    expect(pending({})).toBe(false)
    expect(pending(linesOf([boxes, "4", ""]))).toBe(false)
    expect(pending(linesOf([boxes, "4", "0"]))).toBe(false)
    expect(pending(linesOf([boxes, "4", "10"], [tape, "", ""]))).toBe(true)
    expect(deskDraftChecklist(draft()).every((check) => check.done)).toBe(true)
    expect(deskDraftChecklist(draft({ intakeAttachmentKey: null })).find((check) => check.key === "screenshot"))
      .toEqual({ key: "screenshot", label: "Screenshot of the message", done: false })
  })
})

describe("editing a desk order", () => {
  const orderItems = [
    // Charged the branch's catalogue price.
    { organizationInventoryId: 12, globalProductId: 2, productName: "Boxes", productCode: "P-2", unit: "piece", allowDecimalQuantity: false, quantityStep: 1, quantity: 3, priceCents: 1_000, priceEnteredManually: false, cataloguePriceCents: null },
    // Priced below the branch's catalogue price.
    { organizationInventoryId: 11, globalProductId: 1, productName: "Rice", productCode: "P-1", unit: "kg", allowDecimalQuantity: true, quantityStep: 0.5, quantity: 1.5, priceCents: 24_000, priceEnteredManually: true, cataloguePriceCents: 25_000 },
    // A product the branch did not carry.
    { organizationInventoryId: null, globalProductId: 3, productName: "Tape", productCode: "P-3", unit: null, allowDecimalQuantity: false, quantityStep: 1, quantity: 2, priceCents: 7_500, priceEnteredManually: true, cataloguePriceCents: null },
  ]

  it("opens on the order's lines, each keeping the price it is charged now", () => {
    const lines = deskLinesFromOrder(orderItems)
    expect(chosenLines(lines).map((line) => [line.product.name, line.quantity, line.price])).toEqual([
      ["Boxes", "3", "10.00"],
      ["Rice", "1.5", "240.00"],
      ["Tape", "2", "75.00"],
    ])
    expect(lines[2].product).toMatchObject({ assignedToBranch: true, cataloguePriceCents: 1_000 })
    expect(lines[1].product).toMatchObject({ assignedToBranch: true, cataloguePriceCents: 25_000 })
    expect(lines[3].product).toMatchObject({ assignedToBranch: false, cataloguePriceCents: null, unit: "unit" })
  })

  it("saves unchanged lines exactly as they are charged", () => {
    expect(buildDeskEditRequest({ lines: deskLinesFromOrder(orderItems), notes: " later ", poNumber: "  " })).toEqual({
      ok: true,
      body: {
        items: [
          { globalProductId: 2, quantity: 3, unitPriceCents: 1_000 },
          { globalProductId: 1, quantity: 1.5, unitPriceCents: 24_000 },
          { globalProductId: 3, quantity: 2, unitPriceCents: 7_500 },
        ],
        notes: "later",
        poNumber: null,
      },
    })
  })

  it("refuses an edit that leaves no lines, an invalid quantity, or a cleared price", () => {
    expect(buildDeskEditRequest({ lines: {}, notes: "", poNumber: "" }).ok).toBe(false)
    expect(buildDeskEditRequest({ lines: linesOf([boxes, "2.5", "10"]), notes: "", poNumber: "" }).ok).toBe(false)
    expect(buildDeskEditRequest({ lines: withLinePrice(deskLinesFromOrder(orderItems), tape, ""), notes: "", poNumber: "" }))
      .toEqual({ ok: false, error: "Enter the price for Tape, including tax" })
  })
})

describe("requesting a refund on a desk order", () => {
  const lines = [{ id: 10, productName: "Rice", quantity: 3 }, { id: 11, productName: "Boxes", quantity: 2 }]

  it("sends only the lines given a quantity, with the reason", () => {
    expect(buildDeskRefundRequest(lines, { 10: "1.5", 11: "" }, " damaged ")).toEqual({
      ok: true,
      body: { items: [{ id: 10, quantity: 1.5 }], reason: "damaged" },
    })
  })

  it.each([
    ["nothing chosen", {}, "x", /at least one item/],
    ["more than was ordered", { 11: "3" }, "x", /more Boxes than was ordered/],
    ["a zero quantity", { 10: "0" }, "x", /greater than zero/],
    ["no reason", { 10: "1" }, "  ", /reason is required/],
  ])("refuses %s", (_label, quantities, reason, message) => {
    const result = buildDeskRefundRequest(lines, quantities as Record<number, string>, reason)
    expect(!result.ok && result.error).toMatch(message)
  })
})

describe("the screenshot file", () => {
  it("is held to the upload route's own limit", () => {
    expect(SCREENSHOT_MAX_BYTES).toBe(MAX_IMAGE_UPLOAD_BYTES)
  })

  it("accepts the image types the route sanitises, up to that size", () => {
    expect(screenshotFileError({ type: "image/png", size: 1_000 })).toBeNull()
    expect(screenshotFileError({ type: "image/jpeg", size: SCREENSHOT_MAX_BYTES })).toBeNull()
    expect(screenshotFileError({ type: "image/png", size: SCREENSHOT_MAX_BYTES + 1 })).toMatch(/4 MB/)
    expect(screenshotFileError({ type: "image/svg+xml", size: 10 })).toMatch(/PNG/)
    expect(screenshotFileError({ type: "application/pdf", size: 10 })).toMatch(/PNG/)
  })
})

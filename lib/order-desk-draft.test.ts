import { describe, expect, it } from "vitest"

import { MAX_IMAGE_UPLOAD_BYTES } from "@/lib/server/upload-security"

import {
  buildDeskEditRequest,
  buildDeskOrderRequest,
  buildDeskRefundRequest,
  estimateDraftTotalCents,
  SCREENSHOT_MAX_BYTES,
  screenshotFileError,
  unavailableDraftLines,
  type DeskCatalogueItem,
  type DeskDraft,
} from "./order-desk-draft"

const catalogue: DeskCatalogueItem[] = [
  { organizationInventoryId: 1, name: "Rice", allowDecimalQuantity: true, quantityStep: 0.5, priceCents: 25_000 },
  { organizationInventoryId: 2, name: "Boxes", allowDecimalQuantity: false, quantityStep: 1, priceCents: 1_000 },
  { organizationInventoryId: 3, name: "Unpriced", allowDecimalQuantity: false, quantityStep: 1, priceCents: null },
]

const draft = (overrides: Partial<DeskDraft> = {}): DeskDraft => ({
  organizationId: 7,
  branchId: 70,
  quantities: { 1: "1.5", 2: "4", 3: "" },
  intakeChannel: "WHATSAPP",
  intakeReference: "  Sana, 09:40  ",
  poNumber: "",
  notes: "",
  intakeAttachmentKey: null,
  ...overrides,
})

describe("turning the desk's draft into an order", () => {
  it("builds the request from the filled-in lines only", () => {
    expect(buildDeskOrderRequest(draft(), catalogue)).toEqual({
      ok: true,
      body: {
        organizationId: 7,
        branchId: 70,
        items: [
          { organizationInventoryId: 1, quantity: 1.5 },
          { organizationInventoryId: 2, quantity: 4 },
        ],
        intakeChannel: "WHATSAPP",
        intakeReference: "Sana, 09:40",
      },
    })
  })

  it("carries the screenshot key only when one was uploaded", () => {
    const key = "order-intake/0b9b1c2e-3f4a-4b5c-8d6e-7f8091a2b3c4.png"
    const withKey = buildDeskOrderRequest(draft({ intakeAttachmentKey: key }), catalogue)
    expect(withKey.ok && withKey.body.intakeAttachmentKey).toBe(key)
    const without = buildDeskOrderRequest(draft(), catalogue)
    expect(without.ok && "intakeAttachmentKey" in without.body).toBe(false)
  })

  it("carries the optional PO number and notes when given", () => {
    const result = buildDeskOrderRequest(draft({ poNumber: " PO-11 ", notes: " deliver by noon " }), catalogue)
    expect(result.ok && result.body).toMatchObject({ poNumber: "PO-11", notes: "deliver by noon" })
  })

  it.each([
    ["no organization", { organizationId: null }, /organization/],
    ["no branch", { branchId: null }, /branch/],
    ["no products", { quantities: { 1: " " } }, /at least one product/],
    ["a fractional box", { quantities: { 2: "1.5" } }, /whole number/],
    ["a zero quantity", { quantities: { 2: "0" } }, /greater than zero/],
    ["a product no longer listed", { quantities: { 99: "1" } }, /no longer available/],
    ["no channel", { intakeChannel: "" as const }, /came from/],
    ["no reference", { intakeReference: "   " }, /reference/],
    ["an overlong reference", { intakeReference: "x".repeat(256) }, /at most 255/],
  ])("refuses %s", (_label, overrides, message) => {
    const result = buildDeskOrderRequest(draft(overrides as Partial<DeskDraft>), catalogue)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toMatch(message)
  })

  it("estimates the total from the catalogue prices, skipping what cannot be priced", () => {
    expect(estimateDraftTotalCents(draft({ quantities: { 1: "1.5", 2: "4", 3: "2" } }), catalogue)).toBe(37_500 + 4_000)
    expect(estimateDraftTotalCents(draft({ quantities: { 1: "abc" } }), catalogue)).toBe(0)
  })
})

describe("editing a desk order", () => {
  it("sends the full set of lines, notes, and a PO number that an empty field clears", () => {
    expect(buildDeskEditRequest({ quantities: { 2: "3", 1: "" }, notes: " later ", poNumber: "  " }, catalogue)).toEqual({
      ok: true,
      body: { items: [{ organizationInventoryId: 2, quantity: 3 }], notes: "later", poNumber: null },
    })
  })

  it("refuses an edit that leaves no lines, or an invalid quantity", () => {
    expect(buildDeskEditRequest({ quantities: {}, notes: "", poNumber: "" }, catalogue).ok).toBe(false)
    expect(buildDeskEditRequest({ quantities: { 2: "2.5" }, notes: "", poNumber: "" }, catalogue).ok).toBe(false)
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

describe("lines the branch no longer offers", () => {
  it("names filled-in lines missing from the catalogue, and nothing else", () => {
    expect(unavailableDraftLines({ 1: "2", 2: "", 9: "3", 8: " " }, catalogue)).toEqual([9])
  })

  it("is empty when every chosen product is still offered, or nothing is chosen", () => {
    expect(unavailableDraftLines({ 1: "2", 2: "4" }, catalogue)).toEqual([])
    expect(unavailableDraftLines({}, catalogue)).toEqual([])
  })

  it("names every chosen line when the catalogue is empty", () => {
    expect(unavailableDraftLines({ 1: "2", 2: "4" }, [])).toEqual([1, 2])
  })

  it("is exactly the lines that would stop the request being built", () => {
    const quantities = { 1: "1", 9: "1" }
    expect(buildDeskEditRequest({ quantities, notes: "", poNumber: "" }, catalogue))
      .toEqual({ ok: false, error: "A product in this order is no longer available for this branch" })
    const kept = Object.fromEntries(Object.entries(quantities)
      .filter(([id]) => !unavailableDraftLines(quantities, catalogue).includes(Number(id))))
    expect(buildDeskEditRequest({ quantities: kept, notes: "", poNumber: "" }, catalogue).ok).toBe(true)
  })
})

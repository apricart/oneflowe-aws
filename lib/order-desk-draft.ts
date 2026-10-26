/**
 * The Order Desk's new-order and edit forms, as pure functions: turning what
 * the desk user chose and typed into the body the API accepts, and the
 * estimate it shows before submitting.
 *
 * A desk line names any active Apricart product — whether or not the branch
 * carries it — and needs the price the customer agreed, typed by the desk,
 * including tax (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md).
 * The price box starts empty and the order cannot be sent until every chosen
 * product has a price above zero.
 *
 * Presentation only. The server re-validates every field, re-checks the desk's
 * reach, and re-prices every line inside its own transaction.
 */

import { formatPriceInput, parsePriceInput } from "@/lib/group-price-input"
import { INTAKE_CHANNELS, INTAKE_REFERENCE_MAX_LENGTH, type IntakeChannel } from "@/lib/order-desk-access"
import { calculateLineCents, parseQuantity, validateProductQuantity } from "@/lib/quantity"

/** One product in the desk's picker, as `GET /api/v1/order-desk/catalogue` returns it. */
export type DeskCatalogueItem = {
  globalProductId: number
  organizationInventoryId: number | null
  productCode: string
  name: string
  unit: string
  allowDecimalQuantity: boolean
  quantityStep: number
  stockQuantity: number
  /** The branch carries this product; its catalogue price there is `cataloguePriceCents`. */
  assignedToBranch: boolean
  cataloguePriceCents: number | null
}

/**
 * What a chosen line keeps about its product, so the line survives a new
 * search or another page of the picker.
 */
export type DeskLineProduct = {
  globalProductId: number
  name: string
  productCode: string | null
  unit: string
  allowDecimalQuantity: boolean
  quantityStep: number
  assignedToBranch: boolean
  cataloguePriceCents: number | null
  /** Known when chosen from the picker; an edit's existing lines do not carry it. */
  stockQuantity?: number
}

export type DeskDraftLine = {
  product: DeskLineProduct
  /** Typed quantity; blank or zero means not ordered. */
  quantity: string
  /** Typed unit price in rupees, including tax; required on every ordered line. */
  price: string
}

/** Lines keyed by global product id. */
export type DeskLines = Readonly<Record<number, DeskDraftLine>>

export type DeskDraft = {
  organizationId: number | null
  branchId: number | null
  lines: DeskLines
  intakeChannel: IntakeChannel | ""
  intakeReference: string
  poNumber: string
  notes: string
  /** The key the upload route returned for the customer's screenshot; required before the order can be sent. */
  intakeAttachmentKey: string | null
}

/** One line of a desk request: a global product, its quantity and its agreed tax-inclusive price. */
export type DeskOrderLine = { globalProductId: number; quantity: number; unitPriceCents: number }

export type DeskOrderRequest = {
  organizationId: number
  branchId: number
  items: DeskOrderLine[]
  intakeChannel: IntakeChannel
  intakeReference: string
  poNumber?: string
  notes?: string
  intakeAttachmentKey: string
}

export type DeskDraftResult =
  | { ok: true; body: DeskOrderRequest }
  | { ok: false; error: string }

export const NOTES_MAX_LENGTH = 2000

/** The screenshot types and size the upload route accepts (`MAX_IMAGE_UPLOAD_BYTES`). */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024
export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const

/** Why this file cannot be uploaded as a screenshot, or null. Checked again on the server. */
export function screenshotFileError(file: { type: string; size: number }): string | null {
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) return "Choose a PNG, JPEG, WebP or GIF image"
  if (file.size > SCREENSHOT_MAX_BYTES) return "The screenshot must be 4 MB or smaller"
  return null
}

/** The product a picker row describes, kept on the line it starts. */
export function lineProductOf(item: DeskCatalogueItem): DeskLineProduct {
  return {
    globalProductId: item.globalProductId,
    name: item.name,
    productCode: item.productCode,
    unit: item.unit,
    allowDecimalQuantity: item.allowDecimalQuantity,
    quantityStep: item.quantityStep,
    assignedToBranch: item.assignedToBranch,
    cataloguePriceCents: item.cataloguePriceCents,
    stockQuantity: item.stockQuantity,
  }
}

function isOrdered(line: DeskDraftLine): boolean {
  const raw = line.quantity.trim()
  if (raw === "") return false
  const quantity = parseQuantity(raw)
  // A typed quantity that is not a positive number is still "ordered", so the
  // form reports it rather than silently dropping the line.
  return !(Number.isFinite(quantity) && quantity === 0)
}

/** The lines the desk has actually ordered, by product name. */
export function chosenLines(lines: DeskLines): DeskDraftLine[] {
  return Object.values(lines)
    .filter(isOrdered)
    .sort((a, b) => a.product.name.localeCompare(b.product.name) || a.product.globalProductId - b.product.globalProductId)
}

/** Set a line's quantity, starting the line from its product when it is new. */
export function withLineQuantity(lines: DeskLines, product: DeskLineProduct, quantity: string): DeskLines {
  const current = lines[product.globalProductId]
  return { ...lines, [product.globalProductId]: { product: current?.product ?? product, quantity, price: current?.price ?? "" } }
}

/** Set a line's price, starting the line from its product when it is new. */
export function withLinePrice(lines: DeskLines, product: DeskLineProduct, price: string): DeskLines {
  const current = lines[product.globalProductId]
  return { ...lines, [product.globalProductId]: { product: current?.product ?? product, quantity: current?.quantity ?? "", price } }
}

export function withoutLine(lines: DeskLines, globalProductId: number): DeskLines {
  const next = { ...lines }
  delete next[globalProductId]
  return next
}

export type DeskPriceInput =
  | { kind: "missing"; error: string }
  | { kind: "entered"; cents: number }
  | { kind: "invalid"; error: string }

/**
 * What the desk typed in a line's price box: rupees with at most two
 * decimals, more than zero, including tax. Blank is missing — the price is
 * required. The server holds the same bounds (`MIN_ENTERED_UNIT_PRICE_CENTS`,
 * `MAX_PRICE_CENTS`).
 */
export function parseDeskPriceInput(raw: string | undefined, productName: string): DeskPriceInput {
  const parsed = parsePriceInput(raw ?? "")
  if (!parsed.ok) {
    return {
      kind: "invalid",
      error: parsed.error === "too-large"
        ? `The price for ${productName} is too large`
        : `Enter the price for ${productName} in rupees, e.g. 250 or 250.50`,
    }
  }
  if (parsed.cents === null) return { kind: "missing", error: `Enter the price for ${productName}, including tax` }
  if (parsed.cents <= 0) return { kind: "invalid", error: `The price for ${productName} must be more than zero` }
  return { kind: "entered", cents: parsed.cents }
}

/** The valid typed unit price, or null while it is blank or invalid. */
export function deskLineUnitPriceCents(line: Pick<DeskDraftLine, "product" | "price">): number | null {
  const price = parseDeskPriceInput(line.price, line.product.name)
  return price.kind === "entered" ? price.cents : null
}

/** True when a valid typed price differs from the branch's catalogue price for the product. */
export function isDeskPriceChanged(line: Pick<DeskDraftLine, "product" | "price">): boolean {
  const cents = deskLineUnitPriceCents(line)
  return cents !== null && line.product.cataloguePriceCents !== null && cents !== line.product.cataloguePriceCents
}

/** The ordered lines, validated, or the first reason they cannot be sent. */
export function buildDeskOrderLines(lines: DeskLines): { ok: true; items: DeskOrderLine[] } | { ok: false; error: string } {
  const items: DeskOrderLine[] = []
  for (const line of chosenLines(lines)) {
    const check = validateProductQuantity(line.quantity.trim(), {
      allowDecimalQuantity: line.product.allowDecimalQuantity,
      quantityStep: line.product.quantityStep,
      label: `Quantity for ${line.product.name}`,
    })
    if (!check.ok) return { ok: false, error: check.error }
    const price = parseDeskPriceInput(line.price, line.product.name)
    if (price.kind !== "entered") return { ok: false, error: price.error }
    items.push({ globalProductId: line.product.globalProductId, quantity: check.quantity, unitPriceCents: price.cents })
  }
  return items.length === 0 ? { ok: false, error: "Add at least one product" } : { ok: true, items }
}

export function buildDeskOrderRequest(draft: DeskDraft): DeskDraftResult {
  if (!draft.organizationId) return { ok: false, error: "Choose an organization" }
  if (!draft.branchId) return { ok: false, error: "Choose a branch" }

  const lines = buildDeskOrderLines(draft.lines)
  if (!lines.ok) return lines

  if (!(INTAKE_CHANNELS as readonly string[]).includes(draft.intakeChannel)) {
    return { ok: false, error: "Choose where this order came from" }
  }
  const intakeReference = draft.intakeReference.trim()
  if (!intakeReference) return { ok: false, error: "Add a reference for the customer's message" }
  if (intakeReference.length > INTAKE_REFERENCE_MAX_LENGTH) {
    return { ok: false, error: `The reference must be at most ${INTAKE_REFERENCE_MAX_LENGTH} characters` }
  }
  if (!draft.intakeAttachmentKey) return { ok: false, error: "Attach a screenshot of the customer's message" }
  const notes = draft.notes.trim()
  if (notes.length > NOTES_MAX_LENGTH) return { ok: false, error: `Notes must be at most ${NOTES_MAX_LENGTH} characters` }
  const poNumber = draft.poNumber.trim()

  return {
    ok: true,
    body: {
      organizationId: draft.organizationId,
      branchId: draft.branchId,
      items: lines.items,
      intakeChannel: draft.intakeChannel as IntakeChannel,
      intakeReference,
      ...(poNumber ? { poNumber } : {}),
      ...(notes ? { notes } : {}),
      intakeAttachmentKey: draft.intakeAttachmentKey,
    },
  }
}

/**
 * The estimated total of the ordered lines, in cents, at the prices typed —
 * which already include tax, so nothing is added. A line whose quantity or
 * price is not yet valid contributes nothing.
 */
export function estimateDraftTotalCents(lines: DeskLines): number {
  let total = 0
  for (const line of chosenLines(lines)) {
    const quantity = parseQuantity(line.quantity)
    const unitPriceCents = deskLineUnitPriceCents(line)
    if (unitPriceCents === null || !Number.isFinite(quantity) || quantity <= 0) continue
    total += calculateLineCents(unitPriceCents, quantity)
  }
  return total
}

export type DeskEditRequest = {
  items: DeskOrderLine[]
  notes: string
  poNumber: string | null
}

/**
 * An edit of a pending desk order: the full set of lines it should now have,
 * plus notes and PO number (an empty PO number clears it).
 */
export function buildDeskEditRequest(
  input: { lines: DeskLines; notes: string; poNumber: string },
): { ok: true; body: DeskEditRequest } | { ok: false; error: string } {
  const lines = buildDeskOrderLines(input.lines)
  if (!lines.ok) return lines
  const notes = input.notes.trim()
  if (notes.length > NOTES_MAX_LENGTH) return { ok: false, error: `Notes must be at most ${NOTES_MAX_LENGTH} characters` }
  return { ok: true, body: { items: lines.items, notes, poNumber: input.poNumber.trim() || null } }
}

/** A desk order's line as `GET /api/v1/order-desk/orders` returns it, enough to edit it. */
export type DeskOrderItemForEdit = {
  organizationInventoryId: number | null
  globalProductId: number
  productName: string
  productCode: string | null
  unit: string | null
  allowDecimalQuantity: boolean
  quantityStep: number
  quantity: number
  priceCents: number
  priceEnteredManually?: boolean
  cataloguePriceCents?: number | null
}

/**
 * An existing order's lines as an edit draft. Each keeps the price it is
 * charged now, so saving without touching a line changes nothing about it.
 */
export function deskLinesFromOrder(items: readonly DeskOrderItemForEdit[]): DeskLines {
  const lines: Record<number, DeskDraftLine> = {}
  for (const item of items) {
    lines[item.globalProductId] = {
      product: {
        globalProductId: item.globalProductId,
        name: item.productName,
        productCode: item.productCode,
        unit: item.unit ?? "unit",
        allowDecimalQuantity: item.allowDecimalQuantity,
        quantityStep: item.quantityStep,
        assignedToBranch: item.organizationInventoryId !== null,
        cataloguePriceCents: referenceCataloguePrice(item),
      },
      quantity: String(item.quantity),
      price: formatPriceInput(item.priceCents),
    }
  }
  return lines
}

/**
 * The branch's price at the time the line was ordered: recorded beside a
 * typed price, or the line's own price when it was charged the catalogue
 * price. None for a product the branch did not carry.
 */
function referenceCataloguePrice(item: DeskOrderItemForEdit): number | null {
  if (item.priceEnteredManually) return item.cataloguePriceCents ?? null
  return item.organizationInventoryId === null ? null : item.priceCents
}

export type DeskRefundLine = { id: number; productName: string; quantity: number }

/**
 * A refund request on a fulfilled desk order: the lines and quantities to
 * refund, and why. Super Admin approves it; the server checks what remains
 * refundable.
 */
export function buildDeskRefundRequest(
  lines: readonly DeskRefundLine[],
  quantities: Readonly<Record<number, string>>,
  reason: string,
): { ok: true; body: { items: { id: number; quantity: number }[]; reason: string } } | { ok: false; error: string } {
  const items: { id: number; quantity: number }[] = []
  for (const line of lines) {
    const raw = quantities[line.id]?.trim() ?? ""
    if (raw === "") continue
    const quantity = parseQuantity(raw)
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: `Refund quantity for ${line.productName} must be greater than zero` }
    if (quantity > line.quantity) return { ok: false, error: `You cannot refund more ${line.productName} than was ordered` }
    items.push({ id: line.id, quantity })
  }
  if (items.length === 0) return { ok: false, error: "Choose at least one item to refund" }
  const trimmed = reason.trim()
  if (!trimmed) return { ok: false, error: "A refund reason is required" }
  if (trimmed.length > 2000) return { ok: false, error: "The reason must be at most 2000 characters" }
  return { ok: true, body: { items, reason: trimmed } }
}

export type DeskDraftCheck = {
  key: "customer" | "products" | "prices" | "channel" | "reference" | "screenshot"
  label: string
  done: boolean
}

/**
 * What a new order still needs, in the order the form asks for it — shown
 * beside the Create button so it is clear why the order cannot be sent yet.
 */
export function deskDraftChecklist(draft: DeskDraft): DeskDraftCheck[] {
  const chosen = chosenLines(draft.lines)
  return [
    { key: "customer", label: "Organization and branch", done: Boolean(draft.organizationId && draft.branchId) },
    { key: "products", label: "At least one product", done: chosen.length > 0 },
    { key: "prices", label: "A price for every product", done: chosen.length > 0 && chosen.every((line) => deskLineUnitPriceCents(line) !== null) },
    { key: "channel", label: "Order channel", done: draft.intakeChannel !== "" },
    { key: "reference", label: "Message reference", done: draft.intakeReference.trim() !== "" },
    { key: "screenshot", label: "Screenshot of the message", done: Boolean(draft.intakeAttachmentKey) },
  ]
}

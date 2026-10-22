/**
 * The Order Desk's new-order form, as pure functions: turning what the desk
 * user typed into the body `POST /api/v1/orders` accepts, and the estimate it
 * shows before submitting.
 *
 * Presentation only. The server re-validates every field, re-checks the desk's
 * reach, and re-prices every line through the price ladder; the estimate here
 * uses the catalogue's prices, which come from that same ladder — or the price
 * the desk typed for a line, which the server then charges instead
 * (plans/OF-ORDER-DESK-line-price-entry.md).
 */

import { parsePriceInput } from "@/lib/group-price-input"
import { INTAKE_CHANNELS, INTAKE_REFERENCE_MAX_LENGTH, type IntakeChannel } from "@/lib/order-desk-access"
import { calculateLineCents, parseQuantity, validateProductQuantity } from "@/lib/quantity"

export type DeskCatalogueItem = {
  organizationInventoryId: number
  name: string
  allowDecimalQuantity: boolean
  quantityStep: number
  priceCents: number | null
}

export type DeskDraft = {
  organizationId: number | null
  branchId: number | null
  /** Typed quantities keyed by organization inventory id; blank means not ordered. */
  quantities: Readonly<Record<number, string>>
  /** Typed unit prices in rupees, keyed the same way; blank means the catalogue price. */
  prices: Readonly<Record<number, string>>
  intakeChannel: IntakeChannel | ""
  intakeReference: string
  poNumber: string
  notes: string
  /** The key the upload route returned for the customer's screenshot; required before the order can be sent. */
  intakeAttachmentKey: string | null
}

/** One line of a desk request; `unitPriceCents` only when the desk typed a price. */
export type DeskOrderLine = { organizationInventoryId: number; quantity: number; unitPriceCents?: number }

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

/** The lines the desk user has actually filled in. */
export function filledLines(draft: Pick<DeskDraft, "quantities">): { organizationInventoryId: number; raw: string }[] {
  return Object.entries(draft.quantities)
    .filter(([, raw]) => raw.trim() !== "")
    .map(([id, raw]) => ({ organizationInventoryId: Number(id), raw: raw.trim() }))
}

/**
 * Filled-in lines whose product the branch catalogue no longer offers — it was
 * hidden, deactivated or unassigned after it was chosen, or after the order
 * being edited was placed. The form has no row for them, so it must list them
 * to be removed; otherwise the draft can never be sent and nothing says why.
 */
export function unavailableDraftLines(
  quantities: Readonly<Record<number, string>>,
  catalogue: readonly Pick<DeskCatalogueItem, "organizationInventoryId">[],
): number[] {
  const offered = new Set(catalogue.map((item) => item.organizationInventoryId))
  return filledLines({ quantities })
    .map((line) => line.organizationInventoryId)
    .filter((id) => !offered.has(id))
}

export type DeskPriceInput =
  /** Nothing typed: the line is charged the catalogue price. */
  | { kind: "catalogue" }
  | { kind: "entered"; cents: number }
  | { kind: "invalid"; error: string }

/**
 * What the desk typed in a line's price box: rupees with at most two decimals,
 * more than zero; blank means the catalogue price. The server holds the same
 * bounds (`MIN_ENTERED_UNIT_PRICE_CENTS`, `MAX_PRICE_CENTS`).
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
  if (parsed.cents === null) return { kind: "catalogue" }
  if (parsed.cents <= 0) return { kind: "invalid", error: `The price for ${productName} must be more than zero` }
  return { kind: "entered", cents: parsed.cents }
}

/**
 * The unit price a line will be charged: the typed one when it is a valid
 * price, else the catalogue's (null when the catalogue has none).
 */
export function deskLineUnitPriceCents(item: Pick<DeskCatalogueItem, "name" | "priceCents">, rawPrice: string | undefined): number | null {
  const price = parseDeskPriceInput(rawPrice, item.name)
  return price.kind === "entered" ? price.cents : item.priceCents
}

/** True when the typed price is valid and differs from the catalogue's. */
export function isDeskPriceChanged(item: Pick<DeskCatalogueItem, "name" | "priceCents">, rawPrice: string | undefined): boolean {
  const price = parseDeskPriceInput(rawPrice, item.name)
  return price.kind === "entered" && price.cents !== item.priceCents
}

/** The filled-in lines, validated against the branch catalogue, or why not. */
export function buildDeskOrderLines(
  quantities: Readonly<Record<number, string>>,
  catalogue: readonly DeskCatalogueItem[],
  prices: Readonly<Record<number, string>> = {},
): { ok: true; items: DeskOrderLine[] } | { ok: false; error: string } {
  const byId = new Map(catalogue.map((item) => [item.organizationInventoryId, item]))
  const items: DeskOrderLine[] = []
  for (const line of filledLines({ quantities })) {
    const product = byId.get(line.organizationInventoryId)
    if (!product) return { ok: false, error: "A product in this order is no longer available for this branch" }
    const check = validateProductQuantity(line.raw, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!check.ok) return { ok: false, error: check.error }
    const price = parseDeskPriceInput(prices[product.organizationInventoryId], product.name)
    if (price.kind === "invalid") return { ok: false, error: price.error }
    if (price.kind === "catalogue" && product.priceCents === null) {
      return { ok: false, error: `${product.name} has no catalogue price; enter its price` }
    }
    items.push({
      organizationInventoryId: product.organizationInventoryId,
      quantity: check.quantity,
      ...(price.kind === "entered" ? { unitPriceCents: price.cents } : {}),
    })
  }
  return items.length === 0 ? { ok: false, error: "Add at least one product" } : { ok: true, items }
}

export function buildDeskOrderRequest(draft: DeskDraft, catalogue: readonly DeskCatalogueItem[]): DeskDraftResult {
  if (!draft.organizationId) return { ok: false, error: "Choose an organization" }
  if (!draft.branchId) return { ok: false, error: "Choose a branch" }

  const lines = buildDeskOrderLines(draft.quantities, catalogue, draft.prices)
  if (!lines.ok) return lines
  const items = lines.items

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
      items,
      intakeChannel: draft.intakeChannel as IntakeChannel,
      intakeReference,
      ...(poNumber ? { poNumber } : {}),
      ...(notes ? { notes } : {}),
      intakeAttachmentKey: draft.intakeAttachmentKey,
    },
  }
}

/**
 * The estimated total of the filled-in lines, in cents, at the price each will
 * be charged — the typed one, else the catalogue's. Lines whose quantity is not
 * yet a number, or that have no price either way, contribute nothing.
 */
export function estimateDraftTotalCents(
  draft: Pick<DeskDraft, "quantities"> & Partial<Pick<DeskDraft, "prices">>,
  catalogue: readonly DeskCatalogueItem[],
): number {
  const byId = new Map(catalogue.map((item) => [item.organizationInventoryId, item]))
  let total = 0
  for (const line of filledLines(draft)) {
    const product = byId.get(line.organizationInventoryId)
    const quantity = parseQuantity(line.raw)
    if (!product || !Number.isFinite(quantity) || quantity <= 0) continue
    const unitPriceCents = deskLineUnitPriceCents(product, draft.prices?.[line.organizationInventoryId])
    if (unitPriceCents === null) continue
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
 * An edit of an Active desk order: the full set of lines it should now have,
 * plus notes and PO number (an empty PO number clears it).
 */
export function buildDeskEditRequest(
  input: {
    quantities: Readonly<Record<number, string>>
    prices?: Readonly<Record<number, string>>
    notes: string
    poNumber: string
  },
  catalogue: readonly DeskCatalogueItem[],
): { ok: true; body: DeskEditRequest } | { ok: false; error: string } {
  const lines = buildDeskOrderLines(input.quantities, catalogue, input.prices)
  if (!lines.ok) return lines
  const notes = input.notes.trim()
  if (notes.length > NOTES_MAX_LENGTH) return { ok: false, error: `Notes must be at most ${NOTES_MAX_LENGTH} characters` }
  return { ok: true, body: { items: lines.items, notes, poNumber: input.poNumber.trim() || null } }
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

export type DeskDraftCheck = { key: "customer" | "products" | "channel" | "reference" | "screenshot"; label: string; done: boolean }

/**
 * What a new order still needs, in the order the form asks for it — shown
 * beside the Create button so it is clear why the order cannot be sent yet.
 */
export function deskDraftChecklist(draft: DeskDraft): DeskDraftCheck[] {
  return [
    { key: "customer", label: "Organization and branch", done: Boolean(draft.organizationId && draft.branchId) },
    { key: "products", label: "At least one product", done: filledLines(draft).length > 0 },
    { key: "channel", label: "Order channel", done: draft.intakeChannel !== "" },
    { key: "reference", label: "Message reference", done: draft.intakeReference.trim() !== "" },
    { key: "screenshot", label: "Screenshot of the message", done: Boolean(draft.intakeAttachmentKey) },
  ]
}

/**
 * The Order Desk's new-order form, as pure functions: turning what the desk
 * user typed into the body `POST /api/v1/orders` accepts, and the estimate it
 * shows before submitting.
 *
 * Presentation only. The server re-validates every field, re-checks the desk's
 * reach, and re-prices every line through the price ladder; the estimate here
 * uses the catalogue's prices, which come from that same ladder.
 */

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
  intakeChannel: IntakeChannel | ""
  intakeReference: string
  poNumber: string
  notes: string
  /** The key the upload route returned for the customer's screenshot, if any. */
  intakeAttachmentKey: string | null
}

export type DeskOrderRequest = {
  organizationId: number
  branchId: number
  items: { organizationInventoryId: number; quantity: number }[]
  intakeChannel: IntakeChannel
  intakeReference: string
  poNumber?: string
  notes?: string
  intakeAttachmentKey?: string
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

/** The filled-in lines, validated against the branch catalogue, or why not. */
export function buildDeskOrderLines(
  quantities: Readonly<Record<number, string>>,
  catalogue: readonly DeskCatalogueItem[],
): { ok: true; items: DeskOrderRequest["items"] } | { ok: false; error: string } {
  const byId = new Map(catalogue.map((item) => [item.organizationInventoryId, item]))
  const items: DeskOrderRequest["items"] = []
  for (const line of filledLines({ quantities })) {
    const product = byId.get(line.organizationInventoryId)
    if (!product) return { ok: false, error: "A product in this order is no longer available for this branch" }
    const check = validateProductQuantity(line.raw, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!check.ok) return { ok: false, error: check.error }
    items.push({ organizationInventoryId: product.organizationInventoryId, quantity: check.quantity })
  }
  return items.length === 0 ? { ok: false, error: "Add at least one product" } : { ok: true, items }
}

export function buildDeskOrderRequest(draft: DeskDraft, catalogue: readonly DeskCatalogueItem[]): DeskDraftResult {
  if (!draft.organizationId) return { ok: false, error: "Choose an organization" }
  if (!draft.branchId) return { ok: false, error: "Choose a branch" }

  const lines = buildDeskOrderLines(draft.quantities, catalogue)
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
      ...(draft.intakeAttachmentKey ? { intakeAttachmentKey: draft.intakeAttachmentKey } : {}),
    },
  }
}

/**
 * The estimated total of the filled-in lines, in cents. Lines whose quantity
 * is not yet a number, or whose product has no price, contribute nothing.
 */
export function estimateDraftTotalCents(draft: Pick<DeskDraft, "quantities">, catalogue: readonly DeskCatalogueItem[]): number {
  const byId = new Map(catalogue.map((item) => [item.organizationInventoryId, item]))
  let total = 0
  for (const line of filledLines(draft)) {
    const product = byId.get(line.organizationInventoryId)
    const quantity = parseQuantity(line.raw)
    if (!product || product.priceCents === null || !Number.isFinite(quantity) || quantity <= 0) continue
    total += calculateLineCents(product.priceCents, quantity)
  }
  return total
}

export type DeskEditRequest = {
  items: { organizationInventoryId: number; quantity: number }[]
  notes: string
  poNumber: string | null
}

/**
 * An edit of an Active desk order: the full set of lines it should now have,
 * plus notes and PO number (an empty PO number clears it).
 */
export function buildDeskEditRequest(
  input: { quantities: Readonly<Record<number, string>>; notes: string; poNumber: string },
  catalogue: readonly DeskCatalogueItem[],
): { ok: true; body: DeskEditRequest } | { ok: false; error: string } {
  const lines = buildDeskOrderLines(input.quantities, catalogue)
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

export type DeskDraftCheck = { key: "customer" | "products" | "channel" | "reference"; label: string; done: boolean }

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
  ]
}

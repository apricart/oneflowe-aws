/**
 * Who may change a price. One rule, one place.
 *
 * **Only a Super Admin may write a price, at any tier.** That covers the global
 * base price, the organization override, and the group override — the three
 * tiers `lib/price-ladder.ts` resolves. The rule is deliberately absolute: a
 * price decides what every branch under it is charged, so the authority to set
 * one does not follow the authority to manage the thing it is attached to.
 * Head Office administers organizations, branches, and groups, and still cannot
 * reprice any of them.
 *
 * Reading a price is mostly not restricted here. Head Office has to see what
 * its branches pay to do its job; `lib/price-visibility.ts` governs who may see
 * a price on the branch-facing screens. The one read this module does gate is
 * the **global base price** — the internal cost the catalogue is built on,
 * which sits above every tenant and is nobody's business but a Super Admin's.
 * See `canViewGlobalBasePrice`.
 *
 * No imports, no `server-only`: the API routes enforce it, the React screens
 * use it to render a read-only view, and the unit tests call it directly. One
 * source of truth beats three copies that drift.
 */

/** The only roles permitted to write a price. Deliberately a list of one. */
export const PRICE_MUTATION_ROLES = ["SUPER_ADMIN"] as const

export type PriceMutationRole = (typeof PRICE_MUTATION_ROLES)[number]

/** Every field name, across every endpoint, that carries a price into a write. */
export const PRICE_FIELD_NAMES = [
  "basePrice",
  "basePriceCents",
  "customPrice",
  "customPriceCents",
  "price",
  "priceCents",
] as const

export const PRICE_MUTATION_FORBIDDEN_MESSAGE =
  "Forbidden: only a Super Admin may change prices"

export type PriceAccessFailure = { message: string; status: number }

/**
 * The only roles permitted to *see* the global base price. Also a list of one.
 *
 * The base price is the internal figure the whole ladder is built on: it is set
 * once, globally, and every organization's price is negotiated down from it.
 * Showing it to a tenant exposes the margin on every product they buy, so Head
 * Office sees what its own branches pay and never the number underneath.
 *
 * Deliberately separate from `PRICE_MUTATION_ROLES`: the two lists happen to
 * hold the same role today, but they answer different questions, and folding
 * them together would make "may see the cost" silently follow "may set a price"
 * the first time either list changes.
 */
export const GLOBAL_PRICE_VIEW_ROLES = ["SUPER_ADMIN"] as const

export type GlobalPriceViewRole = (typeof GLOBAL_PRICE_VIEW_ROLES)[number]

/**
 * The only roles permitted to set the price of **one order line** — never a
 * catalogue tier. Also a list of one: Apricart's Order Desk keys in orders a
 * customer agreed by email or WhatsApp, sometimes at a price of their own
 * (plans/OF-ORDER-DESK-line-price-entry.md).
 *
 * Deliberately separate from `PRICE_MUTATION_ROLES`: a line price changes what
 * one order is charged and nothing else, so it carries no authority over the
 * catalogue — and Super Admin's authority over the catalogue does not make
 * every order it places hand-priced. Every desk order waits for an Apricart
 * Executive, who sees the catalogue price beside the entered one.
 */
export const ORDER_LINE_PRICE_ROLES = ["ORDER_DESK"] as const

export const ORDER_LINE_PRICE_FORBIDDEN_MESSAGE =
  "Forbidden: only the Order Desk may set the price of an order line"

/** True only for a role allowed to set an order line's price. */
export function canSetOrderLinePrice(role: unknown): boolean {
  return typeof role === "string"
    && (ORDER_LINE_PRICE_ROLES as readonly string[]).includes(role)
}

/**
 * Guard for an order write whose lines may carry `unitPriceCents`. Returns the
 * failure when any line carries one and the caller may not set it — refused,
 * never stripped, so a caller that thinks it priced a line is told it did not.
 */
export function orderLinePriceFailure(
  role: unknown,
  items: readonly { unitPriceCents?: number | null }[],
): PriceAccessFailure | null {
  const touchesPrice = items.some((item) => item.unitPriceCents !== undefined && item.unitPriceCents !== null)
  if (!touchesPrice || canSetOrderLinePrice(role)) return null
  return { message: ORDER_LINE_PRICE_FORBIDDEN_MESSAGE, status: 403 }
}

/** True only for a role allowed to see the global base price. */
export function canViewGlobalBasePrice(role: unknown): role is GlobalPriceViewRole {
  return typeof role === "string"
    && (GLOBAL_PRICE_VIEW_ROLES as readonly string[]).includes(role)
}

/** True only for a role allowed to write a price. Unknown values are never allowed. */
export function canMutatePrices(role: unknown): role is PriceMutationRole {
  return typeof role === "string"
    && (PRICE_MUTATION_ROLES as readonly string[]).includes(role)
}

/**
 * Guard for an endpoint whose whole purpose is changing prices.
 *
 * Returns the failure to send, or null when the caller may proceed.
 */
export function priceMutationFailure(role: unknown): PriceAccessFailure | null {
  return canMutatePrices(role)
    ? null
    : { message: PRICE_MUTATION_FORBIDDEN_MESSAGE, status: 403 }
}

/**
 * True when a request body is trying to set a price.
 *
 * A key present with the value `undefined` is not an attempt — that is how the
 * routes here spell "leave this field alone". An explicit `null` *is* an
 * attempt: it clears the price.
 */
export function payloadTouchesPrice(
  body: unknown,
  fieldNames: readonly string[] = PRICE_FIELD_NAMES,
): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false
  const record = body as Record<string, unknown>
  return fieldNames.some((field) => field in record && record[field] !== undefined)
}

/**
 * Guard for a mixed endpoint — one that edits several fields, only some of
 * which are prices.
 *
 * Head Office keeps editing names, images, and availability; the request is
 * refused only when it also carries a price. Refusing the whole request rather
 * than silently dropping the price field is deliberate: a caller that thinks it
 * repriced something must be told it did not.
 */
export function rejectPriceFieldsForRole(
  role: unknown,
  body: unknown,
  fieldNames: readonly string[] = PRICE_FIELD_NAMES,
): PriceAccessFailure | null {
  if (!payloadTouchesPrice(body, fieldNames)) return null
  return priceMutationFailure(role)
}

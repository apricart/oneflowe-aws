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
 * Reading a price is not restricted here. Head Office has to see what its
 * branches pay to do its job; `lib/price-visibility.ts` governs who may see a
 * price, and this module governs only who may change one.
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

/**
 * Delivery addresses for a branch — every rule that does not need a database.
 *
 * A branch has one address of its own (`branches.address`, formatted by
 * `formatBranchAddress`), and that stays the default. This module is about the
 * *additional* places a branch needs goods delivered to: a yard, a site office,
 * a second gate. Somebody at the branch asks for one, Head Office approves it,
 * and only then can an order be sent there.
 *
 * Nothing here imports a database, a session, or `node:crypto`, so the request
 * form, the approval queue and the endpoints all hold the same rules and cannot
 * disagree about what a duplicate is or which statuses exist.
 */

import { formatBranchAddress } from "@/lib/branch-address"

/**
 * The lifecycle. A row is created `pending` and is usable only at `approved`.
 *
 * Pinned by a check constraint on `branch_delivery_addresses.status`, so an
 * endpoint that forgets this list still cannot write a fourth.
 */
export const DELIVERY_ADDRESS_STATUSES = ["pending", "approved", "rejected"] as const

export type DeliveryAddressStatus = (typeof DELIVERY_ADDRESS_STATUSES)[number]

export function isDeliveryAddressStatus(value: unknown): value is DeliveryAddressStatus {
  return typeof value === "string"
    && (DELIVERY_ADDRESS_STATUSES as readonly string[]).includes(value)
}

/** What Head Office may do with a pending request. */
export const DELIVERY_ADDRESS_DECISIONS = ["approve", "reject"] as const

export type DeliveryAddressDecision = (typeof DELIVERY_ADDRESS_DECISIONS)[number]

export function isDeliveryAddressDecision(value: unknown): value is DeliveryAddressDecision {
  return typeof value === "string"
    && (DELIVERY_ADDRESS_DECISIONS as readonly string[]).includes(value)
}

/** The status a decision produces. The only mapping between the two vocabularies. */
export function statusForDecision(decision: DeliveryAddressDecision): DeliveryAddressStatus {
  return decision === "approve" ? "approved" : "rejected"
}

/**
 * Bounds, matching the column widths in `db/schema.ts`.
 *
 * Exported so the form can show the same limit the endpoint enforces rather
 * than letting a user type past it and be refused on submit.
 */
export const MAX_DELIVERY_ADDRESS_LABEL = 120
export const MAX_DELIVERY_ADDRESS_LINE = 500
export const MAX_DELIVERY_ADDRESS_CITY = 100
export const MAX_DELIVERY_ADDRESS_PROVINCE = 100
export const MAX_DELIVERY_ADDRESS_CONTACT_PERSON = 255
export const MAX_DELIVERY_ADDRESS_CONTACT_PHONE = 32
export const MAX_DELIVERY_ADDRESS_REASON = 2_000

/** A bounded page, so a list endpoint cannot be asked for a whole tenant at once. */
export const MAX_DELIVERY_ADDRESS_PAGE = 200

/**
 * The label as it is stored and shown: trimmed, with runs of whitespace
 * collapsed to one space.
 *
 * Collapsing matters because the label is what a person reads on the checkout
 * selector. "Gate  2" and "Gate 2" are the same place, and offering both would
 * make the picker a guess.
 */
export function normalizeDeliveryAddressLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ")
}

/**
 * The one spelling a duplicate is judged on, stored in `label_key`.
 *
 * Kept as a separate column and written by the server, exactly as
 * `organization_join_requests.email` is stored already lower-cased: that is
 * what lets the pending/approved uniqueness index be a plain column index
 * rather than a functional one, and what stops two callers racing the same
 * label past a read-then-write check.
 *
 * **`normalizeDeliveryAddressLabel` and this must agree**, which is why this
 * is defined in terms of it rather than repeating the trim and the collapse.
 * A key that merely looks equivalent lets one address into a branch twice.
 */
export function deliveryAddressLabelKey(label: string): string {
  return normalizeDeliveryAddressLabel(label).toLowerCase()
}

/** The parts every renderer of a delivery address needs. */
export type DeliveryAddressParts = {
  label?: string | null
  address?: string | null
  city?: string | null
  province?: string | null
}

/**
 * The address line, formatted the way the branch's own address already is.
 *
 * Deliberately delegates to `formatBranchAddress` rather than reimplementing
 * the join: the branch default and an approved delivery address appear in the
 * same selector and on the same invoice, so they have to read alike.
 */
export function formatDeliveryAddress(parts: DeliveryAddressParts | null | undefined): string {
  return formatBranchAddress(parts ?? null)
}

/** Label first, then the address line — how the selector and the queue read. */
export function describeDeliveryAddress(parts: DeliveryAddressParts | null | undefined): string {
  if (!parts) return ""
  const label = normalizeDeliveryAddressLabel(parts.label ?? "")
  const line = formatDeliveryAddress(parts)
  if (!label) return line
  return line ? `${label} — ${line}` : label
}

/**
 * What an order-writing route throws from inside its transaction when the
 * chosen address is not an approved address of that order's branch.
 *
 * A sentinel rather than a free-form message, so the creation route and the
 * edit route can each answer 400 on an exact match instead of relying on the
 * substring heuristics that sit beside them — and so the two refuse the same
 * thing in the same words.
 *
 * What the caller sees is deliberately the same whether the address is
 * pending, rejected, another branch's or another tenant's: it says nothing
 * about which, so the id space cannot be probed through the order endpoint.
 */
export const DELIVERY_ADDRESS_UNAVAILABLE = "That delivery address is not available for this branch"

/**
 * Whether an address may be delivered to.
 *
 * The single definition of "available for use", so the checkout selector, the
 * order-creation guard and the tests cannot drift apart about it. A pending
 * request is visible to the branch that raised it and is not this.
 */
export function isUsableDeliveryAddress(
  address: { status?: string | null } | null | undefined,
): boolean {
  return address?.status === "approved"
}

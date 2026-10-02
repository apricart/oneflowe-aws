/**
 * Who may raise, read and decide a new-product request.
 *
 * | Role          | Raise | Read                          | Decide |
 * |---------------|-------|-------------------------------|--------|
 * | `SUPER_ADMIN` | no    | every request, every tenant   | yes    |
 * | `HEAD_OFFICE` | yes   | every request in its tenant   | no     |
 * | anyone else   | no    | nothing                       | no     |
 *
 * Head Office reads its whole organization's requests rather than only its own
 * so that two Head Office users do not ask for the same product twice. Super
 * Admin does not raise requests: the catalogue is its own, it adds a product
 * directly.
 *
 * These are role allowlists rather than `Permission` keys, following
 * `lib/organization-join-access.ts`: `ROLE_TEMPLATES.SUPER_ADMIN` is
 * `Object.values(Permission)`, so a "raise a product request" permission would
 * be granted to Super Admin by construction, which is exactly what the table
 * above rules out; and `rolePermissions` rows exist only after `db:seed`, so a
 * permission check would pass or fail by seeding rather than by the rule.
 *
 * Pure — no database, no session, no request. Callers supply facts read from
 * the session and the database, never from the request body. Mirrors
 * `lib/support-access.ts`: the list query is built from
 * `productRequestVisibilityScope`, so the list and a single-row check cannot
 * disagree.
 */

export const PRODUCT_REQUEST_RAISER_ROLES = ["HEAD_OFFICE"] as const
export const PRODUCT_REQUEST_REVIEWER_ROLES = ["SUPER_ADMIN"] as const
/** Every role that may open the Product Requests page at all. */
export const PRODUCT_REQUEST_READER_ROLES = [
  ...PRODUCT_REQUEST_REVIEWER_ROLES,
  ...PRODUCT_REQUEST_RAISER_ROLES,
] as const

const includesRole = (roles: readonly string[], role: unknown): boolean =>
  typeof role === "string" && roles.includes(role)

export function canRaiseProductRequest(role: unknown): boolean {
  return includesRole(PRODUCT_REQUEST_RAISER_ROLES, role)
}

export function canReviewProductRequest(role: unknown): boolean {
  return includesRole(PRODUCT_REQUEST_REVIEWER_ROLES, role)
}

export function canOpenProductRequests(role: unknown): boolean {
  return includesRole(PRODUCT_REQUEST_READER_ROLES, role)
}

/** The viewer, as read from the session. Never from a request. */
export type ProductRequestViewer = {
  role: string | null | undefined
  organizationId: number | null | undefined
}

/**
 * How a viewer's list is narrowed.
 *
 * - `all`          — every request on the platform (Super Admin).
 * - `organization` — every request in `organizationId` (Head Office).
 * - `none`         — nothing: the role may not read, or its session is missing
 *                    the tenant its role requires. An absent organization is
 *                    never read as "all organizations".
 */
export type ProductRequestVisibilityScope =
  | { kind: "all" }
  | { kind: "organization"; organizationId: number }
  | { kind: "none" }

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function productRequestVisibilityScope(
  viewer: ProductRequestViewer | null | undefined,
): ProductRequestVisibilityScope {
  if (!viewer) return { kind: "none" }
  if (canReviewProductRequest(viewer.role)) return { kind: "all" }
  if (!canRaiseProductRequest(viewer.role)) return { kind: "none" }

  const organizationId = positiveInteger(viewer.organizationId)
  return organizationId === null ? { kind: "none" } : { kind: "organization", organizationId }
}

/** May this viewer read this request? The single-row form of the list's scope. */
export function canReadProductRequest(input: {
  viewer: ProductRequestViewer | null | undefined
  request: { organizationId: number } | null | undefined
}): boolean {
  if (!input.request) return false
  const scope = productRequestVisibilityScope(input.viewer)
  if (scope.kind === "all") return true
  if (scope.kind === "organization") return input.request.organizationId === scope.organizationId
  return false
}

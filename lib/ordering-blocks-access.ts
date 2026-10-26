/**
 * Who may open Head Office's Ordering Blocks page
 * (plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md).
 *
 * Kept free of every import so `proxy.ts` can read it at the edge.
 *
 * Head Office only. Super Admin may grant an exception through the same API
 * but has no page here; an organization-wide Viewer is read-only and has
 * nothing to do on it. Who may grant or revoke is
 * `lib/payment-control-access.ts`, on the handlers.
 */
export const ORDERING_BLOCKS_AREA = "/ordering-blocks"

/**
 * The page's list. Its `enabled` is also what decides whether the side menu
 * offers the page.
 */
export const ORDERING_BLOCK_BRANCHES_URL = "/api/v1/payment-control/branches"

export const ORDERING_BLOCKS_PAGE_ROLES = ["HEAD_OFFICE"] as const

export function canUseOrderingBlocksPage(role: unknown): boolean {
  return typeof role === "string" && (ORDERING_BLOCKS_PAGE_ROLES as readonly string[]).includes(role)
}

/**
 * The query string of an Apricart Executive's approval list, parsed and bounded.
 *
 * The filters only ever narrow: the server ANDs them with the executive's
 * reach — Order Desk orders in the organizations assigned to them — so naming
 * an organization outside it returns nothing rather than someone else's orders.
 *
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

/**
 * The tabs, in the order the work happens. A returned order is with the desk
 * until it is resubmitted, so it has a tab of its own rather than sitting among
 * the ones the executive can act on.
 */
export const EXECUTIVE_APPROVAL_TABS = [
  "awaiting_approval",
  "returned",
  "approved",
  "rejected",
  "all",
] as const
export type ExecutiveApprovalTab = (typeof EXECUTIVE_APPROVAL_TABS)[number]

export const EXECUTIVE_APPROVAL_PAGE_SIZE_DEFAULT = 20
export const EXECUTIVE_APPROVAL_PAGE_SIZE_MAX = 50
export const EXECUTIVE_APPROVAL_PAGE_MAX = 10_000
export const EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH = 100

export type ExecutiveApprovalListQuery = {
  tab: ExecutiveApprovalTab
  organizationId: number | null
  /** Matched against the order number and the customer reference. Empty means none. */
  search: string
  page: number
  limit: number
}

export type ExecutiveApprovalListQueryResult =
  | { ok: true; value: ExecutiveApprovalListQuery }
  | { ok: false; error: string }

function boundedInt(raw: string | null, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw))
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.min(value, max)
}

export function parseExecutiveApprovalListQuery(params: URLSearchParams): ExecutiveApprovalListQueryResult {
  const rawOrganization = params.get("organizationId")
  let organizationId: number | null = null
  if (rawOrganization !== null && rawOrganization.trim() !== "") {
    const value = Number(rawOrganization)
    if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, error: "organizationId must be a positive integer" }
    organizationId = value
  }

  const rawTab = (params.get("status") ?? "awaiting_approval").trim().toLowerCase()
  if (!(EXECUTIVE_APPROVAL_TABS as readonly string[]).includes(rawTab)) {
    return { ok: false, error: `status must be one of: ${EXECUTIVE_APPROVAL_TABS.join(", ")}` }
  }

  const search = (params.get("q") ?? "").trim()
  if (search.length > EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH) {
    return { ok: false, error: `q must be at most ${EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH} characters` }
  }

  return {
    ok: true,
    value: {
      tab: rawTab as ExecutiveApprovalTab,
      organizationId,
      search,
      page: boundedInt(params.get("page"), 1, EXECUTIVE_APPROVAL_PAGE_MAX),
      limit: boundedInt(params.get("limit"), EXECUTIVE_APPROVAL_PAGE_SIZE_DEFAULT, EXECUTIVE_APPROVAL_PAGE_SIZE_MAX),
    },
  }
}

/**
 * What each tab selects.
 *
 *   * `pending`  — the order is `PENDING`.
 *   * `returned` — whether it is with the desk for correction (`null`: either).
 *   * `decided`  — `APPROVED`: it was approved, whatever happened after
 *     (delivered, fulfilled, refunded, cancelled after approval); `REJECTED`:
 *     it was rejected.
 */
export type ExecutiveApprovalSelection =
  | { kind: "pending"; returned: boolean }
  | { kind: "approved" }
  | { kind: "rejected" }
  | { kind: "all" }

export function executiveApprovalSelection(tab: ExecutiveApprovalTab): ExecutiveApprovalSelection {
  if (tab === "awaiting_approval") return { kind: "pending", returned: false }
  if (tab === "returned") return { kind: "pending", returned: true }
  if (tab === "approved") return { kind: "approved" }
  if (tab === "rejected") return { kind: "rejected" }
  return { kind: "all" }
}

/** How many orders each tab holds, shown on the tab. */
export type ExecutiveApprovalCounts = Record<ExecutiveApprovalTab, number>

/** What the executive may do with one order now. The server enforces each again. */
export type ExecutiveApprovalActions = {
  canApprove: boolean
  canReject: boolean
  canReturn: boolean
}

export function executiveApprovalActions(order: {
  status: string | null
  returnedForCorrectionAt: Date | string | null
}): ExecutiveApprovalActions {
  const pending = String(order.status ?? "").trim().toUpperCase() === "PENDING"
  const returned = order.returnedForCorrectionAt !== null && order.returnedForCorrectionAt !== ""
  return {
    // A returned order is approved only once the desk resubmits it; it may
    // still be rejected outright, as on the tenant path.
    canApprove: pending && !returned,
    canReject: pending,
    canReturn: pending && !returned,
  }
}

/**
 * A branch's head count — how many people work there — and the request a branch
 * raises to change it. Every rule that does not need a database.
 *
 * Super Admin and Head Office set the figure directly on the branch. A Branch
 * Admin or Group User asks for a figure, and it reaches the branch only when
 * Head Office approves. See plans/OF-BRANCH-head-count.md.
 *
 * Nothing here imports a database or a session, so the forms, the queue and
 * the endpoints hold the same bounds and cannot disagree about them.
 */

/**
 * The largest head count accepted. A bound, not a business rule: it keeps the
 * value well inside a Postgres `integer` and refuses an obvious typo. Pinned by
 * `branches_head_count_ck` and `branch_head_count_requests_count_ck`.
 */
export const MAX_BRANCH_HEAD_COUNT = 1_000_000

/** A request's lifecycle. Pinned by `branch_head_count_requests_status_ck`. */
export const HEAD_COUNT_REQUEST_STATUSES = ["pending", "approved", "rejected"] as const

export type HeadCountRequestStatus = (typeof HEAD_COUNT_REQUEST_STATUSES)[number]

export function isHeadCountRequestStatus(value: unknown): value is HeadCountRequestStatus {
  return typeof value === "string"
    && (HEAD_COUNT_REQUEST_STATUSES as readonly string[]).includes(value)
}

/** What Head Office may do with a pending request. */
export const HEAD_COUNT_REQUEST_DECISIONS = ["approve", "reject"] as const

export type HeadCountRequestDecision = (typeof HEAD_COUNT_REQUEST_DECISIONS)[number]

/** The status a decision produces. The only mapping between the two vocabularies. */
export function statusForHeadCountDecision(decision: HeadCountRequestDecision): HeadCountRequestStatus {
  return decision === "approve" ? "approved" : "rejected"
}

export const MAX_HEAD_COUNT_REQUEST_REASON = 2_000

/** A bounded page, so the list endpoint cannot be asked for a whole tenant at once. */
export const MAX_HEAD_COUNT_REQUEST_PAGE = 200

export function isValidBranchHeadCount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_BRANCH_HEAD_COUNT
}

/**
 * What a form's head-count field holds, as the value the API takes.
 *
 * Blank is `null` ("not provided"), which is a legitimate value: every branch
 * created before this field existed holds it. Anything that is not a whole
 * number inside the bounds is `undefined`, so a form can refuse to submit it
 * rather than send something the server will reject.
 */
export function parseHeadCountInput(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (trimmed === "") return null
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return isValidBranchHeadCount(value) ? value : undefined
}

/** How a head count reads on a screen. */
export function formatBranchHeadCount(value: number | null | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "Not set"
}

/**
 * Blocking new orders on unacknowledged deliveries
 * (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md).
 *
 * Pure. What counts as an unacknowledged delivery, the decision, the wording,
 * the error the order gate throws, and how a refusal is recognised on the
 * client. The count itself is taken in
 * lib/server/unacknowledged-delivery-block.ts with the dashboard's own SQL
 * predicate, so the popup and the dashboard's "Delivered/Unacknowledged"
 * figure cannot disagree.
 *
 * Deliberately separate from payment control: a different condition, a
 * different remedy, and no Head Office exception — the branch clears it
 * itself by acknowledging (handing the fulfilment token over), which settles
 * a delivered order to FULFILLED.
 */
import { matchesViewerStatusBucket, type OrderDeliverySource } from "@/lib/order-delivery-status"

/** Delivered-but-unacknowledged orders at which new ordering stops. */
export const UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD = 2

export const UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE = "UNACKNOWLEDGED_DELIVERIES_BLOCKED" as const

export const UNACKNOWLEDGED_DELIVERIES_DIALOG_TITLE = "Delivered orders awaiting acknowledgement"

/** `audit_logs.action` for a Super Admin switching the toggle on or off. */
export const UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION = "UPDATE_UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK"

/**
 * An order whose goods have arrived but which the branch has not yet
 * acknowledged: still APPROVED, delivery status DELIVERED. The same rule as
 * the dashboard's DELIVERED_UNACKNOWLEDGED bucket, by construction.
 */
export function isUnacknowledgedDelivery(order: OrderDeliverySource): boolean {
  return matchesViewerStatusBucket("DELIVERED_UNACKNOWLEDGED", order)
}

/** What the gate, the pre-check route and the popup all read. */
export type DeliveryAcknowledgementStatus = {
  /** The organization's toggle. Off means nothing is counted or blocked. */
  enabled: boolean
  orderingAllowed: boolean
  unacknowledgedCount: number
  threshold: number
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export function resolveDeliveryAcknowledgement({
  enabled,
  unacknowledgedCount,
}: {
  enabled: boolean
  unacknowledgedCount: number
}): DeliveryAcknowledgementStatus {
  const threshold = UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD
  if (!enabled) return { enabled: false, orderingAllowed: true, unacknowledgedCount: 0, threshold }
  const count = isCount(unacknowledgedCount) ? unacknowledgedCount : 0
  return { enabled: true, orderingAllowed: count < threshold, unacknowledgedCount: count, threshold }
}

export function unacknowledgedDeliveryCountLabel(count: number): string {
  return `${count} delivered order${count === 1 ? "" : "s"} awaiting acknowledgement`
}

/** The sentence the ordering user is shown when an order is refused. */
export function unacknowledgedDeliveriesMessage(count: number): string {
  return `Your branch has ${unacknowledgedDeliveryCountLabel(count)}. `
    + "Please acknowledge/fulfil your delivered orders to place a new order."
}

/** The part of a refusal that is safe to hand back: no amounts, no order references. */
export type DeliveryAcknowledgementBlockedDetails = {
  code: typeof UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE
  unacknowledgedCount: number
  threshold: number
}

/**
 * Thrown by the order gate. The routes map it to a stable refusal — a 409 on
 * the single-branch path, a tagged per-branch failure on the group path —
 * never to a 500.
 */
export class DeliveryAcknowledgementBlockedError extends Error {
  readonly code = UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE
  readonly details: DeliveryAcknowledgementBlockedDetails

  constructor(status: Pick<DeliveryAcknowledgementStatus, "unacknowledgedCount" | "threshold">) {
    super(unacknowledgedDeliveriesMessage(status.unacknowledgedCount))
    this.name = "DeliveryAcknowledgementBlockedError"
    this.details = {
      code: UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE,
      unacknowledgedCount: status.unacknowledgedCount,
      threshold: status.threshold,
    }
  }
}

export function isDeliveryAcknowledgementBlockedError(error: unknown): error is DeliveryAcknowledgementBlockedError {
  return error instanceof DeliveryAcknowledgementBlockedError
    || (typeof error === "object" && error !== null
      && (error as { code?: unknown }).code === UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE
      && typeof (error as { message?: unknown }).message === "string"
      && typeof (error as { details?: unknown }).details === "object"
      && (error as { details?: unknown }).details !== null)
}

/** What the popup shows: one sentence, and the locations when there are several. */
export type BranchAwaitingAcknowledgement = {
  branchId: number
  branchName: string
  unacknowledgedCount: number
}

export type UnacknowledgedDeliveriesNotice = {
  message: string
  branches: BranchAwaitingAcknowledgement[]
}

/**
 * The refusal from `POST /api/v1/orders`: a 409 carrying this code. Anything
 * else — another 409, a malformed body — is not this block and is left to the
 * caller's ordinary error handling.
 */
export function parseUnacknowledgedDeliveriesResponse(httpStatus: number, body: unknown): UnacknowledgedDeliveriesNotice | null {
  if (httpStatus !== 409 || !body || typeof body !== "object") return null
  const candidate = body as { code?: unknown; error?: unknown; deliveryAcknowledgement?: unknown }
  if (candidate.code !== UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE) return null
  const details = candidate.deliveryAcknowledgement as { unacknowledgedCount?: unknown } | null | undefined
  if (!details || typeof details !== "object" || !isCount(details.unacknowledgedCount)) return null
  const message = typeof candidate.error === "string" && candidate.error.trim()
    ? candidate.error
    : unacknowledgedDeliveriesMessage(details.unacknowledgedCount)
  return { message, branches: [] }
}

/**
 * The same block read ahead of submission from
 * `GET /api/v1/orders/delivery-acknowledgement`. Null means "nothing to
 * show" — including a malformed view, since the server refuses the order
 * anyway if the branch is blocked.
 */
export function noticeFromDeliveryAcknowledgementView(view: unknown): UnacknowledgedDeliveriesNotice | null {
  if (!view || typeof view !== "object") return null
  const candidate = view as { orderingAllowed?: unknown; unacknowledgedCount?: unknown }
  if (candidate.orderingAllowed !== false || !isCount(candidate.unacknowledgedCount)) return null
  return { message: unacknowledgedDeliveriesMessage(candidate.unacknowledgedCount), branches: [] }
}

type GroupBranchResultLike = {
  status?: unknown
  branchId?: unknown
  branchName?: unknown
  code?: unknown
  unacknowledgedDeliveryCount?: unknown
}

/**
 * The popup for a group submission: the locations it skipped because of
 * unacknowledged deliveries. A group order commits per branch, so the others
 * may have gone through. Null when none was skipped for this reason.
 */
export function noticeForGroupResults(results: readonly GroupBranchResultLike[] | null | undefined): UnacknowledgedDeliveriesNotice | null {
  if (!Array.isArray(results)) return null
  const branches = results.flatMap((result): BranchAwaitingAcknowledgement[] => {
    if (result?.status !== "failed" || result.code !== UNACKNOWLEDGED_DELIVERIES_BLOCKED_CODE) return []
    if (typeof result.branchId !== "number" || typeof result.branchName !== "string") return []
    if (!isCount(result.unacknowledgedDeliveryCount)) return []
    return [{ branchId: result.branchId, branchName: result.branchName, unacknowledgedCount: result.unacknowledgedDeliveryCount }]
  })
  if (branches.length === 0) return null
  return {
    message: "No order was placed for the locations below because they have delivered orders awaiting acknowledgement. "
      + "Please acknowledge/fulfil those delivered orders to order for them again.",
    branches,
  }
}

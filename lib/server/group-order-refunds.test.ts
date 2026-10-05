import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import {
  MAX_GROUP_REFUND_REASON_LENGTH,
  MAX_ITEMS_PER_REFUNDED_ORDER,
  MAX_ORDERS_PER_GROUP_REFUND,
  OUT_OF_SCOPE_REASON,
  getRequesterRefundBlockReason,
  isWithinRefundMonth,
  remainingRefundableCents,
  remainingRefundableQuantity,
} from "@/lib/server/group-refund-rules"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

// The window is the order's budget period (the UTC month), the rule the
// single-order refund endpoint applies. These mid-month dates fall in the same
// month in every timezone; the month-boundary cases below use UTC instants.
const NOW = new Date(2026, 7, 21, 10, 0, 0)
const THIS_MONTH = new Date(2026, 7, 3, 9, 0, 0)
const LAST_MONTH = new Date(2026, 6, 15, 9, 0, 0)

const deliveredThisMonth = {
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  createdAt: THIS_MONTH,
  remainingRefundableCents: 50_000,
  now: NOW,
}

/**
 * The group refund flow is a second write path into the `refunds` table, so the
 * contract that matters is that it cannot become a weaker one. These pin the
 * requester's eligibility rules, the scoping of every read and write, and the
 * fact that this role can only ever *ask* for a refund.
 */
describe("requester refund eligibility", () => {
  it("allows a delivered order inside its own calendar month", () => {
    expect(getRequesterRefundBlockReason(deliveredThisMonth)).toBeNull()
  })

  it("refuses an order that has not been delivered yet", () => {
    expect(getRequesterRefundBlockReason({
      ...deliveredThisMonth,
      status: "APPROVED",
      fulfillmentStatus: "OUT_FOR_DELIVERY",
    })).toContain("fulfilled and delivered")

    expect(getRequesterRefundBlockReason({
      ...deliveredThisMonth,
      status: "FULFILLED",
      fulfillmentStatus: "IN_PROCESS",
    })).toContain("fulfilled and delivered")
  })

  it("refuses a pending order, matching the single-branch requester rule", () => {
    expect(getRequesterRefundBlockReason({
      ...deliveredThisMonth,
      status: "PENDING",
      fulfillmentStatus: "NOT_STARTED",
    })).toContain("fulfilled and delivered")
  })

  it("refuses a rejected order outright", () => {
    expect(getRequesterRefundBlockReason({ ...deliveredThisMonth, status: "REJECTED" }))
      .toContain("rejected")
  })

  it("refuses an order that is already fully refunded, by status or by capacity", () => {
    expect(getRequesterRefundBlockReason({ ...deliveredThisMonth, status: "REFUNDED" }))
      .toContain("already been fully refunded")
    expect(getRequesterRefundBlockReason({ ...deliveredThisMonth, remainingRefundableCents: 0 }))
      .toContain("already been fully refunded")
  })

  it("closes the window once the order's calendar month has passed", () => {
    expect(getRequesterRefundBlockReason({
      ...deliveredThisMonth,
      createdAt: LAST_MONTH,
    })).toContain("refund period has ended")
  })

  it("treats a missing or unparseable order date as outside the window", () => {
    expect(isWithinRefundMonth(null, NOW)).toBe(false)
    expect(isWithinRefundMonth("not-a-date", NOW)).toBe(false)
    expect(isWithinRefundMonth(THIS_MONTH.toISOString(), NOW)).toBe(true)
    expect(isWithinRefundMonth(LAST_MONTH.toISOString(), NOW)).toBe(false)
    // Same month a year earlier is still outside the window.
    expect(isWithinRefundMonth(new Date(2025, 7, 3), NOW)).toBe(false)
  })

  it("follows the UTC month at a boundary, whatever the local zone says", () => {
    // 1 Oct 02:00 in Karachi is still 30 Sep in UTC: a September order is
    // still refundable, exactly as the single-order endpoint decides.
    const earlyFirstInKarachi = new Date("2026-09-30T21:00:00.000Z")
    expect(isWithinRefundMonth(new Date("2026-09-10T08:00:00.000Z"), earlyFirstInKarachi)).toBe(true)
    // An order placed then belongs to September, so October's window excludes it.
    expect(isWithinRefundMonth(earlyFirstInKarachi, new Date("2026-10-01T06:00:00.000Z"))).toBe(false)
    expect(isWithinRefundMonth(new Date("2026-09-30T23:59:59.999Z"), new Date("2026-10-01T00:00:00.000Z"))).toBe(false)
  })
})

describe("refund capacity arithmetic", () => {
  it("subtracts both settled and pending quantity from what was ordered", () => {
    expect(remainingRefundableQuantity({
      quantityOrdered: 10,
      quantityApproved: 3,
      quantityPending: 2,
    })).toBe(5)
  })

  it("never reports a negative remainder for an over-refunded line", () => {
    expect(remainingRefundableQuantity({
      quantityOrdered: 10,
      quantityApproved: 12,
      quantityPending: 0,
    })).toBe(0)
  })

  it("uses the larger of the itemised refunds and the total stamped on the order", () => {
    // A legacy refund recorded on the order but never itemised must still
    // consume capacity, or it could be refunded a second time.
    expect(remainingRefundableCents({
      orderTotalCents: 100_000,
      approvedRefundCents: 0,
      pendingRefundCents: 0,
      orderRefundAmountCents: 40_000,
    })).toBe(60_000)

    expect(remainingRefundableCents({
      orderTotalCents: 100_000,
      approvedRefundCents: 70_000,
      pendingRefundCents: 10_000,
      orderRefundAmountCents: 40_000,
    })).toBe(20_000)
  })

  it("never reports negative remaining money", () => {
    expect(remainingRefundableCents({
      orderTotalCents: 100_000,
      approvedRefundCents: 90_000,
      pendingRefundCents: 30_000,
      orderRefundAmountCents: 0,
    })).toBe(0)
  })
})

describe("group refund scoping", () => {
  const refunds = source("lib/server/group-order-refunds.ts")

  it("pins the envelope read to the caller's own group order and tenant", () => {
    expect(refunds).toContain("eq(groupOrders.createdByUserId, scope.userId)")
    expect(refunds).toContain("eq(groupOrders.organizationId, scope.organizationId)")
  })

  it("re-asserts creator and tenant on the branch orders beneath the envelope", () => {
    expect(refunds).toContain("eq(orders.groupOrderId, groupOrderId)")
    expect(refunds).toContain("eq(orders.organizationId, scope.organizationId)")
    expect(refunds).toContain("eq(orders.createdByUserId, scope.userId)")
  })

  it("checks the live branch assignments before anything else about an order", () => {
    expect(refunds).toContain("if (!scopedBranchIds.has(child.branchId)) return OUT_OF_SCOPE_REASON")
    expect(refunds).toContain("resolveScopedBranchIds(db, userId)")
    expect(OUT_OF_SCOPE_REASON).toContain("no longer in your assigned scope")
  })

  it("pins the refund history to the requester on every joined table", () => {
    expect(refunds).toContain("eq(refunds.requestedByUserId, userId)")
    expect(refunds).toContain("eq(refunds.organizationId, organizationId)")
    expect(refunds).toContain("eq(orders.createdByUserId, userId)")
    expect(refunds).toContain("eq(groupOrders.createdByUserId, userId)")
  })
})

describe("group refunds can only ever request", () => {
  const refunds = source("lib/server/group-order-refunds.ts")

  it("writes refunds as PENDING and never as approved or completed", () => {
    expect(refunds).toContain("status: PENDING_STATUS")
    expect(refunds).not.toContain('status: "APPROVED"')
    expect(refunds).not.toContain('status: "COMPLETED"')
  })

  it("records the caller as the requester, never as the processor", () => {
    expect(refunds).toContain("requestedByUserId: scope.userId")
    expect(refunds).not.toContain("processedByUserId")
  })

  it("moves no money and no order status: budgets and orders are never updated", () => {
    // Approving a refund is what releases budget and moves the order; that
    // belongs to the Super Admin routes and must not be reachable from here.
    expect(refunds).not.toContain("releaseRefundedQuantityBudget")
    expect(refunds).not.toContain("update(budgets)")
    expect(refunds).not.toContain("update(orders)")
    expect(refunds).not.toContain("refundedByUserId")
  })

  it("re-validates inside the write transaction, not only during the read", () => {
    expect(refunds).toContain('.for("update")')
    expect(refunds).toContain("await assertStillRefundable(tx, entry, context.now)")
    expect(refunds).toContain("await assertLineQuantitiesStillAvailable(tx, prepared)")
  })

  it("re-prices every line from the database rather than from the payload", () => {
    expect(refunds).toContain("calculateLineCents(line.priceCents, validation.quantity)")
    expect(refunds).toContain("validateProductQuantity(item.quantity, {")
    // Compared on the scale quantities are stored at, so binary-float drift in
    // the remaining-quantity subtraction cannot refuse the exact amount the
    // workspace offered the user.
    expect(refunds).toContain("if (roundQuantity(validation.quantity) > line.quantityRemaining)")
  })

  it("never returns a raw failure message to the caller", () => {
    expect(refunds).toContain("writeError.message === CONFLICT_MESSAGE")
    expect(refunds).toContain('"This refund request could not be recorded. Please try again."')
  })
})

describe("group refund endpoints", () => {
  const collection = source("app/api/v1/group-portal/refunds/route.ts")
  const workspace = source("app/api/v1/group-portal/refunds/[groupOrderId]/route.ts")

  it("gates both routes behind the requester role alone", () => {
    expect(collection).toContain("await requireGroupOrderPortal()")
    expect(workspace).toContain("await requireGroupOrderPortal()")
    // The approver's gate is a different function and must not appear here.
    expect(collection).not.toContain("requireGroupApprover")
    expect(workspace).not.toContain("requireGroupApprover")
  })

  it("takes the tenant and user from the resolved scope, never from the request", () => {
    expect(collection).toContain("userId: actor.scope.userId")
    expect(collection).toContain("organizationId: actor.organizationId")
    expect(workspace).toContain("userId: actor.scope.userId")
    expect(workspace).toContain("organizationId: actor.organizationId")
  })

  it("rate limits the write on the refund bucket and validates the body", () => {
    expect(collection).toContain('withRateLimit("refund", actor.scope.userId)')
    expect(collection).toContain("groupRefundRequestSchema.safeParse(await readJson(req))")
  })

  it("answers with 404 rather than 403 for a group order that is not the caller's", () => {
    expect(workspace).toContain('return error("Group order not found", 404)')
  })
})

describe("group refund request payload bounds", () => {
  it("caps the submission at values the write path can actually service", () => {
    expect(MAX_ORDERS_PER_GROUP_REFUND).toBe(100)
    expect(MAX_ITEMS_PER_REFUNDED_ORDER).toBe(200)
  })

  it("caps the reason at the width of the column it is stored in", () => {
    // refunds.reason is varchar(255); a longer note must be refused with a
    // message rather than fail at the database.
    expect(MAX_GROUP_REFUND_REASON_LENGTH).toBe(255)
  })

  it("refuses duplicate orders and duplicate lines in one request", () => {
    const validation = source("lib/server/mutation-validation.ts")
    expect(validation).toContain("Each branch order can only appear once in a refund request")
    expect(validation).toContain("Each order item can only appear once in a refund")
  })
})

describe("fulfilment token for the group requester", () => {
  const approvedOwnOrder = {
    role: "GROUP_ORDER_PORTAL",
    userId: "requester-id",
    orderStatus: "APPROVED",
    orderCreatedByUserId: "requester-id",
  }

  it("shows the requester a token for an approved order in its scoped response", () => {
    expect(canViewFulfillmentToken(approvedOwnOrder)).toBe(true)
  })

  it("hides it before approval but leaves identity scoping to the caller", () => {
    expect(canViewFulfillmentToken({ ...approvedOwnOrder, orderStatus: "PENDING" })).toBe(false)
    expect(canViewFulfillmentToken({ ...approvedOwnOrder, userId: "someone-else" })).toBe(true)
  })

  it("ignores the tenant's configured approver role for the requester tier", () => {
    // Fulfillment authority is independent from approval authority.
    expect(canViewFulfillmentToken({ ...approvedOwnOrder, configuredApproverRole: "HEAD_OFFICE" })).toBe(true)
    expect(canViewFulfillmentToken({ ...approvedOwnOrder, configuredApproverRole: "BRANCH_ADMIN" })).toBe(true)
  })

  it("allows every operational role and still rejects an unknown role", () => {
    const order = {
      orderStatus: "APPROVED",
      orderCreatedByUserId: "creator-id",
      orderApprovedByUserId: "approver-id",
    }
    expect(canViewFulfillmentToken({ ...order, role: "SUPER_ADMIN", userId: "a" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "BRANCH_ADMIN", userId: "b" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "GROUP_USER", userId: "c" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "ORDER_PORTAL", userId: "creator-id" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "HEAD_OFFICE", userId: "head" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "GROUP_ORDER_PORTAL", userId: "group" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "ORDER_PORTAL", userId: "other" })).toBe(true)
    expect(canViewFulfillmentToken({ ...order, role: "UNKNOWN_ROLE", userId: "creator-id" })).toBe(false)
  })

  it("collects group tokens through the same policy and the same branch scope", () => {
    const tokens = source("lib/server/group-order-tokens.ts")

    // Ownership, tenant, live assignments, and the shared policy — the bulk
    // hand-off must clear every gate the per-order route clears.
    expect(tokens).toContain("eq(groupOrders.createdByUserId, userId)")
    expect(tokens).toContain("eq(groupOrders.organizationId, organizationId)")
    expect(tokens).toContain("eq(orders.createdByUserId, userId)")
    expect(tokens).toContain("eq(orders.organizationId, organizationId)")
    expect(tokens).toContain("if (!scopedBranchIds.has(child.branchId)) return false")
    expect(tokens).toContain("if (child.branchOrganizationId !== organizationId) return false")
    expect(tokens).toContain("return canViewFulfillmentToken({")
    expect(tokens).toContain("role: GROUP_ORDER_PORTAL_ROLE,")
  })

  it("sends the bulk hand-off only to the configured mailbox, rate limited", () => {
    const route = source("app/api/v1/group-portal/orders/[groupOrderId]/tokens/route.ts")

    expect(route).toContain("await requireGroupOrderPortal()")
    expect(route).toContain('withRateLimit("email", actor.scope.userId)')
    // The recipient is configuration, never a request field.
    expect(route).toContain("to: ADMIN_OPERATIONS_EMAIL,")
    expect(route).not.toContain("searchParams.get")
    expect(route).toContain('return error("Group order not found", 404)')
    // The hand-off leaves the same per-order audit trail a single send does.
    expect(route).toContain("await recordGroupTokenHandoff({")
  })

  it("gates the token in the group order history through that one policy", () => {
    const history = source("lib/server/group-order-history.ts")
    expect(history).toContain("approvalToken: canViewFulfillmentToken({")
    expect(history).toContain("role: GROUP_ORDER_PORTAL_ROLE,")
    expect(history).toContain("orderCreatedByUserId: row.createdByUserId,")
    expect(history).toContain("eq(orders.createdByUserId, userId)")
  })
})

describe("group refund quantity arithmetic", () => {
  const rules = source("lib/server/group-refund-rules.ts")
  const refunds = source("lib/server/group-order-refunds.ts")

  it("rounds the remaining quantity onto the scale it is stored at", () => {
    // Ordered 0.3 with two 0.1 refunds taken left 0.09999999999999998, which
    // displayed as "0.1" and then refused a request for 0.1.
    expect(rules).toContain("roundQuantity(roundQuantity(quantityOrdered)")
    expect(remainingRefundableQuantity({
      quantityOrdered: 0.3,
      quantityApproved: 0.1,
      quantityPending: 0.1,
    })).toBe(0.1)
  })

  it("still reports nothing left rather than a negative remainder", () => {
    expect(remainingRefundableQuantity({
      quantityOrdered: 1,
      quantityApproved: 2,
      quantityPending: 0,
    })).toBe(0)
  })

  it("re-checks the locked rows on the same rounded scale", () => {
    expect(refunds).toContain("const stillAvailable = remainingRefundableQuantity({")
    expect(refunds).toContain("if (roundQuantity(line.quantity) > stillAvailable)")
  })
})

describe("group refund history paging", () => {
  const refunds = source("lib/server/group-order-refunds.ts")

  it("pages over group orders in the database, not over a capped row scan", () => {
    // Paging a capped scan made the totals and the page count describe only the
    // rows that fitted under the cap, so a long refund history reported itself
    // as shorter than it is.
    expect(refunds).toContain("loadRefundHistoryEnvelopeIds")
    expect(refunds).toContain("COUNT(DISTINCT ${groupOrders.id})::int")
    expect(refunds).toContain(".groupBy(groupOrders.id)")
    expect(refunds).not.toContain("GROUP_REFUND_HISTORY_ROW_CAP")
  })

  it("re-asserts the caller's own scope on the row read, not just the id list", () => {
    expect(refunds).toContain("and(refundHistoryScope(scope), inArray(groupOrders.id, envelopeIds))")
    expect(refunds).toContain("eq(refunds.requestedByUserId, userId)")
    expect(refunds).toContain("eq(groupOrders.createdByUserId, userId)")
    expect(refunds).toContain("eq(groupOrders.organizationId, organizationId)")
  })
})

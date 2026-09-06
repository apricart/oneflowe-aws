import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const ordersList = () => source("app/api/v1/orders/route.ts")

/** The role-scoping ladder, isolated from the rest of the list endpoint. */
function orderRoleConditions(): string {
  const orders = ordersList()
  return orders.slice(
    orders.indexOf("function addOrderRoleConditions"),
    orders.indexOf("function addOrderDimensionConditions"),
  )
}

/**
 * A Group Order Portal submission is recorded as one ordinary `orders` row per
 * branch. Everything below exists to keep that true: the branch's own roles must
 * keep reading those rows through the scoping they already have, and no role may
 * gain a write it did not have.
 */
describe("group orders reach the branch's own roles", () => {
  it("never excludes a group order from any list", () => {
    // A single `groupOrderId IS NULL` predicate anywhere would hide these orders
    // from Head Office, Branch Admin, and every report at once.
    for (const path of [
      "app/api/v1/orders/route.ts",
      "app/api/v1/orders/[id]/route.ts",
      "app/api/v1/analytics/summary/route.ts",
    ]) {
      expect(source(path)).not.toContain("isNull(orders.groupOrderId)")
      expect(source(path)).not.toContain("group_order_id IS NULL")
    }
  })

  it("scopes Head Office to the tenant with no creator predicate", () => {
    const conditions = orderRoleConditions()
    // Head Office returns straight after the organization pin, so every order in
    // the tenant — group order or not — is in scope.
    const headOfficeReturn = conditions.indexOf('if (role === "HEAD_OFFICE") return')
    const creatorPredicate = conditions.indexOf("eq(orders.createdByUserId, currentUserId)")
    expect(headOfficeReturn).toBeGreaterThan(-1)
    expect(creatorPredicate).toBeGreaterThan(headOfficeReturn)
  })

  it("scopes Branch Admin to its branch with no creator predicate", () => {
    const conditions = orderRoleConditions()
    // The creator predicate is reached only for ORDER_PORTAL; the branch pin
    // below it is what Branch Admin lands on.
    expect(conditions).toContain('if (role === "ORDER_PORTAL" && currentUserId) {')
    expect(conditions).toContain("eq(orders.branchId, branchIdFromUser)")
  })

  it("lets a requester read the group orders raised for its branch", () => {
    const conditions = orderRoleConditions()
    expect(conditions).toContain("eq(orders.createdByUserId, currentUserId),")
    expect(conditions).toContain("isNotNull(orders.groupOrderId),")
    // The branch and tenant pins still apply to both halves of that `or`.
    expect(conditions).toContain("eq(orders.organizationId, orgIdNum)")
    expect(conditions).toContain("eq(orders.branchId, branchIdFromUser)")
  })

  it("keeps the fail-closed ladder intact", () => {
    const conditions = orderRoleConditions()
    expect(ordersList()).toContain("const DENY_ALL_ORDERS = sql`false`")
    expect(conditions.match(/DENY_ALL_ORDERS/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("applies the same widening to the single-order read", () => {
    const detail = source("app/api/v1/orders/[id]/route.ts")
    expect(detail).toContain("or(eq(orders.createdByUserId, currentUserId), isNotNull(orders.groupOrderId))")
    expect(detail).toContain("canOrderPortalReadOrder({ viewerUserId: currentUserId, order: item })")
  })

  it("exposes the origin as a derived flag, never the envelope id", () => {
    const list = ordersList()
    expect(list).toContain("placedByGroupPortal: isGroupPortalOrder(item)")
    expect(list).toContain("groupOrderId: _groupOrderId, ...publicItem } = item")
    const detail = source("app/api/v1/orders/[id]/route.ts")
    expect(detail).toContain("placedByGroupPortal: isGroupPortalOrder(item)")
    expect(detail).toContain("groupOrderId: _groupOrderId,")
  })
})

/**
 * Reading a group order is not the same as acting on one. Every write stays with
 * the person who raised the order; these are the controls that keep it there.
 */
describe("reading a group order grants no write", () => {
  it("keeps order edits with the creator", () => {
    const policy = source("lib/order-edit-policy.ts")
    expect(policy).toContain("input.actorUserId === input.orderCreatedByUserId")
    expect(policy).not.toContain("groupOrderId")

    // The edit lock re-asserts the creator inside the transaction too.
    expect(source("app/api/v1/orders/[id]/route.ts"))
      .toContain("eq(orders.createdByUserId, user.id)")
  })

  it("keeps refund requests with the creator", () => {
    const refunds = source("app/api/v1/orders/[id]/refunds/route.ts")
    expect(refunds).toContain("orderData.createdByUserId === userId")
    expect(refunds).not.toContain("groupOrderId")
  })

  it("keeps the fulfilment token with the creator", () => {
    const token = source("lib/fulfillment-token-access.ts")
    expect(token).toContain("orderCreatedByUserId === userId")
    expect(token).not.toContain("groupOrderId")
  })

  it("keeps the token email with the creator", () => {
    expect(source("app/api/v1/orders/[id]/send-token-email/route.ts"))
      .not.toContain("groupOrderId")
  })

  it("offers no control the server would refuse", () => {
    // A requester sees a group order but cannot edit or refund it, so the store
    // hides both controls rather than failing the request afterwards.
    const shop = source("app/shop/page.tsx")
    expect(shop).toContain('order.status?.toUpperCase() === "PENDING" && !order.placedByGroupPortal')
    expect(shop).toContain("!(isOrderPortal && selectedOrder.placedByGroupPortal)")
  })
})

/**
 * An order raised through the group portal still needs an approver, and the
 * approver still needs to be told about it.
 */
describe("group orders notify the branch's approver", () => {
  it("accepts either requester role as the creator of a new order", () => {
    const notifications = source("lib/server/order-notifications.ts")
    expect(notifications).toContain("inArray(roles.name, [...ORDER_CREATOR_ROLES])")
    // The branch assertion is not dropped, only resolved differently for the
    // role that has no pinned branch.
    expect(notifications).toContain("creatorReachesOrderBranch")
    expect(notifications).toContain("resolveScopedBranchIds(tx, creator.id)")
    expect(notifications).toContain("return creator.branchId === branchId")
  })

  it("still addresses the tenant's configured approver for the order's branch", () => {
    const notifications = source("lib/server/order-notifications.ts")
    expect(notifications).toContain("eq(roles.name, approverRole)")
    expect(notifications).toContain(
      'approverRole === "BRANCH_ADMIN" ? eq(users.branchId, order.branchId) : undefined',
    )
  })

  it("queues the event inside the branch's own transaction", () => {
    const creation = source("lib/server/group-order-creation.ts")
    expect(creation).toContain("await queueOrderCreatedNotifications(tx, {")
    // A notification problem must never discard an order that was created.
    expect(creation).toContain("Group order approval notification could not be queued")
    expect(creation).toContain("await attemptImmediateOrderEmailDelivery(notificationEventKeys)")
  })
})

/** User-attribution reports have to count the group requester as an ordering user. */
describe("reports attribute group orders to the person who raised them", () => {
  it("counts both requester roles in user performance", () => {
    const performance = source("app/api/v1/analytics/users/performance/route.ts")
    expect(performance).toContain("inArray(roles.name, [...ORDER_CREATOR_ROLES])")
    expect(performance).not.toContain('eq(roles.name, "ORDER_PORTAL")')
  })

  it("offers both requester roles in the user filter list", () => {
    const list = source("app/api/v1/analytics/users/list/route.ts")
    expect(list).toContain("inArray(roles.name, [...ORDER_CREATOR_ROLES])")
    expect(list).not.toContain('eq(roles.name, "ORDER_PORTAL")')
    // A multi-branch requester has no `users.branch_id`, so the branch filter
    // has to reach it through its assignments or it disappears from the list.
    expect(list).toContain("resolveUsersScopedToBranches(db, branchIds)")
  })

  it("lets every administrator identify the submission a row came from", () => {
    const report = source("app/(portal)/reports/order-report/page.tsx")
    expect(report).toContain(
      '["GROUP_USER", "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"].includes(role)',
    )
    // The reference lookup stays pinned to the caller's own organizations.
    expect(source("app/api/v1/analytics/summary/route.ts"))
      .toContain("inArray(groupOrders.organizationId, scopedOrganizationIds)")
  })
})

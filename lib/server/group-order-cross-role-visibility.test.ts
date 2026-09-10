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
 * keep reading those rows through the scoping they already have, and every write
 * must stay inside the branch that owns the order.
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
 * The branch owns its orders.
 *
 * Writes were once pinned to whoever raised the order. They are now pinned to
 * the **branch**: either requester role may edit or refund an order at a branch
 * it is assigned to, whoever raised it, because that branch received the goods
 * and its budget paid for them. `plans/OF-GROUP-branch-owns-order-writes.md`
 * records the decision.
 *
 * That makes the branch predicate the whole of the control, so these assert it
 * is present and mandatory on every write path — and that the two things which
 * deliberately did **not** widen have not drifted along with it.
 */
describe("the branch owns its orders", () => {
  it("states the rule once, in a module with no database", () => {
    const policy = source("lib/order-write-access.ts")
    // An assignment set, not a creator comparison.
    expect(policy).toContain("branchIds.includes(order.branchId)")
    expect(policy).not.toContain("=== order.createdByUserId")
    // The failure that would matter most: no assignment must mean no access,
    // never "every branch in the tenant".
    expect(policy).toContain("if (branchIds.length === 0) return false")
    // Tenant equality is asserted in both directions.
    expect(policy).toContain("actor.organizationId !== order.organizationId")
    expect(policy).toContain("order.branchOrganizationId !== order.organizationId")
  })

  it("authorizes an edit against the actor's branches, resolved server-side", () => {
    const route = source("app/api/v1/orders/[id]/route.ts")
    expect(route).toContain("canRequesterActOnOrder")
    expect(route).toContain("canRequesterEditOrder")
    // The branch set never comes from the request body or query, and the copy
    // the decision is made on is re-resolved on the transaction handle so a
    // revoked assignment cannot be used mid-request.
    expect(route).toContain("resolveWritableBranchIds(user.role, user.id, scope)")
    expect(route).toContain("if (allowedBranchIds.length === 0) return error(\"Forbidden\", 403)")
    expect(route).toContain("? await resolveScopedBranchIds(tx, actor.id)")
    expect(route).toContain("if (allowedBranchIds.length === 0) return { kind: \"forbidden\" } as const")
    // The order is no longer located by creator, at either step.
    expect(route).not.toContain("eq(orders.createdByUserId, user.id)")
    expect(route).not.toContain("eq(orders.createdByUserId, context.userId)")
  })

  it("authorizes a refund against the same branch set", () => {
    const refunds = source("app/api/v1/orders/[id]/refunds/route.ts")
    expect(refunds).toContain("canRequesterActOnOrder")
    expect(refunds).toContain("resolveRefundBranchIds")
    expect(refunds).not.toContain("orderData.createdByUserId === userId")
  })

  // Creator equality used to carry accountability as well as access. Branch
  // ownership keeps only the access half, so the trail has to carry the rest.
  it("names both parties and tells the raiser when a colleague writes", () => {
    const audit = source("lib/server/order-write-audit.ts")
    expect(audit).toContain("isCrossRequesterWrite")
    expect(audit).toContain("notifications")

    for (const path of [
      "app/api/v1/orders/[id]/route.ts",
      "app/api/v1/orders/[id]/refunds/route.ts",
    ]) {
      const route = source(path)
      expect(route).toContain("notifyRaiserOfOrderWrite")
      expect(route).toContain("onBehalfOfUserId")
    }
  })

  it("keeps the fulfilment token with the raiser", () => {
    // A credential handed to an administrator, not an action on the order, so
    // this one did not widen with the rest.
    const token = source("lib/fulfillment-token-access.ts")
    expect(token).toContain("orderCreatedByUserId === userId")
    expect(token).not.toContain("groupOrderId")
    expect(source("app/api/v1/orders/[id]/send-token-email/route.ts"))
      .not.toContain("groupOrderId")
  })

  it("offers no control the server would refuse", () => {
    // The store no longer hides its write controls on a group order, because
    // the server now accepts them. A guard left behind here would read as the
    // feature being broken.
    const shop = source("app/shop/page.tsx")
    expect(shop).not.toContain('&& !order.placedByGroupPortal')
    expect(shop).not.toContain("!(isOrderPortal && selectedOrder.placedByGroupPortal)")
    // Editing is still offered only while the order can actually be edited.
    expect(shop).toContain('order.status?.toUpperCase() === "PENDING"')
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

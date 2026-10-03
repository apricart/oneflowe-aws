import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The order list endpoint authenticates but does not use a role allowlist; it
 * narrows rows per role instead. A role with no branch of its own must never
 * fall through that ladder into the whole tenant, so these contracts pin the
 * fail-closed shape in place.
 */
describe("order list tenant scoping", () => {
  const orders = source("app/api/v1/orders/route.ts")

  it("restricts multi-branch roles to their resolved branches", () => {
    expect(orders).toContain("usesMultiBranchScope(role)")
    expect(orders).toContain("addMultiBranchOrderScope(conditions, context.scopedBranchIds)")
    expect(orders).toContain("inArray(orders.branchId, branchIds)")
  })

  it("resolves that scope on the server, never from the request", () => {
    expect(orders).toContain("resolveScopedBranchIds(db, currentUserId)")
    expect(orders).not.toContain("searchParams.get(\"scopedBranchIds\")")
  })

  it("denies every branch of the ladder that lacks an explicit scope", () => {
    // An empty multi-branch scope, a missing organization, and a role with no
    // branch all have to end in an impossible condition rather than no filter.
    expect(orders).toContain("const DENY_ALL_ORDERS = sql`false`")
    expect(orders).toContain("branchIds.length === 0 ? DENY_ALL_ORDERS")

    const roleConditions = orders.slice(
      orders.indexOf("function addOrderRoleConditions"),
      orders.indexOf("function addOrderDimensionConditions"),
    )
    // The organization guard and the single-branch tail each deny by default.
    expect(roleConditions.match(/DENY_ALL_ORDERS/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it("leaves the Super Admin, Head Office, and Order Portal paths intact", () => {
    const roleConditions = orders.slice(
      orders.indexOf("function addOrderRoleConditions"),
      orders.indexOf("function addOrderDimensionConditions"),
    )
    expect(roleConditions).toContain('if (role === "SUPER_ADMIN")')
    expect(orders).toContain("addSuperAdminOrderScope(conditions, context.organizationIdParam)")
    expect(roleConditions).toContain('if (role === "HEAD_OFFICE") return')
    expect(roleConditions).toContain('role === "ORDER_PORTAL" && currentUserId')
    expect(roleConditions).toContain("eq(orders.createdByUserId, currentUserId)")
  })
})

describe("group user decision surface", () => {
  it("keeps approve and reject the only decision endpoints it can reach", () => {
    const approve = source("app/api/v1/orders/[id]/approve/route.ts")
    const reject = source("app/api/v1/orders/[id]/reject/route.ts")
    const fulfill = source("app/api/v1/orders/[id]/fulfill/route.ts")
    const detail = source("app/api/v1/orders/[id]/route.ts")

    expect(approve).toContain('"GROUP_USER"')
    expect(reject).toContain('"GROUP_USER"')
    // Fulfillment stays Super Admin-only; it never gains the new role.
    expect(fulfill).not.toContain("GROUP_USER")
  })

  it("lets the approver read one order but never write to it", () => {
    const detail = source("app/api/v1/orders/[id]/route.ts")

    // Reading a single order is how the approver opens the detail drawer, so
    // the role is on the GET allowlist only. The requester role joined this
    // list for its own read-only tab; neither is on any write allowlist below.
    expect(detail).toContain('requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])')
    // Editing stays with the two requester roles and deletion with the Super
    // Admin; neither list may quietly pick up a deciding role.
    expect(detail).toContain('requireApiRole(["ORDER_PORTAL", "GROUP_ORDER_PORTAL"])')
    expect(detail).toContain('requireApiRole(["SUPER_ADMIN"])')
  })

  it("checks that read against the group roles' assignments, not a single branch", () => {
    const detail = source("app/api/v1/orders/[id]/route.ts")

    // Every single-branch role keeps the original check untouched. The
    // predicate names the mechanism rather than one role, so the approver and
    // the requester cannot drift apart.
    expect(detail).toContain("if (!usesMultiBranchScope(role)) {")
    expect(detail).toContain("return verifyResourceAccess(order.organizationId, order.branchId)")
    // The approver is checked against its resolved assignments, tenant first.
    expect(detail).toContain("if (!scope.organizationId || scope.organizationId !== order.organizationId) return false")
    expect(detail).toContain("canUseScopedBranch(userId, order.branchId)")
  })

  it("never lets the ordering-only group role decide", () => {
    const scope = source("lib/server/multi-branch-scope.ts")
    expect(scope).toContain("export function isGroupApproverRole")
    expect(scope).toContain('return role === GROUP_USER_ROLE')
  })
})

/**
 * The Group User's "Other orders" tab narrows the shared order list to the
 * orders branch employees raised themselves. It is a *narrowing* filter laid on
 * top of the branch scope above, so these contracts pin down that it can only
 * remove rows — and that a malformed value is refused rather than dropped,
 * which would hand back more than the caller asked for.
 */
describe("order list creator-role filter", () => {
  const orders = source("app/api/v1/orders/route.ts")

  it("takes the role from an allowlist and binds it as a parameter", () => {
    expect(orders).toContain("parseOrderCreatorRoleFilter(params.createdByRole)")
    // The predicate itself moved to `lib/server/order-creator-role-sql.ts` when
    // the filter began reading the role recorded on the order rather than the
    // creator's role today. The guarantee is unchanged and is asserted where
    // the expression now lives: the value is bound through drizzle's `eq`,
    // never interpolated.
    expect(orders).toContain("orderCreatedByRoleMatches(creatorRole)")
    const creatorRoleSql = source("lib/server/order-creator-role-sql.ts")
    expect(creatorRoleSql).toContain("eq(orders.createdByRole, creatorRole)")
    expect(creatorRoleSql).toContain("eq(roles.name, creatorRole)")
    // Nothing the caller sends is ever concatenated into the fragment.
    expect(orders).not.toContain("sql.raw(params.createdByRole")
    expect(creatorRoleSql).not.toContain("sql.raw(")
  })

  it("refuses a malformed value rather than ignoring it", () => {
    // Parsed with the other list filters and the sort in `parseOrderListQuery`,
    // whose first refusal the handler answers with 400.
    expect(orders).toContain("if (!creatorFilter.ok) return { ok: false, error: creatorFilter.message }")
    expect(orders).toContain("if (!listQuery.ok) return NextResponse.json({ error: listQuery.error }, { status: 400 })")
  })

  it("applies the filter before the summary snapshot is taken", () => {
    // Otherwise the status counts would describe the whole branch scope while
    // the rows beneath them described only one role's orders.
    const creatorAt = orders.indexOf("addOrderCreatorRoleCondition(conditions, listQuery.creatorRole)")
    const summaryAt = orders.indexOf("const summaryConditions = [...conditions]")
    expect(creatorAt).toBeGreaterThan(-1)
    expect(summaryAt).toBeGreaterThan(creatorAt)
  })

  it("narrows the branch scope instead of replacing it", () => {
    // The role condition is pushed onto the same `conditions` array the branch
    // scope was pushed onto, so both are AND-ed together.
    expect(orders).toContain("function addOrderCreatorRoleCondition(conditions: any[], creatorRole: OrderCreatorRole | null)")
    expect(orders).toContain("if (!creatorRole) return")
  })

  it("does not key the tab on groupOrderId", () => {
    // A group order is an ordinary order of the branch's. Keying a query on
    // that column is what makes one vanish from the branch's own figures.
    const creatorCondition = orders.slice(
      orders.indexOf("function addOrderCreatorRoleCondition"),
      orders.indexOf("function addOrderDateConditions"),
    )
    expect(creatorCondition).not.toContain("groupOrderId")
  })
})

describe("group user approval workspace", () => {
  it("reads the shared, role-scoped order list for the employee-order tab", () => {
    const tab = source("components/group-portal/approval-other-orders.tsx")

    // The branch set is resolved server-side from this user's assignments; the
    // client sends no branch filter of its own.
    expect(tab).toContain('createdByRole: "ORDER_PORTAL"')
    expect(tab).toContain("/api/v1/orders?")
    expect(tab).not.toContain("branchIds")
  })

  it("takes the decision controls from the endpoint's own capabilities", () => {
    const tab = source("components/group-portal/approval-other-orders.tsx")

    expect(tab).toContain("data?.capabilities?.canApproveOrders && data?.capabilities?.canRejectOrders")
    // Super Admin-only controls stay closed for this role.
    expect(tab).toContain("isSuperAdmin={false}")
  })

  it("keeps the existing tabs alongside the new one", () => {
    const workspace = source("components/group-portal/approvals-workspace.tsx")

    expect(workspace).toContain("<ApprovalQueue />")
    expect(workspace).toContain("<ApprovalAllOrders />")
    expect(workspace).toContain("<ApprovalOtherOrders />")
  })
})

/**
 * The Group Order Portal requester's "Other orders" tab. It reads the orders
 * branch employees raised in its assigned branches, and does nothing else —
 * these contracts are what keep "and does nothing else" true.
 */
describe("group order portal requester writes only inside its branches", () => {
  const detail = () => source("app/api/v1/orders/[id]/route.ts")

  it("reaches the single-order read", () => {
    expect(detail()).toContain('"GROUP_ORDER_PORTAL"')
  })

  it("never gains a decision on any order route", () => {
    // Raising an order and deciding one stay separate roles. Editing and
    // refunding widened to the branch; approving, rejecting, fulfilling and
    // marking paid did not, so none of these may name the requester role.
    for (const path of [
      "app/api/v1/orders/[id]/approve/route.ts",
      "app/api/v1/orders/[id]/reject/route.ts",
      "app/api/v1/orders/[id]/fulfill/route.ts",
      "app/api/v1/orders/[id]/fulfillment-status/route.ts",
      "app/api/v1/orders/[id]/payment-status/route.ts",
    ]) {
      expect(source(path)).not.toContain("GROUP_ORDER_PORTAL")
    }
  })

  it("bounds editing and refunding by branch assignment, not by creator", () => {
    // The branch owns its orders, so both writes are gated on the assignment
    // set this role resolves to — never on who raised the order.
    expect(source("lib/order-write-access.ts"))
      .toContain("branchIds.includes(order.branchId)")
    expect(source("app/api/v1/orders/[id]/route.ts"))
      .toContain("resolveWritableBranchIds")
    expect(source("app/api/v1/orders/[id]/refunds/route.ts"))
      .toContain("resolveRefundBranchIds")
  })

  it("leaves the fulfilment token and the invoice with the person who raised the order", () => {
    // A credential and a document, not actions on the order, so neither
    // widened with the writes above.
    expect(source("lib/fulfillment-token-access.ts"))
      .toContain("orderCreatedByUserId === userId")
    expect(source("lib/invoice-access-policy.ts"))
      .toContain("GROUP_ORDER_PORTAL: { tenant: \"own-organization\", branches: \"own-organization\", ownOrdersOnly: true }")
  })

  it("withholds the creator's contact row from a requester reading another's order", () => {
    expect(detail()).toContain("applyOrderCreatorContactVisibility(")
    expect(detail()).toContain("orderCreatedByUserId: item.createdByUserId")
  })

  it("offers no control in the tab that the server would refuse", () => {
    const tab = source("components/group-portal/other-branch-orders.tsx")

    // A read-only surface: nothing here may POST, PUT, PATCH or DELETE.
    expect(tab).not.toContain("method: \"POST\"")
    expect(tab).not.toContain("method: \"PUT\"")
    expect(tab).not.toContain("method: \"PATCH\"")
    expect(tab).not.toContain("method: \"DELETE\"")
    // And it asks the server only for the orders it is meant to show.
    expect(tab).toContain('createdByRole: "ORDER_PORTAL"')
  })

  it("sends no branch filter of its own", () => {
    // The branch set is resolved server-side from this user's assignments.
    const tab = source("components/group-portal/other-branch-orders.tsx")
    expect(tab).not.toContain("branchIds")
    expect(tab).not.toContain("organizationId")
  })
})

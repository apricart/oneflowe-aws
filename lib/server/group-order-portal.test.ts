import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

// The modules under test reach the database only inside their query helpers.
// These stubs keep the pure planning and validation logic unit-testable.
vi.mock("server-only", () => ({}))
vi.mock("@/lib/db", () => ({ db: {} }))
vi.mock("@/lib/receipt-generator", () => ({ generateReceiptData: async () => null }))
vi.mock("@/lib/invoice-number", () => ({
  generateNextInvoiceNumber: async () => "INV-1",
  hasInvoiceSequenceTable: async () => true,
}))
// Pulls in Redis-backed caching, which needs a configured environment.
vi.mock("@/lib/server/budget-allocation-mode", () => ({
  getBudgetAllocationModeForOrganization: async () => "money",
}))

import { groupOrderFingerprint, mergeEntriesByBranch } from "./group-order-creation"
import { groupOrderCreateSchema, groupOrderDraftSchema } from "./mutation-validation"
import {
  MAX_BRANCHES_PER_SUBMISSION,
  UNGROUPED_BUCKET_NAME,
} from "./group-order-portal"
import {
  MAX_ENTRY_BRANCHES,
  applyQuantityToBranchPlans,
  branchPlansToEntries,
  mergeEntriesIntoBranchPlans,
  toRequestEntries,
  withoutBranchPlan,
} from "@/components/group-portal/group-order-plan"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const branch = (id: number, name = `Branch ${id}`) => ({
  id,
  name,
  city: null,
  costCenterId: null,
  groupId: 7,
})

const branchesById = new Map([1, 2, 3].map((id) => [id, branch(id)]))

describe("group order entry merge", () => {
  it("creates one plan per branch, summing a product chosen in several steps", () => {
    const plans = mergeEntriesByBranch([
      { branchIds: [1, 2], items: [{ organizationInventoryId: 10, quantity: 4 }] },
      { branchIds: [2], items: [{ organizationInventoryId: 10, quantity: 6 }] },
    ], branchesById)

    expect(plans.map((plan) => plan.branch.id)).toEqual([1, 2])
    expect(plans[0].items).toEqual([{ organizationInventoryId: 10, quantity: 4 }])
    // Branch 2 appears in both steps, so its single order carries the total.
    expect(plans[1].items).toEqual([{ organizationInventoryId: 10, quantity: 10 }])
  })

  it("orders branches by id so concurrent submissions take locks in one sequence", () => {
    const plans = mergeEntriesByBranch([
      { branchIds: [3, 1, 2], items: [{ organizationInventoryId: 10, quantity: 1 }] },
    ], branchesById)

    expect(plans.map((plan) => plan.branch.id)).toEqual([1, 2, 3])
  })

  it("drops branches that are not in the authorized scope map", () => {
    const plans = mergeEntriesByBranch([
      { branchIds: [1, 99], items: [{ organizationInventoryId: 10, quantity: 1 }] },
    ], branchesById)

    // 99 was never resolved from the caller's assignments, so it cannot appear.
    expect(plans.map((plan) => plan.branch.id)).toEqual([1])
  })

  it("keeps the client preview and the server plan in agreement", () => {
    const entries = [
      { key: "a", branchIds: [1, 2], lines: [{ organizationInventoryId: 10, quantity: 4, name: "Sugar", unit: "kg", priceCents: 250 }] },
      { key: "b", branchIds: [2], lines: [{ organizationInventoryId: 10, quantity: 6, name: "Sugar", unit: "kg", priceCents: 250 }] },
    ]

    const clientPlans = mergeEntriesIntoBranchPlans(entries, branchesById)
    const serverPlans = mergeEntriesByBranch(toRequestEntries(entries), branchesById)

    expect(clientPlans.map((plan) => ({
      branchId: plan.branch.id,
      items: plan.lines.map((line) => ({
        organizationInventoryId: line.organizationInventoryId,
        quantity: line.quantity,
      })),
    }))).toEqual(serverPlans.map((plan) => ({
      branchId: plan.branch.id,
      items: plan.items,
    })))
  })

  it("strips display fields before anything leaves the browser", () => {
    const request = toRequestEntries([{
      key: "a",
      branchIds: [1],
      lines: [{ organizationInventoryId: 10, quantity: 2, name: "Sugar", unit: "kg", priceCents: 999 }],
    }])

    expect(request).toEqual([{ branchIds: [1], items: [{ organizationInventoryId: 10, quantity: 2 }] }])
    expect(JSON.stringify(request)).not.toContain("priceCents")
  })
})

describe("group order review edits", () => {
  const line = (id: number, quantity: number, priceCents = 100) => ({
    organizationInventoryId: id,
    quantity,
    name: `Product ${id}`,
    unit: "kg",
    priceCents,
  })

  /** What each branch ends up receiving, independent of line ordering. */
  const received = (plans: ReturnType<typeof mergeEntriesIntoBranchPlans>) =>
    plans.map((plan) => ({
      branchId: plan.branch.id,
      items: [...plan.lines]
        .map((entry) => [entry.organizationInventoryId, entry.quantity] as const)
        .sort(([left], [right]) => left - right),
    }))

  const basePlans = () => mergeEntriesIntoBranchPlans([
    { key: "a", branchIds: [1, 2, 3], lines: [line(10, 4, 250), line(11, 2, 500)] },
  ], branchesById)

  let keyCounter = 0
  const nextKey = () => `k${++keyCounter}`

  it("changes one branch without touching the others", () => {
    const edited = applyQuantityToBranchPlans(basePlans(), 10, 9, 2)

    expect(received(edited)).toEqual([
      { branchId: 1, items: [[10, 4], [11, 2]] },
      { branchId: 2, items: [[10, 9], [11, 2]] },
      { branchId: 3, items: [[10, 4], [11, 2]] },
    ])
    // The branch total is re-derived from the edited line, not carried over.
    expect(edited[1].totalCents).toBe(9 * 250 + 2 * 500)
  })

  it("removes the line at zero, and the branch once it has nothing left", () => {
    const withoutOne = applyQuantityToBranchPlans(basePlans(), 10, 0, 2)
    expect(received(withoutOne)[1]).toEqual({ branchId: 2, items: [[11, 2]] })

    const emptied = applyQuantityToBranchPlans(withoutOne, 11, 0, 2)
    expect(emptied.map((plan) => plan.branch.id)).toEqual([1, 3])
  })

  it("applies to every branch that already receives the product, and no others", () => {
    const plans = mergeEntriesIntoBranchPlans([
      { key: "a", branchIds: [1, 2], lines: [line(10, 4)] },
      { key: "b", branchIds: [3], lines: [line(11, 1)] },
    ], branchesById)

    const applied = applyQuantityToBranchPlans(plans, 10, 7)

    expect(received(applied)).toEqual([
      { branchId: 1, items: [[10, 7]] },
      { branchId: 2, items: [[10, 7]] },
      // Branch 3 never had product 10; applying to all must not introduce it.
      { branchId: 3, items: [[11, 1]] },
    ])
  })

  it("rebuilds entries that merge back into exactly the edited plans", () => {
    const edited = applyQuantityToBranchPlans(basePlans(), 10, 9, 2)
    const rebuilt = branchPlansToEntries(edited, nextKey)

    expect(received(mergeEntriesIntoBranchPlans(rebuilt, branchesById))).toEqual(received(edited))
  })

  it("keeps the payload small by sharing one entry between identical branches", () => {
    const rebuilt = branchPlansToEntries(applyQuantityToBranchPlans(basePlans(), 10, 9, 2), nextKey)

    // Two shapes only: the branch that was edited, and everyone else.
    expect(rebuilt).toHaveLength(2)
    expect(rebuilt.map((entry) => entry.branchIds.length).sort()).toEqual([1, 2])
  })

  it("chunks branch lists so no rebuilt entry exceeds the server's branch limit", () => {
    const manyIds = Array.from({ length: MAX_ENTRY_BRANCHES + 25 }, (_, index) => index + 1)
    const manyBranches = new Map(manyIds.map((id) => [id, branch(id)]))
    const plans = mergeEntriesIntoBranchPlans(
      [{ key: "a", branchIds: manyIds, lines: [line(10, 4)] }],
      manyBranches,
    )

    const rebuilt = branchPlansToEntries(plans, nextKey)

    expect(rebuilt).toHaveLength(2)
    expect(rebuilt.every((entry) => entry.branchIds.length <= MAX_ENTRY_BRANCHES)).toBe(true)
    // Splitting the list must not lose or duplicate a branch.
    expect(rebuilt.flatMap((entry) => entry.branchIds).sort((a, b) => a - b)).toEqual(manyIds)
    expect(received(mergeEntriesIntoBranchPlans(rebuilt, manyBranches))).toEqual(received(plans))
  })

  it("drops one branch from the order without disturbing the rest", () => {
    const remaining = withoutBranchPlan(basePlans(), 2)

    expect(remaining.map((plan) => plan.branch.id)).toEqual([1, 3])
    expect(received(remaining)[0]).toEqual({ branchId: 1, items: [[10, 4], [11, 2]] })
  })

  it("still produces a payload the submission endpoint accepts", () => {
    const rebuilt = branchPlansToEntries(applyQuantityToBranchPlans(basePlans(), 10, 9, 2), nextKey)

    const parsed = groupOrderCreateSchema.safeParse({
      groupId: 7,
      entries: toRequestEntries(rebuilt),
    })

    expect(parsed.success).toBe(true)
  })
})

describe("group order idempotency fingerprint", () => {
  const plans = mergeEntriesByBranch([
    { branchIds: [1, 2], items: [{ organizationInventoryId: 10, quantity: 4 }] },
  ], branchesById)

  it("is stable for the same submission", () => {
    const input = { organizationId: 1, groupId: 7, notes: null, poNumber: null, plans }
    expect(groupOrderFingerprint(input)).toBe(groupOrderFingerprint(input))
  })

  it("changes when the branches, items, or tenant change", () => {
    const base = groupOrderFingerprint({ organizationId: 1, groupId: 7, notes: null, poNumber: null, plans })

    expect(groupOrderFingerprint({ organizationId: 2, groupId: 7, notes: null, poNumber: null, plans })).not.toBe(base)
    expect(groupOrderFingerprint({ organizationId: 1, groupId: 8, notes: null, poNumber: null, plans })).not.toBe(base)
    expect(groupOrderFingerprint({ organizationId: 1, groupId: 7, notes: "changed", poNumber: null, plans })).not.toBe(base)
    // A different purchase order reference is a different submission, so a
    // replayed key carrying one is refused rather than answered with the first.
    expect(groupOrderFingerprint({ organizationId: 1, groupId: 7, notes: null, poNumber: "PO-1", plans })).not.toBe(base)
    expect(groupOrderFingerprint({
      organizationId: 1,
      groupId: 7,
      notes: null,
      poNumber: null,
      plans: mergeEntriesByBranch([
        { branchIds: [1, 2], items: [{ organizationInventoryId: 10, quantity: 5 }] },
      ], branchesById),
    })).not.toBe(base)
  })
})

describe("group order request validation", () => {
  const validEntry = { branchIds: [1, 2], items: [{ organizationInventoryId: 10, quantity: 3 }] }

  it("accepts a well-formed submission, including the ungrouped bucket", () => {
    expect(groupOrderCreateSchema.safeParse({ groupId: 5, entries: [validEntry] }).success).toBe(true)
    expect(groupOrderCreateSchema.safeParse({ groupId: null, entries: [validEntry] }).success).toBe(true)
  })

  it("rejects unknown fields so nothing can be smuggled past the schema", () => {
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [validEntry],
      organizationId: 99,
    }).success).toBe(false)

    // Prices are never accepted from the client; the server reads its own.
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [1], items: [{ organizationInventoryId: 10, quantity: 3, priceCents: 1 }] }],
    }).success).toBe(false)
  })

  it("requires at least one branch and one item per step", () => {
    expect(groupOrderCreateSchema.safeParse({ groupId: 5, entries: [] }).success).toBe(false)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [], items: [{ organizationInventoryId: 10, quantity: 1 }] }],
    }).success).toBe(false)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [1], items: [] }],
    }).success).toBe(false)
  })

  it("rejects non-positive quantities and duplicate selections", () => {
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [1], items: [{ organizationInventoryId: 10, quantity: 0 }] }],
    }).success).toBe(false)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [1], items: [{ organizationInventoryId: 10, quantity: -5 }] }],
    }).success).toBe(false)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: [1, 1], items: [{ organizationInventoryId: 10, quantity: 1 }] }],
    }).success).toBe(false)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{
        branchIds: [1],
        items: [
          { organizationInventoryId: 10, quantity: 1 },
          { organizationInventoryId: 10, quantity: 2 },
        ],
      }],
    }).success).toBe(false)
  })

  it("bounds the fan-out of a single submission", () => {
    const tooManyBranches = Array.from({ length: MAX_BRANCHES_PER_SUBMISSION + 1 }, (_, index) => index + 1)
    expect(groupOrderCreateSchema.safeParse({
      groupId: 5,
      entries: [{ branchIds: tooManyBranches, items: [{ organizationInventoryId: 10, quantity: 1 }] }],
    }).success).toBe(false)

    const tooManyEntries = Array.from({ length: 51 }, () => validEntry)
    expect(groupOrderCreateSchema.safeParse({ groupId: 5, entries: tooManyEntries }).success).toBe(false)
  })

  it("lets a draft be empty but holds it to the same item shape", () => {
    expect(groupOrderDraftSchema.safeParse({ groupId: null, entries: [] }).success).toBe(true)
    expect(groupOrderDraftSchema.safeParse({
      groupId: null,
      entries: [{ branchIds: [1], items: [{ organizationInventoryId: 10, quantity: 1, priceCents: 5 }] }],
    }).success).toBe(false)
  })

  it("carries the unsaved step without letting it smuggle a price", () => {
    expect(groupOrderDraftSchema.safeParse({
      groupId: 3,
      entries: [],
      draftBranchIds: [1, 2],
      draftItems: [{ organizationInventoryId: 10, quantity: 4 }],
    }).success).toBe(true)

    expect(groupOrderDraftSchema.safeParse({
      groupId: 3,
      entries: [],
      draftItems: [{ organizationInventoryId: 10, quantity: 4, priceCents: 1 }],
    }).success).toBe(false)
    expect(groupOrderDraftSchema.safeParse({
      groupId: 3,
      entries: [],
      draftItems: [
        { organizationInventoryId: 10, quantity: 1 },
        { organizationInventoryId: 10, quantity: 2 },
      ],
    }).success).toBe(false)
  })
})

describe("group order portal access contracts", () => {
  const routes = [
    "app/api/v1/group-portal/groups/route.ts",
    "app/api/v1/group-portal/catalog/route.ts",
    "app/api/v1/group-portal/orders/route.ts",
    "app/api/v1/group-portal/draft/route.ts",
    "app/api/v1/group-portal/prices/route.ts",
  ]

  it("gates every ordering endpoint on the one requesting role", () => {
    const gate = source("lib/server/group-order-access.ts")
    // The file also holds the approver gate, so the ordering gate is isolated
    // before being asserted on: the two must never share an allowlist.
    const orderingGate = gate.slice(
      gate.indexOf("export async function requireGroupOrderPortal"),
      gate.indexOf("export type GroupApproverActor"),
    )
    expect(orderingGate).not.toHaveLength(0)

    expect(orderingGate).toContain("requireApiRole([GROUP_ORDER_PORTAL_ROLE])")
    // The approver role shares the branch-assignment mechanism but must not be
    // able to raise orders through this surface. It may be named in prose, never
    // as a role this allowlist accepts.
    expect(orderingGate).not.toContain('"GROUP_USER"')
    expect(orderingGate).not.toContain("GROUP_USER_ROLE")
    // A user without a tenant has no scope, and that must not read as "all".
    expect(orderingGate).toContain("if (!scope.organizationId)")

    for (const path of routes) {
      const route = source(path)
      expect(route).toContain("requireGroupOrderPortal()")
      expect(route).toContain("if (response) return response")
      // No endpoint may build its own weaker allowlist.
      expect(route).not.toContain("requireApiRole(")
    }
  })

  it("authorizes the requested branches against live assignments before reading data", () => {
    const catalog = source("app/api/v1/group-portal/catalog/route.ts")
    const orders = source("app/api/v1/group-portal/orders/route.ts")

    for (const route of [catalog, orders]) {
      expect(route).toContain("resolveSubmissionScope({")
      expect(route).toContain("userId: actor.scope.userId")
      expect(route).toContain("organizationId: actor.organizationId")
      expect(route).toContain("if (failure) return error(failure.message, failure.status)")
    }
    // The catalogue is read from the resolved scope, never from the raw request.
    expect(catalog).toContain("branchIds: scope.branches.map((branch) => branch.id)")
  })

  it("resolves scope from assignments and fails closed at every branch", () => {
    const scope = source("lib/server/group-order-portal.ts")

    expect(scope).toContain("resolveScopedBranchIds(db, userId)")
    expect(scope).toContain("if (scopedBranchIds.length === 0) return []")
    expect(scope).toContain("eq(branches.organizationId, organizationId)")
    expect(scope).toContain("You do not have access to the selected group")
    expect(scope).toContain("One or more selected branches are not part of the selected group")
    expect(scope).toContain(`MAX_BRANCHES_PER_SUBMISSION = ${MAX_BRANCHES_PER_SUBMISSION}`)
  })

  it("keeps submissions rate limited and replay safe", () => {
    const orders = source("app/api/v1/group-portal/orders/route.ts")

    expect(orders).toContain('withRateLimit("order", actor.scope.userId)')
    expect(orders).toContain("IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)")
    expect(orders).toContain("groupOrderCreateSchema.safeParse")
  })

  it("prices every line on the server and never from the request or a draft", () => {
    const creation = source("lib/server/group-order-creation.ts")
    const draft = source("app/api/v1/group-portal/draft/route.ts")

    // Every tier of the price ladder is read from the locked rows: the group
    // override loaded inside the transaction, the organization override on the
    // locked inventory row, and the base price on the locked product row.
    expect(creation).toContain("resolveEffectivePriceCents({")
    expect(creation).toContain("groupPriceCents: locked.groupPriceByInventoryId.get(inventoryItem.id)")
    expect(creation).toContain("organizationPriceCents: inventoryItem.customPrice")
    expect(creation).toContain("basePriceCents: product.basePrice")
    expect(creation).toContain(".for(\"update\")")
    expect(creation).toContain("Insufficient stock")
    // The draft is a resume aid; the tenant on it is always rewritten from the
    // session so a payload cannot relocate someone else's draft.
    expect(draft).toContain("organizationId: actor.organizationId")
    expect(draft).toContain("target: groupOrderDrafts.userId")
  })

  it("reads history only within the caller's own submissions and tenant", () => {
    const history = source("lib/server/group-order-history.ts")

    expect(history).toContain("eq(groupOrders.createdByUserId, userId)")
    expect(history).toContain("eq(groupOrders.organizationId, organizationId)")
    expect(history).toContain("eq(orders.createdByUserId, userId)")
    expect(history).toContain("if (!organizationId) return emptyPage")
  })

  it("confines the storefront to the requesting role in the proxy and the server layout", () => {
    const proxySource = source("proxy.ts")
    const layout = source("app/group-portal/layout.tsx")

    // The requester owns /group-portal and reaches nothing else: not the admin
    // shell, not the approver's queue, not the single-branch /shop. The one
    // addition is the shared invoice page its own history links to, which is
    // scoped per order by lib/invoice-access-policy rather than by area.
    expect(proxySource).toContain('const GROUP_ORDER_PORTAL_HOME = "/group-portal"')
    expect(proxySource).toContain('if (role === "GROUP_ORDER_PORTAL") {')
    // Matched on the terms rather than on one line of source, because the
    // allowlist has outgrown a single line: what matters is that the home is
    // the only *area* the requester holds and every addition is a named shared
    // surface, not how the expression happens to be wrapped.
    expect(proxySource).toContain("return pathname.startsWith(GROUP_ORDER_PORTAL_HOME)")
    expect(proxySource).toContain(": GROUP_ORDER_PORTAL_HOME")
    expect(proxySource).toContain("|| isInvoiceArea(pathname)")
    // The support area joined the invoice page as a second shared surface: a
    // requester raises a query about its own order from here, and which threads
    // it may read is decided by lib/support-access rather than by area.
    expect(proxySource).toContain("isSupportArea(pathname)")
    expect(proxySource).toContain('const SUPPORT_AREA = "/support"')
    // And delivery addresses as a third: the requester asks for a destination
    // for the branches it orders for, and which branches those are is
    // re-resolved from its own assignments on every call rather than by area.
    expect(proxySource).toContain("|| isDeliveryAddressArea(pathname)")
    expect(proxySource).toContain('const DELIVERY_ADDRESS_AREA = "/delivery-addresses"')
    // The gate that used to sit on the retired wizard route now guards the area
    // itself, and still fails closed: only the requester renders the
    // storefront. Every other role — the approver included — is sent to the
    // admin shell.
    expect(layout).toContain("if (role !== GROUP_ORDER_PORTAL_ROLE) redirect(\"/dashboard\")")
    expect(layout).not.toContain("GROUP_USER_ROLE) redirect")
  })

  it("never gives the single-branch order endpoint a group creation path", () => {
    const ordersRoute = source("app/api/v1/orders/route.ts")

    // The group flow keeps its own endpoint. The shared one must not learn how
    // to raise a submission, and must never write an envelope reference of its
    // own — an order created here is an ordinary single-branch order.
    expect(ordersRoute).not.toContain("createGroupOrder")
    const createPath = ordersRoute.slice(
      ordersRoute.indexOf("async function persistCreatedOrder"),
      ordersRoute.indexOf("async function processOrderCreationTransaction"),
    )
    expect(createPath).not.toContain("groupOrderId")

    // Reading the column is deliberate and separate: it is how a branch's own
    // roles see the orders the group portal raised for them.
    expect(ordersRoute).toContain("groupOrderId: orders.groupOrderId,")
    expect(ordersRoute).toContain("isNotNull(orders.groupOrderId)")
  })
})

describe("group bucketing", () => {
  it("names the bucket for branches that carry no group", () => {
    expect(UNGROUPED_BUCKET_NAME).toBe("Unassigned branches")
  })
})

describe("group order branch availability", () => {
  const portal = source("lib/server/group-order-portal.ts")

  it("keeps a deactivated or suspended branch out of the ordering scope", () => {
    // The filter used to test for a status of 'deleted'. Branches never carry
    // that value — deleting one sets 'inactive' — so the clause matched nothing
    // and a branch an administrator had removed stayed fully orderable while
    // disappearing from every budget screen.
    expect(portal).toContain('const OUT_OF_SERVICE_BRANCH_STATUSES = ["inactive", "suspended", "deleted"]')
    expect(portal).toContain("branchIsInService")
    expect(portal).not.toContain("${branches.status} IS DISTINCT FROM 'deleted'")
  })

  it("still resolves the scope from the user's own assignments and tenant", () => {
    expect(portal).toContain("inArray(branches.id, scopedBranchIds)")
    expect(portal).toContain("eq(branches.organizationId, organizationId)")
  })

  it("leaves the group filter alone, where a 'deleted' status is real", () => {
    // `groups.status` genuinely takes that value; only the branch filter was
    // testing for a status the application never writes.
    expect(portal).toContain("${groups.status} IS DISTINCT FROM 'deleted'")
  })

  it("treats a branch with no status at all as in service", () => {
    // Rows predating the column must keep working; this is the one case the
    // filter deliberately lets through.
    expect(portal).toContain("${branches.status} IS NULL")
  })

  it("leaves the shared multi-branch resolver alone", () => {
    // The approver's queue, the report, and the orders endpoint all resolve
    // their scope here. Filtering by status in this helper would retro-actively
    // hide orders already raised against a branch that was later deactivated.
    const scope = source("lib/server/multi-branch-scope.ts")
    expect(scope).not.toContain("branches.status")
  })
})

describe("group order line snapshot", () => {
  const creation = source("lib/server/group-order-creation.ts")

  it("stores the product name the portal actually displayed", () => {
    // The catalogue and the price refresh both show the tenant's own name, so
    // filing the order line under the global name left the user reviewing one
    // name and receiving another on the order, receipt, and refund screens.
    expect(creation).toContain("customName: organizationInventory.customName,")
    expect(creation).toContain("const productName = inventoryItem.customName || product.name")
    expect(creation).toContain("productName,")
  })

  it("reports a shortfall under that same name", () => {
    expect(creation).toContain("`Insufficient stock for ${item.productName}.")
  })

  it("holds a submitted quantity to the product's step", () => {
    expect(creation).toContain("enforceStep: true,")
  })

  it("still prices every line from the locked database rows", () => {
    expect(creation).toContain("const priceCents = resolveEffectivePriceCents({")
    expect(creation).toContain("organizationPriceCents: inventoryItem.customPrice")
    expect(creation).toContain("basePriceCents: product.basePrice")
    expect(creation).toContain("calculateLineCents(priceCents, validation.quantity)")
  })

  it("resolves the group price tier inside the same transaction that locks the rows", () => {
    // Read from the branch rather than from the submission scope, so a branch
    // moved between groups mid-submission is priced by the group it is in now.
    expect(creation).toContain("resolveBranchGroupId(tx, {")
    expect(creation).toContain("loadGroupPriceOverrides(tx, {")
    expect(creation).not.toContain("loadGroupPriceOverrides(db,")
  })
})

describe("group order draft restore", () => {
  const draftHook = source("components/group-portal/storefront/use-storefront-draft.ts")
  const storefront = source("components/group-portal/storefront/group-storefront.tsx")

  it("asks for prices in chunks the endpoint accepts", () => {
    // A draft may reference more products than one request may carry, and an
    // oversized request is refused outright.
    expect(draftHook).toContain("const PRICE_LOOKUP_CHUNK_SIZE = 500")
    expect(draftHook).toContain("index += PRICE_LOOKUP_CHUNK_SIZE")
  })

  it("abandons the restore instead of applying it without prices", () => {
    // A draft holds selections only, so a line the price lookup cannot describe
    // cannot be rendered. Applying the restore anyway dropped every line, and
    // the autosave then wrote the emptied cart over the stored draft.
    expect(draftHook).toContain("setRestoreFailed(true)")
    expect(draftHook).toContain("Saved group order could not be restored")
  })

  it("holds the autosave back while a restore is outstanding", () => {
    expect(draftHook).toContain("if (!hydratedRef.current || restoring || restoreFailed || suspended) return")
  })

  it("puts a restored quantity back onto the product's current step", () => {
    // A draft saved before the step was enforced would otherwise submit a
    // value the server now refuses, failing a branch for something the user
    // cannot see is wrong.
    expect(draftHook).toContain("const quantity = snapQuantityToStep(")
    expect(draftHook).toContain("sanitizeQuantityStep(Boolean(product.allowDecimalQuantity), product.quantityStep ?? 1)")
  })

  it("offers the user a retry rather than a lost draft", () => {
    expect(draftHook).toContain("retryDraftRestore")
    expect(storefront).toContain("Try again")
  })

  it("waits for the draft before choosing a group on the user's behalf", () => {
    // Auto-selecting the only group while a saved order was still arriving
    // would overwrite it with an empty cart.
    expect(storefront).toContain("draftStatus !== \"ready\"")
  })
})

describe("group order quantity entry", () => {
  const stepper = source("components/group-portal/quantity-stepper.tsx")
  const review = source("components/group-portal/review-step.tsx")

  it("snaps every committed quantity onto the product's step", () => {
    expect(stepper).toContain("onChange(snapQuantityToStep(raw, step))")
    expect(stepper).toContain("snapQuantityToStep(Math.max(0, value - step), step)")
    expect(stepper).toContain("snapQuantityToStep(value + step, step)")
  })

  it("rounds a review line total the way the branch total and the server do", () => {
    expect(review).toContain("formatPKR(calculateLineCents(line.priceCents, line.quantity) / 100)")
    expect(review).not.toContain("formatPKR((line.priceCents * line.quantity) / 100)")
  })
})

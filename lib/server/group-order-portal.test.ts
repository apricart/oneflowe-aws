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
import { mergeEntriesIntoBranchPlans, toRequestEntries } from "@/components/group-portal/group-order-plan"

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

describe("group order idempotency fingerprint", () => {
  const plans = mergeEntriesByBranch([
    { branchIds: [1, 2], items: [{ organizationInventoryId: 10, quantity: 4 }] },
  ], branchesById)

  it("is stable for the same submission", () => {
    const input = { organizationId: 1, groupId: 7, notes: null, plans }
    expect(groupOrderFingerprint(input)).toBe(groupOrderFingerprint(input))
  })

  it("changes when the branches, items, or tenant change", () => {
    const base = groupOrderFingerprint({ organizationId: 1, groupId: 7, notes: null, plans })

    expect(groupOrderFingerprint({ organizationId: 2, groupId: 7, notes: null, plans })).not.toBe(base)
    expect(groupOrderFingerprint({ organizationId: 1, groupId: 8, notes: null, plans })).not.toBe(base)
    expect(groupOrderFingerprint({ organizationId: 1, groupId: 7, notes: "changed", plans })).not.toBe(base)
    expect(groupOrderFingerprint({
      organizationId: 1,
      groupId: 7,
      notes: null,
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

    expect(creation).toContain("inventoryItem.customPrice ?? product.basePrice")
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

  it("confines the workspace page to the requesting role in the proxy and the server layout", () => {
    const proxySource = source("proxy.ts")
    const layout = source("app/group-portal/bulk-order/layout.tsx")

    // Each workspace inside the shared group area belongs to exactly one role.
    expect(proxySource).toContain('{ prefix: "/group-portal/bulk-order", role: "GROUP_ORDER_PORTAL" }')
    expect(proxySource).toContain('{ prefix: "/group-portal/approvals", role: "GROUP_USER" }')
    expect(proxySource).toContain("exclusiveArea && exclusiveArea.role !== role")
    expect(layout).toContain("!== GROUP_ORDER_PORTAL_ROLE) redirect(\"/group-portal\")")
  })

  it("leaves the single-branch order endpoint untouched", () => {
    const ordersRoute = source("app/api/v1/orders/route.ts")

    // The group flow has its own endpoint; the shared one must not learn about
    // group orders or gain a multi-branch creation path.
    expect(ordersRoute).not.toContain("groupOrderId")
    expect(ordersRoute).not.toContain("createGroupOrder")
  })
})

describe("group bucketing", () => {
  it("names the bucket for branches that carry no group", () => {
    expect(UNGROUPED_BUCKET_NAME).toBe("Unassigned branches")
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Contract tests for the unacknowledged-delivery ordering block
 * (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md).
 *
 * The rule is exercised in `lib/unacknowledged-delivery-block.test.ts` and
 * against Postgres in
 * `tests/integration/unacknowledged-delivery-ordering-block.test.ts`. These
 * pin the *shape*: every path creating a live order asks this gate inside its
 * transaction, after payment control and before any lock or write; the count
 * is the dashboard's predicate with both tenant predicates; the toggle is
 * Super Admin's alone and audited; both ordering pages raise the popup. A new
 * order-creation path belongs on the list below.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

const ORDER_CREATION_PATHS = [
  {
    path: "app/api/v1/orders/route.ts",
    transactionBody: "async function processOrderCreationTransaction(tx: any, context: any) {",
    paymentGate: "await assertBranchMayOrder(tx, { organizationId: context.organizationId, branchId: context.branchId })",
    gateCall: "await assertBranchDeliveriesAcknowledged(tx, { organizationId: context.organizationId, branchId: context.branchId })",
    firstLock: "lockCreationMoneyBudget(tx, context)",
    orderWrite: "return persistCreatedOrder(tx, {",
  },
  {
    path: "lib/server/group-order-creation.ts",
    transactionBody: "const created = await db.transaction(async (tx) => {",
    paymentGate: "await assertBranchMayOrder(tx, { organizationId, branchId })",
    gateCall: "await assertBranchDeliveriesAcknowledged(tx, { organizationId, branchId })",
    firstLock: "settleDueAddonsOnBudget(tx, budget.id",
    orderWrite: ".insert(orders)",
  },
]

describe("every live order asks the unacknowledged-delivery gate", () => {
  it.each(ORDER_CREATION_PATHS)(
    "$path calls it inside the transaction, after payment control, before the first lock and the write",
    ({ path, transactionBody, paymentGate, gateCall, firstLock, orderWrite }) => {
      const text = source(path)
      expect(text).toContain('from "@/lib/server/unacknowledged-delivery-block"')
      const bodyAt = text.indexOf(transactionBody)
      expect(bodyAt).toBeGreaterThan(-1)
      const paymentAt = text.indexOf(paymentGate, bodyAt)
      const gateAt = text.indexOf(gateCall, bodyAt)
      expect(paymentAt).toBeGreaterThan(bodyAt)
      expect(gateAt).toBeGreaterThan(paymentAt)
      expect(text.indexOf(firstLock, bodyAt)).toBeGreaterThan(gateAt)
      expect(text.indexOf(orderWrite, bodyAt)).toBeGreaterThan(gateAt)
    },
  )

  it("the single-branch route maps the refusal to a stable 409 with the code, never a 500", () => {
    const text = source("app/api/v1/orders/route.ts")
    expect(text).toContain("isDeliveryAcknowledgementBlockedError(caughtError)")
    expect(text).toMatch(/code: caughtError\.code, deliveryAcknowledgement: caughtError\.details \},\n\s*\{ status: 409 \}/)
  })

  it("the group route reports it per branch, in the user-facing reason, tagged with the code and count", () => {
    const text = source("lib/server/group-order-creation.ts")
    expect(text).toContain("if (isDeliveryAcknowledgementBlockedError(caughtError)) return caughtError.message")
    expect(text).toMatch(/isDeliveryAcknowledgementBlockedError\(branchError\)\s*\?\s*\{ code: branchError\.code, unacknowledgedDeliveryCount: branchError\.details\.unacknowledgedCount \}/)
  })

  it("editing a pending order is not gated — the PATCH path never calls it", () => {
    const text = source("app/api/v1/orders/route.ts")
    const gateCalls = text.match(/assertBranchDeliveriesAcknowledged\(/g) ?? []
    expect(gateCalls).toHaveLength(1)
  })
})

describe("the server module", () => {
  const moduleSource = source("lib/server/unacknowledged-delivery-block.ts")

  it("is server-only", () => {
    expect(moduleSource.startsWith('import "server-only"')).toBe(true)
  })

  it("reads the toggle first and counts nothing when it is off", () => {
    const toggleAt = moduleSource.indexOf("organizations.blockOrderingOnUnacknowledgedDeliveries")
    const offAt = moduleSource.indexOf("if (organization?.enabled !== true)")
    const countAt = moduleSource.indexOf(".from(orders)")
    expect(toggleAt).toBeGreaterThan(-1)
    expect(offAt).toBeGreaterThan(toggleAt)
    expect(countAt).toBeGreaterThan(offAt)
  })

  it("counts with the dashboard's own predicate, fenced by organization and branch", () => {
    expect(moduleSource).toContain('viewerStatusBucketCondition("DELIVERED_UNACKNOWLEDGED")')
    expect(moduleSource).toContain("eq(orders.organizationId, scope.organizationId)")
    expect(moduleSource).toContain("eq(orders.branchId, scope.branchId)")
  })

  it("never narrows to the creator or away from group orders", () => {
    expect(moduleSource).not.toMatch(/createdByUserId|groupOrderId/)
  })

  it("decides through the pure rule and nowhere else", () => {
    expect(moduleSource).toContain("resolveDeliveryAcknowledgement(")
    expect(moduleSource).not.toMatch(/unacknowledgedCount\s*>=|total\s*>=/)
  })
})

describe("the pre-check route", () => {
  const route = source("app/api/v1/orders/delivery-acknowledgement/route.ts")

  it("exposes GET only", () => {
    expect(route).toContain("export async function GET")
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/)
  })

  it("is fenced like the payment-control status read, then by the branch row's tenant", () => {
    const roleAt = route.indexOf("requireApiRole(")
    const fenceAt = route.indexOf("resolveViewableBranch({")
    const tenantAt = route.indexOf("branch.organizationId !== scope.organizationId")
    const readAt = route.indexOf("resolveBranchDeliveryAcknowledgement(db")
    expect(roleAt).toBeGreaterThan(-1)
    expect(fenceAt).toBeGreaterThan(roleAt)
    expect(tenantAt).toBeGreaterThan(fenceAt)
    expect(readAt).toBeGreaterThan(tenantAt)
    expect(route).toContain("sessionBranchId: scope.branchId")
  })

  it("is never cached by a shared cache", () => {
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"')
  })
})

describe("the toggle is Super Admin's alone", () => {
  it.each([
    ["app/api/v1/organizations/route.ts", "export async function POST"],
    ["app/api/v1/organizations/[id]/route.ts", "export async function PATCH"],
  ])("%s writes it only behind a Super Admin gate", (path, handler) => {
    const text = source(path)
    const handlerAt = text.indexOf(handler)
    const gateAt = text.indexOf('requireApiRole(["SUPER_ADMIN"])', handlerAt)
    const writeAt = text.indexOf("blockOrderingOnUnacknowledgedDeliveries", handlerAt)
    expect(handlerAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(handlerAt)
    expect(writeAt).toBeGreaterThan(gateAt)
  })

  it("no other route writes the column", () => {
    for (const path of [
      "app/api/v1/organizations/[id]/network-policy/route.ts",
      "app/api/v1/settings/route.ts",
    ]) {
      expect(source(path)).not.toContain("blockOrderingOnUnacknowledgedDeliveries")
    }
  })

  it("a change is audited with what it replaced, in the same transaction", () => {
    const text = source("app/api/v1/organizations/[id]/route.ts")
    const patchAt = text.indexOf("export async function PATCH")
    const txAt = text.indexOf("db.transaction(async (tx) => {", patchAt)
    const txEnd = text.indexOf("return { kind: \"updated\", item: updatedOrganization } as const", txAt)
    // The helper is handed the transaction, inside it, before it returns.
    const callAt = text.indexOf("await auditOrderingBlockToggles(tx, {", txAt)
    expect(callAt).toBeGreaterThan(txAt)
    expect(callAt).toBeLessThan(txEnd)
    // And it writes through that `tx`, never through the pool.
    const helper = text.slice(text.indexOf("async function auditOrderingBlockToggles("))
    expect(helper).toContain("action: UNACKNOWLEDGED_DELIVERY_ORDERING_BLOCK_AUDIT_ACTION")
    expect(helper).toContain("await tx.insert(auditLogs)")
    expect(helper.slice(0, helper.indexOf("\n}\n"))).not.toContain("db.insert(")
    expect(text).toContain("previousBlockOrderingOnUnacknowledgedDeliveries: existingOrganization.blockOrderingOnUnacknowledgedDeliveries")
  })
})

describe("the popup is raised on both ordering pages", () => {
  it("the Order Portal checks before submitting and turns the server's 409 into the popup", () => {
    const text = source("app/shop/page.tsx")
    expect(text).toContain("await checkDeliveryAcknowledgementBlock(branchForCheck)")
    expect(text).toContain("parseUnacknowledgedDeliveriesResponse(res.status, json)")
    expect(text).toContain("<UnacknowledgedDeliveriesDialog")
  })

  it("the Group Order Portal raises it for every location refused, after any unpaid-invoices popup", () => {
    const text = source("components/group-portal/storefront/group-storefront.tsx")
    expect(text).toContain("setUnacknowledgedDeliveriesNotice(noticeForGroupResults(body.item?.results))")
    expect(text).toContain("notice={unpaidInvoicesNotice ? null : unacknowledgedDeliveriesNotice}")
  })
})

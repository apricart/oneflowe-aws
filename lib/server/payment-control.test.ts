import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Contract tests for the payment-control gate and its routes.
 *
 * The decision itself is exercised in `lib/payment-control-policy.test.ts`
 * and against Postgres in `tests/integration/payment-control-api.test.ts`.
 * These pin the *shape*: that every path creating a live order asks the gate
 * first, inside its transaction, before any lock or write; that the overdue
 * count comes from the one seam; and that the routes check things in the
 * required order. A new order-creation path belongs on the list below.
 */
const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

const ORDER_CREATION_PATHS = [
  {
    path: "app/api/v1/orders/route.ts",
    transactionBody: "async function processOrderCreationTransaction(tx: any, context: any) {",
    gateCall: "await assertBranchMayOrder(tx, { organizationId: context.organizationId, branchId: context.branchId })",
    firstLock: "lockCreationMoneyBudget(tx, context)",
    orderWrite: "return persistCreatedOrder(tx, {",
  },
  {
    path: "lib/server/group-order-creation.ts",
    transactionBody: "const created = await db.transaction(async (tx) => {",
    gateCall: "await assertBranchMayOrder(tx, { organizationId, branchId })",
    firstLock: "settleDueAddonsOnBudget(tx, budget.id",
    orderWrite: ".insert(orders)",
  },
]

describe("every live order asks the payment-control gate first", () => {
  it.each(ORDER_CREATION_PATHS)(
    "$path calls the gate inside the transaction, before its first lock and before the order is written",
    ({ path, transactionBody, gateCall, firstLock, orderWrite }) => {
      const text = source(path)
      expect(text).toContain('from "@/lib/server/payment-control"')
      const bodyAt = text.indexOf(transactionBody)
      expect(bodyAt).toBeGreaterThan(-1)
      const gateAt = text.indexOf(gateCall, bodyAt)
      expect(gateAt).toBeGreaterThan(bodyAt)
      const lockAt = text.indexOf(firstLock, bodyAt)
      expect(lockAt).toBeGreaterThan(gateAt)
      const writeAt = text.indexOf(orderWrite, bodyAt)
      expect(writeAt).toBeGreaterThan(gateAt)
    },
  )

  it("the single-branch route maps the refusal to a stable 409 with the code, never a 500", () => {
    const text = source("app/api/v1/orders/route.ts")
    expect(text).toContain("isPaymentControlBlockedError(caughtError)")
    expect(text).toMatch(/code: caughtError\.code, paymentControl: caughtError\.details \},\n\s*\{ status: 409 \}/)
  })

  it("the group route reports the refusal per branch, in the user-facing reason", () => {
    const text = source("lib/server/group-order-creation.ts")
    expect(text).toContain("if (isPaymentControlBlockedError(caughtError)) return caughtError.message")
  })
})

describe("the server module", () => {
  const moduleSource = source("lib/server/payment-control.ts")

  it("is server-only and reads the overdue count from the one seam", () => {
    expect(moduleSource.startsWith('import "server-only"')).toBe(true)
    expect(moduleSource).toContain('from "./overdue-payment-source"')
    expect(moduleSource).toContain("await overduePaymentSource(client, scope, now)")
    expect(moduleSource).not.toMatch(/paymentStatus|payment_status/)
  })

  it("decides through the pure policy and nowhere else", () => {
    expect(moduleSource).toContain("resolvePaymentControl({ overdue, exception, now })")
    expect(moduleSource).not.toMatch(/overdueCount\s*>=/)
  })

  it("serializes grants on the branch row and refuses a second live exception", () => {
    const grantAt = moduleSource.indexOf("export async function grantPaymentControlException")
    const lockAt = moduleSource.indexOf('.for("update")', grantAt)
    const liveAt = moduleSource.indexOf("loadLiveException(tx, branch.id, now)", grantAt)
    const insertAt = moduleSource.indexOf(".insert(paymentControlExceptions)", grantAt)
    expect(lockAt).toBeGreaterThan(grantAt)
    expect(liveAt).toBeGreaterThan(lockAt)
    expect(insertAt).toBeGreaterThan(liveAt)
  })

  it("audits the grant and the revoke in the same transaction as the write", () => {
    for (const action of ["GRANT_PAYMENT_CONTROL_EXCEPTION", "REVOKE_PAYMENT_CONTROL_EXCEPTION"]) {
      expect(moduleSource).toContain(action)
    }
    expect(moduleSource.match(/tx\.insert\(auditLogs\)/g)?.length).toBe(2)
  })

  it("takes the window from the policy, never from a caller", () => {
    expect(moduleSource).toContain("const window = exceptionWindowFrom(now)")
    expect(moduleSource).not.toMatch(/input\.expiresAt|input\.startAt/)
  })
})

describe("the seam", () => {
  const seam = source("lib/server/overdue-payment-source.ts")

  it("is server-only and returns the not-configured answer until a source is agreed", () => {
    expect(seam.startsWith('import "server-only"')).toBe(true)
    expect(seam).toContain("export const overduePaymentSource: OverduePaymentSource = async () => NOT_CONFIGURED_OVERDUE_SUMMARY")
  })
})

describe("the routes", () => {
  it("the status read admits every ordering and managing role and fences the branch through the access module", () => {
    const text = source("app/api/v1/payment-control/route.ts")
    expect(text).toContain('requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])')
    expect(text).toContain("resolveViewableBranch({")
    expect(text).toContain("resolveScopedBranchIds(db, scope.userId)")
    expect(text).toContain('if (scope.role !== "SUPER_ADMIN" && branch.organizationId !== scope.organizationId) return error("Branch not found", 404)')
    expect(text).not.toContain("auditLogs")
    expect(text).toContain('"Cache-Control": "private, no-store, max-age=0"')
  })

  it.each([
    "app/api/v1/payment-control/exceptions/route.ts",
    "app/api/v1/payment-control/exceptions/[id]/revoke/route.ts",
  ])("%s is Super Admin / Head Office only, rate-limited, Zod-validated, tenant-pinned from the session", (path) => {
    const text = source(path)
    const gateAt = text.indexOf('requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])')
    const rateAt = text.indexOf('withRateLimit("sensitive", scope.userId)')
    const parseAt = text.indexOf(".safeParse(")
    const workAt = text.indexOf("db.transaction(")
    expect(gateAt).toBeGreaterThan(-1)
    expect(rateAt).toBeGreaterThan(gateAt)
    expect(parseAt).toBeGreaterThan(rateAt)
    expect(workAt).toBeGreaterThan(parseAt)
    expect(text).toContain("canManagePaymentControlExceptions(scope.role)")
    expect(text).toContain('const organizationId = scope.role === "SUPER_ADMIN" ? null : scope.organizationId')
    expect(text).not.toMatch(/body\.organizationId|parsed\.data\.organizationId|parsed\.data\.expiresAt/)
  })
})

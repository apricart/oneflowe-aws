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

  it("the group route tags a refused branch with the code and count, so the storefront can raise the popup", () => {
    const text = source("lib/server/group-order-creation.ts")
    expect(text).toMatch(/isPaymentControlBlockedError\(branchError\)\s*\?\s*\{ code: branchError\.code, unpaidInvoiceCount: branchError\.details\.overdueCount \}/)
  })
})

describe("the unpaid-invoices popup is raised on both ordering pages", () => {
  it("the Order Portal checks before submitting and turns the server's 409 into the popup", () => {
    const text = source("app/shop/page.tsx")
    expect(text).toContain("await checkOrderingBlock(")
    expect(text).toContain("parseOrderingBlockedResponse(res.status, json)")
    expect(text).toContain("<UnpaidInvoicesDialog")
  })

  it("the Group Order Portal raises it for every location refused for unpaid invoices", () => {
    const text = source("components/group-portal/storefront/group-storefront.tsx")
    expect(text).toContain("setUnpaidInvoicesNotice(noticeForBlockedBranches(blockedBranchesOf(body.item?.results)))")
    expect(text).toContain("<UnpaidInvoicesDialog")
  })
})

describe("the unpaid-invoice toggle is Super Admin's alone", () => {
  it.each([
    ["app/api/v1/organizations/route.ts", "export async function POST"],
    ["app/api/v1/organizations/[id]/route.ts", "export async function PATCH"],
  ])("%s writes it only behind a Super Admin gate", (path, handler) => {
    const text = source(path)
    const handlerAt = text.indexOf(handler)
    const gateAt = text.indexOf('requireApiRole(["SUPER_ADMIN"])', handlerAt)
    const writeAt = text.indexOf("blockOrderingOnUnpaidInvoices", handlerAt)
    expect(handlerAt).toBeGreaterThan(-1)
    expect(gateAt).toBeGreaterThan(handlerAt)
    expect(writeAt).toBeGreaterThan(gateAt)
  })

  it("no other route writes the column", () => {
    const writers = [
      "app/api/v1/organizations/[id]/network-policy/route.ts",
      "app/api/v1/settings/route.ts",
    ]
    for (const path of writers) expect(source(path)).not.toContain("blockOrderingOnUnpaidInvoices")
  })

  it("a change is audited with what it replaced, in the same transaction", () => {
    const text = source("app/api/v1/organizations/[id]/route.ts")
    const txAt = text.indexOf("db.transaction(")
    const auditAt = text.indexOf("action: UNPAID_INVOICE_ORDERING_BLOCK_AUDIT_ACTION")
    expect(auditAt).toBeGreaterThan(txAt)
    expect(text).toContain("previousBlockOrderingOnUnpaidInvoices: existingOrganization.blockOrderingOnUnpaidInvoices")
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

  it("decides through the pure policy and nowhere else, at the limit the seam read", () => {
    expect(moduleSource).toContain("resolvePaymentControl({ overdue, exception, now, threshold: overdue.blockThreshold })")
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

  // plans/OF-PAYMENT-CONTROL-head-office-ordering-blocks-page.md
  it("grants nothing in an organization whose unpaid-invoice block is off, judged on the locked branch's tenant", () => {
    const grantAt = moduleSource.indexOf("export async function grantPaymentControlException")
    const lockAt = moduleSource.indexOf('.for("update")', grantAt)
    const toggleAt = moduleSource.indexOf("loadUnpaidInvoiceBlockConfig(tx, branch.organizationId)", grantAt)
    const refusedAt = moduleSource.indexOf('return { kind: "block_disabled" }', grantAt)
    const insertAt = moduleSource.indexOf(".insert(paymentControlExceptions)", grantAt)
    expect(toggleAt).toBeGreaterThan(lockAt)
    expect(refusedAt).toBeGreaterThan(toggleAt)
    expect(insertAt).toBeGreaterThan(refusedAt)
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

// The seam used to return "not configured" unconditionally. It is now
// connected, behind a Super Admin toggle per organization
// (plans/OF-PAYMENT-CONTROL-unpaid-invoice-ordering-block.md); what it does
// against Postgres is in tests/integration/unpaid-invoice-ordering-block.test.ts.
describe("the seam", () => {
  const seam = source("lib/server/overdue-payment-source.ts")
  const body = seam.slice(seam.indexOf("export const overduePaymentSource"))
  // The toggle read and the invoice predicate are shared with the unpaid-invoice
  // alerts (plans/OF-PAYMENT-CONTROL-unpaid-invoice-alerts.md), so they live in
  // their own functions; the seam must still go through both.
  const config = seam.slice(
    seam.indexOf("export async function loadUnpaidInvoiceBlockConfig"),
    seam.indexOf("export function unpaidInvoiceOrdersOf"),
  )
  const predicate = seam.slice(
    seam.indexOf("export function unpaidInvoiceOrdersOf"),
    seam.indexOf("export const overduePaymentSource"),
  )

  it("is server-only", () => {
    expect(seam.startsWith('import "server-only"')).toBe(true)
  })

  it("reads the organization's toggle first and answers not-configured while it is off", () => {
    const toggleAt = config.indexOf("organizations.blockOrderingOnUnpaidInvoices")
    expect(toggleAt).toBeGreaterThan(-1)
    expect(config.indexOf("if (organization?.enabled !== true) return null")).toBeGreaterThan(toggleAt)

    const readAt = body.indexOf("const config = await loadUnpaidInvoiceBlockConfig(client, scope.organizationId)")
    const offAt = body.indexOf("if (!config) return NOT_CONFIGURED_OVERDUE_SUMMARY")
    const ordersAt = body.indexOf(".from(orders)")
    expect(readAt).toBeGreaterThan(-1)
    expect(offAt).toBeGreaterThan(readAt)
    expect(ordersAt).toBeGreaterThan(offAt)
  })

  it("counts only the gate's own tenant and branch, never a value from a request", () => {
    expect(predicate).toContain("eq(orders.organizationId, organizationId)")
    expect(body).toContain("unpaidInvoiceOrdersOf(scope.organizationId)")
    expect(body).toContain("eq(orders.branchId, scope.branchId)")
    expect(config).toContain("eq(organizations.id, organizationId)")
  })

  it("counts exactly the invoices the Paid/Unpaid control can clear", () => {
    expect(predicate).toContain("eq(orders.status, UNPAID_INVOICE_ORDER_STATUS)")
    expect(predicate).toContain("eq(orders.fulfillmentStatus, UNPAID_INVOICE_FULFILLMENT_STATUS)")
    expect(predicate).toContain("eq(orders.paymentStatus, UNPAID_INVOICE_PAYMENT_STATUS)")
    expect(predicate).toContain("isNotNull(orders.receiptData)")
    expect(predicate).toContain("orderStillOwesSql")
  })

  it("never selects an amount: the status route is readable where prices are hidden", () => {
    expect(body).not.toMatch(/totalCents|subtotalCents|taxCents|refundAmountCents/)
    expect(body).toContain("amountCents: null")
  })

  it("lists a bounded number of invoices — at least the organization's limit, so the date it was reached is known", () => {
    expect(body).toContain("const itemsLimit = Math.max(UNPAID_INVOICE_ITEMS_LIMIT, blockThreshold)")
    expect(body).toContain(".limit(itemsLimit)")
  })

  // plans/OF-ORDERING-BLOCK-configurable-thresholds.md
  it("reads the organization's own limit from the same row as the toggle, never from a request", () => {
    const selectAt = config.indexOf(".select({")
    const thresholdAt = config.indexOf("threshold: organizations.unpaidInvoiceBlockThreshold")
    const fromAt = config.indexOf(".from(organizations)")
    expect(thresholdAt).toBeGreaterThan(selectAt)
    expect(fromAt).toBeGreaterThan(thresholdAt)
    expect(config).toContain("return { threshold: orderingBlockThresholdOrDefault(organization.threshold) }")
    expect(body).toContain("const blockThreshold = config.threshold")
    expect(body).toContain("blockThreshold,")
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

  it("the Ordering Blocks list is Head Office only, its organization from the session, and reads through the shared seam", () => {
    const text = source("app/api/v1/payment-control/branches/route.ts")
    expect(text).toContain('requireApiRole(["HEAD_OFFICE"])')
    expect(text).toContain("organizationId: scope.organizationId,")
    expect(text).toContain("orderingBlockBranchesQuerySchema.safeParse(")
    expect(text).not.toContain("auditLogs")
    expect(text).toContain('"Cache-Control": "private, no-store, max-age=0"')

    const loader = source("lib/server/ordering-block-branches.ts")
    expect(loader.startsWith('import "server-only"')).toBe(true)
    const configAt = loader.indexOf("await loadUnpaidInvoiceBlockConfig(client, input.organizationId)")
    const offAt = loader.indexOf("if (!config) return ORDERING_BLOCKS_DISABLED")
    const countAt = loader.indexOf(".from(branches)")
    expect(configAt).toBeGreaterThan(-1)
    expect(offAt).toBeGreaterThan(configAt)
    expect(countAt).toBeGreaterThan(offAt)
    expect(loader).toContain("unpaidInvoiceOrdersOf(input.organizationId)")
    expect(loader).toContain("eq(branches.organizationId, input.organizationId)")
    expect(loader).toContain("eq(paymentControlExceptions.organizationId, input.organizationId)")
    expect(loader).not.toMatch(/totalCents|amountCents/)
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

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Structural guarantees of the Order Desk that a behavioural test cannot see:
 * the order things happen in, and the paths that are never taken. The
 * behaviour itself is carried by `tests/integration/order-desk-api.test.ts`.
 * See plans/OF-ORDER-DESK-internal-order-entry.md.
 */
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("creating an order", () => {
  const route = source("app/api/v1/orders/route.ts")
  const post = route.slice(route.indexOf("export async function POST"), route.indexOf("export async function PUT"))

  it("refuses a role outside the creation list before it reads anything", () => {
    const gate = post.indexOf("if (!mayCreateOrder(role))")
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(post.indexOf('withRateLimit("order"'))
    expect(gate).toBeLessThan(post.indexOf("req.json()"))
  })

  it("checks the desk's reach before reading the catalogue, and again under lock", () => {
    const preCheck = post.indexOf("await orderDeskCreationRefusal(role, {")
    expect(preCheck).toBeGreaterThan(-1)
    expect(preCheck).toBeLessThan(post.indexOf("loadCreationInventory("))
    expect(route).toMatch(/async function orderDeskCreationRefusal[\s\S]*?isOrderDeskTarget\(db, \{ userId: input\.userId/)

    const transaction = route.slice(route.indexOf("async function processOrderCreationTransaction"))
    const lockedCheck = transaction.indexOf("isOrderDeskTarget(tx, {")
    expect(lockedCheck).toBeGreaterThan(-1)
    expect(transaction.slice(lockedCheck, lockedCheck + 200)).toContain("lock: true")
    // Before the payment gate, and so before any lock on a budget or a product.
    expect(lockedCheck).toBeLessThan(transaction.indexOf("assertBranchMayOrder(tx"))
  })

  it("never lets a desk session fall back to an organization of its own", () => {
    expect(route).toMatch(/if \(isOrderDeskRole\(role\)\) \{\s*return requestedOrganizationId && Number\.isFinite\(requestedOrganizationId\)/)
  })

  it("passes the creator to the approval resolver, so only the creator's role can skip approval", () => {
    expect(route).toMatch(/resolveInitialOrderApproval\(tx, context\.organizationId, new Date\(\), \{\s*role: context\.role,\s*userId: context\.userId,/)
  })

  it("validates the intake details against the role before writing them", () => {
    expect(route).toMatch(/async function orderDeskCreationRefusal[\s\S]*?const intakeError = orderIntakeError\(role, input\)/)
    expect(post.indexOf("await orderDeskCreationRefusal(role, {")).toBeLessThan(post.indexOf("db.transaction"))
  })
})

describe("the desk's own order actions", () => {
  const service = source("lib/server/order-desk-orders.ts")
  const edit = source("lib/server/order-desk-edit.ts")

  it("reads every order through the desk's live reach", () => {
    expect(service).toContain('loadOrderDeskReach(client, userId, "manage")')
    // The list builds its filter from the reach first, then only narrows it.
    expect(service).toContain("const conditions: SQL[] = [orderDeskOrderCondition(reach)]")
    expect(service).toContain("const scopeWhere = and(...conditions)")
    expect(service).toContain("const where = tab ? and(scopeWhere, tab) : scopeWhere")
    // Every read of `orders` is filtered by that list's `where`, or by the reach directly.
    for (const text of [service, edit]) {
      const reads = text.split(".from(orders)").slice(1)
      expect(reads.length).toBeGreaterThan(0)
      for (const after of reads) {
        const nextWhere = after.slice(0, after.indexOf(".where(") + 140)
        // `scopeWhere` is the list's reach-and-filters condition without the tab,
        // which the per-tab counts read; `where` is the same plus the tab.
        expect(nextWhere).toMatch(/\.where\((scopeW|w)here\)|\.where\(and\(eq\(orders\.id, (input\.)?orderId\), orderDeskOrderCondition\(reach\)\)\)/)
      }
    }
  })

  it("never records a delivery: that stays with Super Admin", () => {
    for (const text of [service, edit]) {
      expect(text).not.toContain("transitionOrderFulfillmentStatusColumn")
      expect(text).not.toContain("updateOrderFulfillmentStatusColumn")
      expect(text).not.toMatch(/fulfillmentStatus:\s*"/)
    }
    expect(existsSync(resolve(process.cwd(), "app/api/v1/order-desk/orders/[id]/delivery/route.ts"))).toBe(false)
  })

  it("fulfils only through fulfillApprovedOrder, and only cancels by writing a status itself", () => {
    expect(service).toContain("fulfillApprovedOrder({")
    expect(service).not.toMatch(/status:\s*"FULFILLED"/)
    expect(edit).not.toMatch(/status:\s*"/)
    // The cancel claims a pending or an Active order not yet in process — before
    // its tax invoice is issued (plans/OF-INVOICE-issue-at-processing.md) — in
    // the status it read under lock. The edit claims a pending order only: since
    // every desk order waits for an Apricart Executive, an edit after approval
    // would change what was approved
    // (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
    expect(service).toContain('const CANCELLABLE_STATUSES = ["PENDING", "APPROVED"]')
    expect(service).toContain("sql`UPPER(${orders.status}) = ${previousStatus}`")
    expect(service).toContain("sql`COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED') IN (${CANCELLABLE_STAGES_SQL})`")
    expect(service).toContain("STAGES_BEFORE_TAX_INVOICE.map(")
    expect(edit).toContain("sql`UPPER(${orders.status}) = 'PENDING'`")
    expect(edit).not.toContain("'APPROVED'")
  })

  it("releases and moves ledgers by the order's own period, and only for an order that took a hold", () => {
    for (const text of [service, edit]) {
      expect(text).toContain("orderTakesBudget(")
      expect(text).toContain("budgetPeriodOf(")
    }
    expect(service).toContain("gte(budgets.amountHeldCents, cancelled.totalCents)")
    expect(service).toContain("releaseHeldQuantityBudgetForOrder(tx, cancelled)")
  })

  it("re-prices an edit through the ladder and re-checks the desk can still order there", () => {
    expect(edit).toContain("resolveEffectivePriceCents({")
    expect(edit).toContain("isOrderDeskTarget(tx, {")
    expect(edit.indexOf("settleDueAddonsOnBudget(tx,")).toBeLessThan(edit.indexOf("lockedBudget.amountAllocatedCents + "))
  })
})

describe("the customer's screenshot", () => {
  it("is stored privately and never reachable through the public image route", () => {
    const upload = source("app/api/v1/upload/image/route.ts")
    expect(upload).toContain("buildOrderIntakeAttachmentKey(extension)")
    expect(upload).toContain('action: "UPLOAD_ORDER_INTAKE_ATTACHMENT"')
    // A desk upload never falls back to a data: URL, even in development.
    const deskBranch = upload.slice(upload.indexOf("async function storeOrderIntakeAttachment"))
    expect(deskBranch).not.toContain("data:")
    expect(upload.indexOf("return storeOrderIntakeAttachment(")).toBeLessThan(upload.indexOf("// Never silently fall back"))
  })

  it("is read back only by order id, behind the reader's reach, never cached", () => {
    // The desk through its own reach; an Apricart Executive through its
    // approval reach (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
    // Both stream it through the one helper that sets the headers.
    const desk = source("app/api/v1/order-desk/orders/[id]/attachment/route.ts")
    expect(desk).toContain('requireApiRole(["ORDER_DESK"])')
    expect(desk).toContain("loadDeskOrder(db, user.id, orderId)")
    const executive = source("app/api/v1/executive/approvals/[id]/attachment/route.ts")
    expect(executive).toContain('requireApiRole(["APRICART_EXECUTIVE"])')
    expect(executive).toContain("loadExecutiveApprovalOrder(user.id, orderId)")
    for (const route of [desk, executive]) {
      expect(route).toContain("intakeAttachmentResponse(order.intakeAttachmentKey)")
      expect(route).not.toContain("getImage(")
    }
    const helper = source("lib/server/order-desk-attachments.ts")
    expect(helper).toContain('"Cache-Control": "private, no-store, max-age=0"')
    expect(helper).toContain("if (!isOrderIntakeAttachmentKey(key)) return NextResponse.json")
  })

  it("is required, and bound to its uploader and to one order when the order is created", () => {
    const route = source("app/api/v1/orders/route.ts")
    // Checked on every desk order, never only when a key happens to be sent.
    expect(route).toMatch(/const attachmentError = await deskAttachmentRefusal\(\{\s*userId: input\.userId,\s*key: input\.intakeAttachmentKey \?\? "",\s*idempotencyKey: input\.idempotencyKey,\s*\}\)/)
    const binding = source("lib/server/order-desk-attachments.ts")
    expect(binding).toContain("eq(auditLogs.userId, input.userId)")
    expect(binding).toContain("eq(orders.intakeAttachmentKey, input.key)")
    // The only order allowed to hold the key already is this same submission's
    // own (a retry), which the route then answers through its replay check.
    expect(binding).toContain("existing.createdByUserId === input.userId && existing.idempotencyKey === input.idempotencyKey")
  })

  it("lets a duplicate submission find its twin before reporting a screenshot conflict", () => {
    const route = source("app/api/v1/orders/route.ts")
    const handler = route.slice(route.indexOf("async function getOrderCreationErrorResponse"))
    // Drizzle puts the driver's error on `cause`; the code is read from both.
    expect(handler).toContain('String(caughtError?.code ?? caughtError?.cause?.code ?? "") === "23505"')
    expect(handler.indexOf("getOrderReplayResponse(existingOrder")).toBeGreaterThan(0)
    expect(handler.indexOf("getOrderReplayResponse(existingOrder"))
      .toBeLessThan(handler.indexOf('"orders_intake_attachment_key_uq"'))
  })
})

describe("the existing Super Admin fulfilment routes", () => {
  it("are untouched: still Super Admin only, still token-verified", () => {
    const fulfil = source("app/api/v1/orders/[id]/fulfill/route.ts")
    const progress = source("app/api/v1/orders/[id]/fulfillment-status/route.ts")
    expect(fulfil).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(progress).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(fulfil).not.toContain("ORDER_DESK")
    expect(progress).not.toContain("ORDER_DESK")
  })
})

describe("the schema", () => {
  it("adds the columns off by default and the grants in a table of their own", () => {
    const schema = source("db/schema.ts")
    const migration = source("drizzle/20261005120000_add_order_desk.sql")
    expect(schema).toMatch(/managedOrdering: boolean\("managed_ordering"\)\s*\.notNull\(\)\s*\.default\(false\)/)
    expect(migration).toContain('"managed_ordering" boolean NOT NULL DEFAULT false')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "order_desk_assignments"')
    // Never rows in the group roles' assignment tables.
    expect(source("lib/server/order-desk-scope.ts")).not.toContain("userBranchAssignments")
    expect(source("lib/server/order-desk-team.ts")).not.toContain("userBranchAssignments")
  })
})

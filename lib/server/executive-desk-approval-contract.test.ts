import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Structural guarantees of "Apricart Executives approve Order Desk orders"
 * (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md). The behaviour is
 * exercised end to end in tests/integration/executive-desk-approval-api.test.ts;
 * this holds the parts a later edit could quietly undo.
 */
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("who decides a desk order", () => {
  const policy = source("lib/server/order-decision-policy.ts")

  it("sends an executive down its own path before any tenant check", () => {
    const dispatch = policy.indexOf("if (isApricartExecutiveRole(input.scope.role)) {")
    expect(dispatch).toBeGreaterThan(-1)
    expect(dispatch).toBeLessThan(policy.indexOf("if (!canAttemptOrderDecision(input.scope.role)) {"))
    // The tenant roles' set never admits the executive.
    expect(policy).toContain('const ORDER_DECISION_ROLES = new Set<string>(["BRANCH_ADMIN", "HEAD_OFFICE", GROUP_USER_ROLE])')
  })

  it("refuses every tenant approver a desk order, on the deciding transaction", () => {
    const tenantPath = policy.slice(
      policy.indexOf("export async function authorizeOrderDecision"),
      policy.indexOf("async function authorizeExecutiveOrderDecision"),
    )
    expect(tenantPath).toContain('if (isDeskEnteredOrder(order)) return { ok: false, reason: "forbidden" }')
  })

  it("re-reads the executive's assignment under a share lock inside the transaction", () => {
    const executivePath = policy.slice(policy.indexOf("async function authorizeExecutiveOrderDecision"))
    expect(executivePath).toContain("loadExecutiveApprovalReach(tx, input.scope.userId, {")
    expect(executivePath).toContain("lock: true,")
    expect(executivePath).toContain("canExecutiveDecideOrder({")
    expect(executivePath).toContain('decisionRole: APRICART_EXECUTIVE_ROLE')
    const scope = source("lib/server/apricart-executive-scope.ts")
    expect(scope).toContain('options.lock ? await assignmentQuery.for("share") : await assignmentQuery')
    // The account row is re-read, never the session's claim.
    expect(scope).toContain("account.role !== APRICART_EXECUTIVE_ROLE")
  })

  it("decides through the shared service, so approve, reject and return audit alike", () => {
    expect(source("app/api/v1/executive/approvals/[id]/approve/route.ts")).toContain("approveOrder({")
    expect(source("app/api/v1/executive/approvals/[id]/reject/route.ts")).toContain("rejectOrder({")
    expect(source("app/api/v1/executive/approvals/[id]/return/route.ts")).toContain("returnOrderForCorrection({")
  })

  it("queues no tenant notice for an executive's decision", () => {
    const service = source("lib/server/order-decision-service.ts")
    expect(service.match(/decisionQueuesNotifications\(authorization\.decisionRole\)/g)).toHaveLength(2)
    expect(source("lib/server/order-correction.ts")).toContain("decisionQueuesNotifications(authorization.decisionRole)")
  })

  it("approves only the version the executive saw, when one is named", () => {
    const service = source("lib/server/order-decision-service.ts")
    expect(service).toContain("expectedUpdatedAt === undefined ? undefined : updatedAtMatches(expectedUpdatedAt),")
    expect(source("app/api/v1/executive/approvals/[id]/approve/route.ts")).toContain("expectedUpdatedAt:")
  })
})

describe("a desk order starts pending", () => {
  it("whatever the organization's own switch says", () => {
    const creation = source("lib/server/order-creation-approval.ts")
    const desk = creation.indexOf("if (creator && orderDeskRequiresExecutiveApproval(creator.role)) {")
    expect(desk).toBeGreaterThan(-1)
    expect(desk).toBeLessThan(creation.indexOf("if (organization.orderApprovalRequired !== false) {"))
    expect(creation).toContain("return { approvalRequired: true, values: pendingValues(), approvalBasis: DESK_ORDER_APPROVAL_BASIS }")
  })
})

describe("the customer's requesters keep off desk orders", () => {
  it("cannot edit one", () => {
    expect(source("app/api/v1/orders/[id]/route.ts"))
      .toContain("if (!canRequesterActOnOrder(writeActor, subject) || isDeskEnteredOrder(existingOrder)) {")
  })

  it("cannot resubmit one", () => {
    expect(source("lib/server/order-correction.ts")).toContain('if (isDeskEnteredOrder(order)) return { kind: "not-found" } as const')
  })
})

describe("the desk corrects its own orders", () => {
  it("edits only while pending, and resubmits through its own reach", () => {
    expect(source("lib/server/order-desk-edit.ts")).toContain('if (String(order.status).toUpperCase() !== "PENDING" || delivered) {')
    const orders = source("lib/server/order-desk-orders.ts")
    const resubmit = orders.slice(orders.indexOf("export async function resubmitDeskOrder"))
    expect(resubmit).toContain('loadOrderDeskReach(tx, input.actor.id, "manage")')
    expect(resubmit).toContain("orderDeskOrderCondition(reach)")
    expect(resubmit).toContain('.for("update")')
    expect(resubmit).toContain("isNotNull(orders.returnedForCorrectionAt),")
    // Never the requester path's notice, which tells the tenant's approvers.
    expect(resubmit).not.toContain("queueOrderResubmittedNotifications")
  })

  it("closes an open round when it cancels a returned order", () => {
    const orders = source("lib/server/order-desk-orders.ts")
    expect(orders).toContain('resolution: "CANCELLED",')
    expect(source("db/schema.ts")).toContain("IN ('RESUBMITTED', 'REJECTED', 'CANCELLED')")
    expect(source("drizzle/20261010120000_add_apricart_executive_order_approval.sql"))
      .toContain("IN ('RESUBMITTED', 'REJECTED', 'CANCELLED')")
  })
})

describe("assignments", () => {
  it("are Super Admin's alone, audited inside the replacement", () => {
    expect(source("app/api/v1/apricart-executives/route.ts")).toContain('requireApiRole(["SUPER_ADMIN"])')
    const put = source("app/api/v1/apricart-executives/[userId]/organizations/route.ts")
    expect(put).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(put).toContain("apricartExecutiveAssignmentsUpdateSchema.safeParse")
    const team = source("lib/server/apricart-executive-team.ts")
    expect(team).toContain("action: APRICART_EXECUTIVE_ASSIGNMENT_AUDIT_ACTION,")
    expect(team.indexOf("db.transaction")).toBeLessThan(team.indexOf("recordAuditEvent(tx"))
  })

  it("are a table of their own, unique per executive and organization", () => {
    const schema = source("db/schema.ts")
    expect(schema).toContain('"apricart_executive_assignments"')
    expect(schema).toContain('uniqueIndex("apricart_executive_assignments_user_org_uq").on(t.userId, t.organizationId)')
    const journal = JSON.parse(source("drizzle/meta/_journal.json")) as { entries: { tag: string; when: number }[] }
    const entry = journal.entries.find((candidate) => candidate.tag === "20261010120000_add_apricart_executive_order_approval")
    expect(entry).toBeDefined()
    // Ordered after every earlier migration, or the runner skips it.
    const before = journal.entries.filter((candidate) => candidate.tag < entry!.tag)
    expect(Math.max(...before.map((candidate) => candidate.when))).toBeLessThan(entry!.when)
  })
})

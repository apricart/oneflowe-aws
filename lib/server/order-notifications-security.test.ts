import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order lifecycle notification security contracts", () => {
  it("selects the configured approver by exact tenant and role with branch scope for Branch Admin", () => {
    const service = source("lib/server/order-notifications.ts")
    expect(service).toContain("eq(roles.name, approverRole)")
    expect(service).toContain('approverRole === "BRANCH_ADMIN" ? eq(users.branchId, order.branchId) : undefined')
    expect(service).toContain("eq(users.organizationId, order.organizationId)")
    expect(service).toContain("eq(users.branchId, order.branchId)")
    expect(service).toContain("eq(users.isActive, true)")
    expect(service).toContain("isNull(users.deletedAt)")
  })

  it("notifies only the scoped Order Portal creator after a decision", () => {
    const service = source("lib/server/order-notifications.ts")
    expect(service).toContain("eq(users.id, order.createdByUserId)")
    expect(service).toContain('eq(roles.name, "ORDER_PORTAL")')
    expect(service).toContain('recipient?.orderCreatorId === row.recipientUserId')
    expect(service).toContain("eq(orders.organizationId, row.organizationId)")
    expect(service).toContain("eq(orders.branchId, row.branchId)")
  })

  it("notifies global Super Admins after either configured approver role approves", () => {
    const service = source("lib/server/order-notifications.ts")
    // The approve transition lives in the shared decision service that both the
    // single-order route and the multi-branch bulk endpoint call.
    const decisionService = source("lib/server/order-decision-service.ts")
    expect(service).toContain("queueSuperAdminApprovalNotifications")
    expect(service).toContain('eq(roles.name, "SUPER_ADMIN")')
    expect(service).toContain("eq(roles.name, input.approvedByRole)")
    expect(service).toContain('template: "ORDER_APPROVED_ADMIN"')
    expect(service).toContain('row.recipientRole === "SUPER_ADMIN"')
    expect(decisionService).toContain("approvedByRole: authorization.decisionRole")
    expect(decisionService).toContain("queueSuperAdminApprovalNotifications(tx")
  })

  it("queues lifecycle events inside the winning business transaction", () => {
    const createRoute = source("app/api/v1/orders/route.ts")
    const decisionService = source("lib/server/order-decision-service.ts")

    const approveBody = decisionService.slice(decisionService.indexOf("export async function approveOrder"))
    const rejectBody = decisionService.slice(decisionService.indexOf("export async function rejectOrder"))

    expect(createRoute).toContain('role === "ORDER_PORTAL"')
    expect(createRoute.indexOf("queueOrderCreatedNotifications(tx")).toBeGreaterThan(createRoute.indexOf("db.transaction"))
    expect(approveBody.indexOf("queueOrderDecisionNotification(tx")).toBeGreaterThan(approveBody.indexOf("tx.update(orders)"))
    expect(rejectBody.indexOf("queueOrderDecisionNotification(tx")).toBeGreaterThan(rejectBody.indexOf("tx.update(orders)"))
    expect(approveBody).toContain("UPPER(${orders.status}) = 'PENDING'")
    expect(rejectBody).toContain("UPPER(${orders.status}) = 'PENDING'")
  })

  it("deduplicates both notification and email events at the database boundary", () => {
    const migration = source("drizzle/20260721120000_add_order_notification_outbox.sql")
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_key_uq"')
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "email_outbox_event_key_uq"')
    expect(migration).toContain('ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY')
    expect(migration).toContain('REVOKE ALL ON TABLE "email_outbox" FROM authenticated')
  })

  it("revalidates the current recipient and sends one address per email", () => {
    const service = source("lib/server/order-notifications.ts")
    const email = source("lib/email/order-lifecycle.ts")
    expect(service).toContain("eq(users.id, row.recipientUserId)")
    expect(service).toContain("eq(roles.name, row.recipientRole)")
    expect(service).toContain('row.recipientRole === "HEAD_OFFICE"')
    expect(service).toContain("eq(organizations.orderApproverRole, row.recipientRole)")
    expect(service).toContain("to: recipient.email")
    expect(email).toContain("to: string")
    expect(email).toContain('payload.approvedByRole === "HEAD_OFFICE"')
    expect(email).not.toContain("approvalToken")
    expect(email).not.toContain("approvalTokenHash")
  })

  it("scopes notification reads and read-state updates to the current role and tenant context", () => {
    const route = source("app/api/v1/notifications/route.ts")
    expect(route).toContain("scopedNotificationConditions(session, userId)")
    expect(route).toContain("eq(notifications.organizationId, organizationId)")
    expect(route).toContain("eq(notifications.branchId, branchId)")
    expect(route).toContain("eq(notifications.targetRole, role)")
    expect(route.match(/where\(and\(\.\.\.scopeConditions\)\)/g)).toHaveLength(2)
  })

  it("keeps Order Portal notification polling away from admin-only endpoints", () => {
    const hook = source("lib/hooks/use-dashboard-notifications.ts")
    const shop = source("app/shop/page.tsx")
    expect(hook).toContain("if (!isAdminRole) return null")
    expect(hook).toContain('role === "HEAD_OFFICE"')
    expect(shop).toContain("isOrderPortal && <NotificationBell />")
  })

  it("deep-links a single pending order and keeps aggregate notifications on the scoped list", () => {
    const hook = source("lib/hooks/use-dashboard-notifications.ts")
    const ordersPage = source("app/(portal)/orders/page.tsx")

    expect(hook).toContain("getPendingOrderReviewHref(pendingOrders[0]?.id, pendingOrders.length)")
    expect(hook).toContain('label: isSinglePendingOrder ? "Review order" : "Review orders"')
    expect(hook).not.toContain("/head-office-orders")
    expect(ordersPage).toContain('getOrderStatusFilter(searchParams.get("status"))')
  })
})

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("organization order auto-approval contracts", () => {
  it("uses a safe database default for existing organizations", () => {
    const schema = source("db/schema.ts")
    const migration = source("drizzle/20260930150000_add_order_approval_required.sql")

    expect(schema).toContain('orderApprovalRequired: boolean("order_approval_required")')
    expect(schema).toContain(".default(true)")
    expect(migration).toContain("order_approval_required boolean NOT NULL DEFAULT true")
  })

  it("resolves the same locked policy for both order creation paths", () => {
    const standard = source("app/api/v1/orders/route.ts")
    const grouped = source("lib/server/group-order-creation.ts")
    const policy = source("lib/server/order-creation-approval.ts")

    expect(policy).toContain('.for("share")')
    expect(policy).toContain("organization.orderApprovalRequired !== false")
    expect(policy).toContain("hashApprovalToken(approvalToken)")

    for (const creationPath of [standard, grouped]) {
      expect(creationPath).toContain("resolveInitialOrderApproval(tx")
      expect(creationPath).toContain("...initialApproval.values")
      expect(creationPath).toContain("initialApproval.approvalRequired")
    }
  })

  it("tells Super Admins about an auto-approved order from both creation paths", () => {
    const standard = source("app/api/v1/orders/route.ts")
    const grouped = source("lib/server/group-order-creation.ts")
    const notifications = source("lib/server/order-notifications.ts")

    expect(standard).toContain("if (!approvalRequired) return enqueueAutoApprovedOrderEvents(tx, { order })")
    expect(grouped).toContain("await queueSuperAdminAutoApprovalNotifications(tx, { order: notificationOrder })")
    expect(notifications).toContain("autoApproved: true")
    expect(notifications).toContain("autoApproved: value.autoApproved === true")
  })

  it("does not expose the fulfillment-token hash in create or replay responses", () => {
    const standard = source("app/api/v1/orders/route.ts")

    expect(standard.match(/approvalTokenHash: _approvalTokenHash/g)).toHaveLength(2)
    expect(standard).not.toContain("order: existingOrder")
  })

  it("runs real integration tests before a test-environment deployment", () => {
    const workflow = source(".github/workflows/deploy-test.yml")
    const migrationIndex = workflow.indexOf("npm run db:migrate")
    const integrationIndex = workflow.indexOf("npm run test:integration")
    const deploymentIndex = workflow.indexOf("Deploy to staging through SSM")

    expect(workflow).toContain("POSTGRES_DB: oneflowe_test")
    expect(migrationIndex).toBeGreaterThan(-1)
    expect(integrationIndex).toBeGreaterThan(migrationIndex)
    expect(deploymentIndex).toBeGreaterThan(integrationIndex)
    expect(workflow).toContain("Integration suites skipped themselves")
  })
})

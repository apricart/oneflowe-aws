import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("order approver implementation contracts", () => {
  it("persists exactly one constrained organization approver role with a safe legacy default", () => {
    const schema = source("db/schema.ts")
    const migration = source("drizzle/20260729150000_add_order_approver_role.sql")

    expect(schema).toContain('orderApproverRole: varchar("order_approver_role"')
    expect(schema).toContain('default("BRANCH_ADMIN")')
    expect(schema).toContain("organizations_order_approver_role_ck")
    expect(migration).toContain("SET \"order_approver_role\" = 'BRANCH_ADMIN'")
    expect(migration).toContain("NOT IN ('BRANCH_ADMIN', 'HEAD_OFFICE')")
    expect(migration).toContain('ALTER COLUMN "order_approver_role" SET NOT NULL')
  })

  it("authorizes approve and reject inside their winning transaction", () => {
    const policy = source("lib/server/order-decision-policy.ts")
    const approve = source("app/api/v1/orders/[id]/approve/route.ts")
    const reject = source("app/api/v1/orders/[id]/reject/route.ts")

    expect(policy).toContain('.for("share")')
    expect(policy).toContain("branch.organizationId")
    expect(approve).toContain('requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])')
    expect(reject).toContain('requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])')
    // A GROUP_USER's reach is read inside the deciding transaction, never from
    // the request, so a stale or forged scope cannot authorize a decision.
    expect(policy).toContain("resolveScopedBranchIds(tx, input.scope.userId)")
    expect(approve.indexOf("authorizeOrderDecision(tx")).toBeGreaterThan(approve.indexOf("db.transaction"))
    expect(reject.indexOf("authorizeOrderDecision(tx")).toBeGreaterThan(reject.indexOf("db.transaction"))
    expect(approve).not.toContain('"SUPER_ADMIN"]')
    expect(reject).not.toContain('"SUPER_ADMIN"]')
  })

  it("serializes approver configuration changes and audits both policy and decisions", () => {
    const organization = source("app/api/v1/organizations/[id]/route.ts")
    const approve = source("app/api/v1/orders/[id]/approve/route.ts")
    const reject = source("app/api/v1/orders/[id]/reject/route.ts")

    expect(organization).toContain('.for("update")')
    expect(organization).toContain('"UPDATE_ORDER_APPROVER_ROLE"')
    expect(approve).toContain('"ORDER_APPROVED"')
    expect(reject).toContain('"ORDER_REJECTED"')
  })

  it("keeps fulfillment and fulfillment progress Super Admin-only", () => {
    const fulfill = source("app/api/v1/orders/[id]/fulfill/route.ts")
    const progress = source("app/api/v1/orders/[id]/fulfillment-status/route.ts")

    expect(fulfill).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(progress).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(fulfill).not.toContain('"HEAD_OFFICE"')
  })
})


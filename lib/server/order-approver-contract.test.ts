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
    // Both transitions live in one service; every caller — the single-order
    // routes and the multi-branch bulk endpoint — reaches them through it, so
    // no surface can re-implement the authorization step.
    const service = source("lib/server/order-decision-service.ts")
    const approve = source("app/api/v1/orders/[id]/approve/route.ts")
    const reject = source("app/api/v1/orders/[id]/reject/route.ts")

    expect(policy).toContain('.for("share")')
    expect(policy).toContain("branch.organizationId")
    expect(approve).toContain('requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])')
    expect(reject).toContain('requireApiRole(["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER"])')
    // A GROUP_USER's reach is read inside the deciding transaction, never from
    // the request, so a stale or forged scope cannot authorize a decision.
    expect(policy).toContain("resolveScopedBranchIds(tx, input.scope.userId)")

    const approveBody = service.slice(service.indexOf("export async function approveOrder"))
    const rejectBody = service.slice(service.indexOf("export async function rejectOrder"))
    expect(approveBody.indexOf("authorizeOrderDecision(tx")).toBeGreaterThan(approveBody.indexOf("db.transaction"))
    expect(rejectBody.indexOf("authorizeOrderDecision(tx")).toBeGreaterThan(rejectBody.indexOf("db.transaction"))

    // The routes must delegate rather than carry their own transition.
    for (const route of [approve, reject]) {
      expect(route).not.toContain("db.transaction")
      expect(route).not.toContain('"SUPER_ADMIN"]')
    }
  })

  it("serializes approver configuration changes and audits both policy and decisions", () => {
    const organization = source("app/api/v1/organizations/[id]/route.ts")
    const service = source("lib/server/order-decision-service.ts")

    expect(organization).toContain('.for("update")')
    expect(organization).toContain('"UPDATE_ORDER_APPROVER_ROLE"')
    expect(service).toContain('"ORDER_APPROVED"')
    expect(service).toContain('"ORDER_REJECTED"')
    // Every decision records the role that actually decided, so a GROUP_USER
    // action is never filed under the tenant's configured approver role.
    expect(service).toContain("decisionRole: authorization.decisionRole")
  })

  it("keeps fulfillment and fulfillment progress Super Admin-only", () => {
    const fulfill = source("app/api/v1/orders/[id]/fulfill/route.ts")
    const progress = source("app/api/v1/orders/[id]/fulfillment-status/route.ts")

    expect(fulfill).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(progress).toContain('requireApiRole(["SUPER_ADMIN"])')
    expect(fulfill).not.toContain('"HEAD_OFFICE"')
  })
})


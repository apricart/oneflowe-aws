import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("branch creation security contracts", () => {
  it("binds Head Office creation to the server-side tenant scope", () => {
    const route = source("app/api/v1/branches/route.ts")

    expect(route).toContain("requireApiRole(BRANCH_CREATION_ROLES)")
    expect(route).toContain("const scope = await getRequestScope()")
    expect(route).toContain("resolveBranchCreationAccess(scope, requestedOrganizationId)")
    expect(route.indexOf("resolveBranchCreationAccess(scope")).toBeLessThan(
      route.indexOf(".insert(branchesTable)"),
    )
  })

  it("creates the branch and its audit event in the same serialized transaction", () => {
    const route = source("app/api/v1/branches/route.ts")
    const transactionStart = route.indexOf("db.transaction")

    expect(route).toContain("pg_advisory_xact_lock")
    expect(route.indexOf(".insert(branchesTable)")).toBeGreaterThan(transactionStart)
    expect(route.indexOf("tx.insert(auditLogs)")).toBeGreaterThan(transactionStart)
    expect(route).toContain('action: "CREATE_BRANCH"')
    expect(route).toContain("userId: scope.userId")
    expect(route).toContain("organizationId,")
  })

  it("adds normalized tenant-level uniqueness without modifying legacy rows", () => {
    const migration = source("drizzle/20260731120000_add_branch_tenant_uniqueness.sql")

    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_name_normalized_uq"')
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "branches_org_code_normalized_uq"')
    expect(migration).toContain('GROUP BY "organization_id", lower(btrim("name"))')
    expect(migration).toContain("RAISE EXCEPTION")
    expect(migration).not.toMatch(/\b(DELETE|UPDATE)\s+"branches"/i)
  })
})

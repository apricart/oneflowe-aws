import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

describe("code-only load fixes safety contracts", () => {
  it("reuses the configured application pool in the health route", () => {
    const route = source("app/api/v1/health/route.ts")

    expect(route).toContain('import { pool } from "@/lib/db"')
    expect(route).toContain('await pool.query("select 1")')
    expect(route).not.toContain("new Pool(")
  })

  it("invalidates dependent settings caches after both update and delete", () => {
    const route = source("app/api/v1/settings/route.ts")

    expect(route).toContain("await invalidateSettingCaches(key)")
    expect(route).toContain("await invalidateSettingCaches(deleted.key)")
    expect(route).toContain("await invalidateByPrefix('settings')")
    expect(route).toContain("await invalidateByPrefix('branch-inv')")
  })

  it("keeps quantity-budget coalescing scoped by organization and branch", () => {
    const route = source("app/api/v1/branch/inventory/route.ts")
    const coalescedRead = route.slice(route.indexOf("coalesceInFlight("))

    expect(coalescedRead).toContain("orgId: orgIdNum")
    expect(coalescedRead).toContain("branchId")
    expect(coalescedRead).toContain("period: currentPeriod")
    expect(coalescedRead).toContain("organizationInventoryIds")
  })

  it("continues to load request scope from the database while coalescing only in-flight reads", () => {
    const auth = source("lib/auth.ts")

    expect(auth).toContain("coalesceInFlight(`auth:request-scope:${userId}`")
    expect(auth).toContain("eq(users.id, userId)")
    expect(auth).toContain("return currentScope ?? null")
  })
})

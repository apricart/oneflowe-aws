import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repositoryFile = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8")

/**
 * The control that stops an expired add-on being spent is structural: every
 * path that takes a hold against a budget row settles that row's add-ons
 * under the same lock first. A path that reads `amount_credited_cents`
 * without settling would honour money that has expired, so the list below
 * is the control — a new spending path belongs on it.
 */
describe("expired add-ons are settled before any hold is taken", () => {
  const HOLD_PATHS = [
    "app/api/v1/orders/route.ts",
    "app/api/v1/orders/[id]/route.ts",
    "lib/server/group-order-creation.ts",
    "lib/server/order-desk-edit.ts",
  ]

  it.each(HOLD_PATHS)("%s settles under the row lock before checking the budget", (path) => {
    const source = repositoryFile(path)
    expect(source).toContain("from \"@/lib/server/budget-addon-expiry\"")
    const settleAt = source.indexOf("settleDueAddonsOnBudget(tx,")
    expect(settleAt).toBeGreaterThan(-1)
    // The remaining/available arithmetic on the locked row comes after the settle.
    const availableAt = source.indexOf("amountAllocatedCents + ", settleAt)
    expect(availableAt).toBeGreaterThan(settleAt)
  })

  it("the budgets route settles on every read and under the lock on every write", () => {
    const source = repositoryFile("app/api/v1/budgets/route.ts")
    expect(source).toContain("settleDueBudgetAddons(db, { branchIds: [branchId], periods: [period] })")
    expect(source).toContain("settleDueBudgetAddons(db, { branchIds, periods: range.periods })")
    expect(source).toContain("settleDueBudgetAddons(db, { branchIds: rows.map((row) => row.branchId), periods: [period] })")
    expect(source).toContain("await settleDueAddonsOnBudget(tx, existingRow.id, now, {")
  })

  it("only an add-on that credits money carries a validity date, and it is resolved through the pure module", () => {
    const source = repositoryFile("app/api/v1/budgets/route.ts")
    expect(source).toContain("from \"@/lib/budget-addon-expiry\"")
    expect(source).toContain("resolveAddonValidUntil(validUntilInput, now)")
    expect(source).toContain("validUntil is required for an add-on credit")
    expect(source).toContain("validUntil applies only to an add-on credit")
  })

  it("the sweep is reachable only with the cron secret", () => {
    const source = repositoryFile("app/api/v1/budgets/cron/expire-addons/route.ts")
    expect(source).toContain("`Bearer ${env.CRON_SECRET}`")
    expect(source).toMatch(/if \(!isCronAuthorized\(req\)\) return error\("Unauthorized", 401\)/)
    expect(source).not.toContain("getServerSession")
  })
})

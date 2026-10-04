import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * The control for `plans/OF-BUDGET-organization-budget-toggle.md`.
 *
 * The rule that keeps the ledger honest across the switch is that an order's
 * budget treatment is fixed when it is created and every later ledger move
 * asks the order. These lists are that rule's inventory: a new path that moves
 * `budgets` or `product_quantity_budgets` for an existing order goes on
 * LEDGER_MOVERS, a new order-derived budget figure goes on TRACKED_ORDER_READERS,
 * and a new ledger reader goes on BUDGET_ENABLED_READERS — or it is free to
 * charge, release or report money an order never took.
 */

/** Every path that moves a ledger figure for an order that already exists. */
const LEDGER_MOVERS = [
  "app/api/v1/orders/[id]/route.ts", // edit
  "lib/server/order-decision-service.ts", // reject
  "lib/server/order-fulfillment.ts", // fulfil, token hand-off
  "app/api/v1/orders/cron/auto-fulfill/route.ts", // 48-hour auto-fulfil
  "app/api/v1/orders/[id]/refunds/route.ts", // refund, direct or requested
  "app/api/v1/admin/refunds/route.ts", // Super Admin refund
  "app/api/v1/admin/delete-order/route.ts", // admin delete
]

/** The two paths that create an order. */
const CREATION_PATHS = [
  "app/api/v1/orders/route.ts",
  "lib/server/group-order-creation.ts",
]

/** Every order-derived figure compared against a budget. */
const TRACKED_ORDER_READERS = [
  "app/api/v1/analytics/budgets/summary/route.ts",
  "lib/server/executive-analytics-queries.ts",
  "app/api/v1/budgets/route.ts",
  "app/api/v1/admin/repair-budgets/route.ts",
]

/** Every report that reads the ledger across tenants. */
const BUDGET_ENABLED_READERS = [
  "app/api/v1/analytics/budgets/summary/route.ts",
  "lib/server/executive-analytics-queries.ts",
  "app/api/v1/budgets/route.ts",
  "app/api/v1/analytics/groups/route.ts",
  // Opens rows across tenants for a Super Admin's list; never for a tenant with budgets off.
  "lib/server/budget-period-opening.ts",
]

describe("storage", () => {
  const migration = source("drizzle/20261001120000_add_organization_budgets_enabled.sql")
  const schema = source("db/schema.ts")

  it("keeps every existing tenant and every existing order budgeted", () => {
    expect(migration).toContain("budgets_enabled boolean NOT NULL DEFAULT true")
    expect(migration).toContain("budget_tracked boolean NOT NULL DEFAULT true")
    expect(migration).not.toMatch(/UPDATE\s+organizations/i)
    expect(schema).toMatch(/budgetsEnabled: boolean\("budgets_enabled"\)\s*\.notNull\(\)\s*\.default\(true\)/)
    expect(schema).toContain('budgetTracked: boolean("budget_tracked").notNull().default(true)')
  })

  it("is on the migration journal", () => {
    expect(source("drizzle/meta/_journal.json")).toContain("20261001120000_add_organization_budgets_enabled")
  })

  it("creates a company off unless asked, in the schema and in the form", () => {
    expect(source("lib/server/mutation-validation.ts")).toContain("budgetsEnabled: z.boolean().optional().default(false)")
    expect(source("app/api/v1/organizations/route.ts")).toContain("budgetsEnabled: body.budgetsEnabled")
    expect(source("app/(portal)/organizations/page.tsx"))
      .toContain("useState(DEFAULT_ORGANIZATION_BUDGETS_ENABLED)")
  })
})

describe("changing the switch", () => {
  const route = source("app/api/v1/organizations/[id]/route.ts")

  it("is Super Admin only and copied through the explicit allowlist", () => {
    expect(route).toMatch(/PATCH[\s\S]*?requireApiRole\(\["SUPER_ADMIN"\]\)/)
    expect(route).toMatch(/VERBATIM_ORGANIZATION_FIELDS = \[[\s\S]*"budgetsEnabled",[\s\S]*\] as const/)
  })

  it("is audited inside the same transaction, with what it replaced", () => {
    expect(route).toContain("action: ORGANIZATION_BUDGETS_AUDIT_ACTION")
    expect(route).toContain("previousBudgetsEnabled: existingOrganization.budgetsEnabled")
    // The FOR UPDATE that creation's FOR SHARE waits on.
    expect(route).toMatch(/budgetsEnabled: organizations\.budgetsEnabled,\s*\}\)\s*\.from\(organizations\)[\s\S]*?\.for\("update"\)/)
  })
})

describe("creating an order", () => {
  it.each(CREATION_PATHS)("%s decides tracking under the organization row lock and stores it", (path) => {
    const text = source(path)
    expect(text).toContain("await resolveOrderBudgetTracking(tx, ")
    expect(text).toContain("{ budgetTracked: false }")
    expect(text).toContain("BUDGET_POLICY_CHANGED_MESSAGE")
  })

  it("resolves tracking with a shared lock", () => {
    expect(source("lib/server/organization-budget-policy.ts"))
      .toMatch(/resolveOrderBudgetTracking[\s\S]*?\.for\("share"\)/)
  })

  it("opens no budget row in the pre-flight when budgets are off", () => {
    expect(source("app/api/v1/orders/route.ts"))
      .toMatch(/if \(!await isOrganizationBudgetEnabled\(context\.organizationId\)\) return \{ budgetId: null \}\s*const currentBudget = await getOrCreateCurrentBudget/)
    expect(source("lib/server/group-order-creation.ts"))
      .toContain("context.budgetsEnabled ? await getOrCreateBranchBudget(branchId, context.period) : null")
  })
})

describe("every later ledger move asks the order", () => {
  it.each(LEDGER_MOVERS)("%s gates its ledger move on orderTakesBudget", (path) => {
    const text = source(path)
    expect(text).toMatch(/import \{ orderTakesBudget \} from "@\/lib\/organization-budget-policy"/)
    expect(text).toMatch(/orderTakesBudget\(/)
    // Never on the tenant's current setting, which is what breaks across a switch.
    expect(text).not.toMatch(/isOrganizationBudgetEnabled/)
  })

  it("reads the order's flag wherever the order is selected column by column", () => {
    expect(source("lib/order-select.ts")).toContain("budgetTracked:")
    expect(source("app/api/v1/orders/cron/auto-fulfill/route.ts")).toContain("budgetTracked: orderSelectColumns.budgetTracked")
    expect(source("app/api/v1/admin/refunds/route.ts")).toContain("budgetTracked: orderSelectColumns.budgetTracked")
  })
})

describe("budget figures", () => {
  it.each(TRACKED_ORDER_READERS)("%s counts only orders that took a hold", (path) => {
    expect(source(path)).toContain("budgetTrackedOrderSql()")
  })

  it.each(BUDGET_ENABLED_READERS)("%s leaves out tenants with budgets off", (path) => {
    expect(source(path)).toContain("budgetEnabledBranchSql()")
  })

  it("never ranks an organization with budgets off by a budget metric", () => {
    expect(source("lib/server/executive-analytics-queries.ts"))
      .toMatch(/loadBudgetRollup\(scope, filters, dimension as "branch" \| "group" \| "organization"\)[\s\S]{0,400}\.filter\(\(row\) => row\.budgetTracked\)/)
  })

  it("keeps the K-Electric spend backfill to orders that took a hold", () => {
    expect(source("scripts/backfill-ke-budget-spend.ts")).toMatch(/where o\.organization_id = \$1[\s\S]{0,300}and o\.budget_tracked/)
  })

  it("refuses allocation writes for a tenant with budgets off", () => {
    expect(source("app/api/v1/budgets/route.ts")).toMatch(/BUDGETS_DISABLED_MESSAGE, code: BUDGETS_DISABLED_CODE \}, \{ status: 409 \}/)
    expect(source("app/api/v1/budget-quantity/route.ts")).toMatch(/BUDGETS_DISABLED_MESSAGE, code: BUDGETS_DISABLED_CODE \}, \{ status: 409 \}/)
  })

  it("answers the shop's budget read before the load that would open a row", () => {
    const text = source("app/api/v1/budgets/route.ts")
    const refusal = text.indexOf("return NextResponse.json({ branchId, budgetsEnabled: false })")
    const load = text.indexOf("await loadSingleBranchBudget(branchId, currentMonth)")
    expect(refusal).toBeGreaterThan(-1)
    expect(load).toBeGreaterThan(refusal)
  })

  it("does not narrow a catalogue by quantity budgets while budgets are off", () => {
    expect(source("app/api/v1/branch/inventory/route.ts")).toContain("&& await isOrganizationBudgetEnabled(orgIdNum)")
    expect(source("lib/server/group-order-catalog.ts")).toContain("if (!await isOrganizationBudgetEnabled(organizationId)) return []")
  })
})

describe("the policy endpoint", () => {
  const route = source("app/api/v1/organizations/budget-policy/route.ts")

  it("reads the session's organization and nothing from the request", () => {
    expect(route).toContain("getRequestScope()")
    expect(route).not.toMatch(/searchParams|req\.|request\./)
    expect(route).toMatch(/export async function GET\(\)/)
  })

  it("is not cacheable by a shared cache", () => {
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"')
  })
})

import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

describe("dashboard refunded KPI drill-down parity", () => {
  it("opens the refunded drawer on the same fully-refunded population as the KPI", () => {
    const metrics = source("lib/metric-utils.ts")
    const drawer = source("components/dashboard/drill-down-sheet.tsx")
    const route = source("app/api/v1/analytics/drill-down/route.ts")

    expect(metrics).toContain("CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END")
    expect(drawer).toContain('useState<"all" | "full" | "partial">("full")')
    expect(drawer).toContain('if (type === "REFUNDED") setRefundType("full")')
    expect(drawer).toContain('params.set("refundType", refundType)')
    expect(route).toContain('if (refundType === "full")')
    expect(route).toContain('eq(sql`UPPER(${orders.status})`, "REFUNDED")')
  })

  it("retains explicit all-refund and partial-refund API scopes", () => {
    const route = source("app/api/v1/analytics/drill-down/route.ts")

    expect(route).toContain('} else if (refundType === "partial")')
    expect(route).toContain('gt(sql`COALESCE(${orders.refundAmountCents}, 0)`, 0)')
    expect(route).toContain("sql`UPPER(${orders.status}) <> 'REFUNDED'`")
  })
})

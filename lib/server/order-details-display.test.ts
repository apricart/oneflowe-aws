import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const routeSource = readFileSync("app/api/v1/orders/[id]/route.ts", "utf8")
const pageSource = readFileSync("app/(portal)/orders/[orderId]/page.tsx", "utf8")

describe("single-order identity details", () => {
  it("loads the stored branch name instead of relying on a branch-id label", () => {
    expect(routeSource).toContain("branchName: branches.name")
    expect(routeSource).toContain("leftJoin(branches, eq(orders.branchId, branches.id))")
  })

  it("loads and displays the user who initiated the order", () => {
    expect(routeSource).toContain("creatorName:")
    expect(routeSource).toContain("creatorEmployeeId: users.employeeId")
    expect(pageSource).toContain("<span>Initiated by</span>")
    expect(pageSource).toContain("{initiatorName}")
  })
})

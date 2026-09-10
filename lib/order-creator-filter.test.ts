import { describe, expect, it } from "vitest"

import { ORDER_CREATOR_ROLES } from "@/lib/group-order-visibility"
import { parseOrderCreatorRoleFilter } from "@/lib/order-creator-filter"

describe("parseOrderCreatorRoleFilter", () => {
  it("treats an absent parameter as no filter", () => {
    expect(parseOrderCreatorRoleFilter(null)).toEqual({ ok: true, role: null })
    expect(parseOrderCreatorRoleFilter(undefined)).toEqual({ ok: true, role: null })
  })

  it("treats an empty or blank value as no filter", () => {
    expect(parseOrderCreatorRoleFilter("")).toEqual({ ok: true, role: null })
    expect(parseOrderCreatorRoleFilter("   ")).toEqual({ ok: true, role: null })
  })

  it("accepts every role that raises orders", () => {
    for (const role of ORDER_CREATOR_ROLES) {
      expect(parseOrderCreatorRoleFilter(role)).toEqual({ ok: true, role })
    }
  })

  it("normalizes case so a lowercased parameter still resolves", () => {
    expect(parseOrderCreatorRoleFilter("order_portal")).toEqual({
      ok: true,
      role: "ORDER_PORTAL",
    })
  })

  it("refuses a role that decides orders rather than raising them", () => {
    for (const role of ["BRANCH_ADMIN", "HEAD_OFFICE", "GROUP_USER", "SUPER_ADMIN"]) {
      expect(parseOrderCreatorRoleFilter(role).ok).toBe(false)
    }
  })

  it("refuses an unknown value rather than dropping the filter", () => {
    // Dropping it would widen the result, which is the wrong way for a
    // narrowing filter to fail.
    const result = parseOrderCreatorRoleFilter("ANYTHING_ELSE")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("ORDER_PORTAL")
  })

  it("refuses non-string input", () => {
    expect(parseOrderCreatorRoleFilter(42).ok).toBe(false)
    expect(parseOrderCreatorRoleFilter({ role: "ORDER_PORTAL" }).ok).toBe(false)
    expect(parseOrderCreatorRoleFilter(["ORDER_PORTAL"]).ok).toBe(false)
  })
})

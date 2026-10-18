import { describe, expect, it } from "vitest"

import { departmentJoinDecisionSchema, validationMessage } from "./mutation-validation"

/**
 * Head Office approving a department sign-up with a CRC to create. The answer
 * to a refused new-branch field must say which field, because the dialog shows
 * the server's message as it is.
 */
const approval = (branch: Record<string, unknown>) => ({
  decision: "approve",
  newBranches: [{ requestBranchId: 1, ...branch }],
  expectedResolutions: [],
})

const complete = { name: "DEMOTTTT", province: "Sindh", city: "Karachi", address: "Plot 4, Clifton" }

describe("departmentJoinDecisionSchema — new branch details", () => {
  it("accepts a complete new branch", () => {
    expect(departmentJoinDecisionSchema.safeParse(approval(complete)).success).toBe(true)
  })

  it("accepts a CRC mapped onto an existing branch with no details", () => {
    expect(departmentJoinDecisionSchema.safeParse(approval({ mapToBranchId: 7 })).success).toBe(true)
  })

  it.each([
    ["province", "", "New branch: the province needs at least 2 characters"],
    ["city", "K", "New branch: the city needs at least 2 characters"],
    ["name", " ", "New branch: the branch name needs at least 2 characters"],
    ["address", "B-12", "New branch: the branch address needs at least 5 characters"],
  ])("refuses a short %s with a message naming it", (field, value, message) => {
    const parsed = departmentJoinDecisionSchema.safeParse(approval({ ...complete, [field]: value }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(validationMessage(parsed.error)).toBe(message)
  })

  // plans/OF-JOIN-new-branch-city-warehouse.md
  it("refuses a city that is not on Pakistan's list", () => {
    const parsed = departmentJoinDecisionSchema.safeParse(approval({ ...complete, city: "Atlantis" }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(validationMessage(parsed.error)).toBe("New branch: choose the city from the list")
  })

  it("refuses a province that is not the city's own", () => {
    const parsed = departmentJoinDecisionSchema.safeParse(approval({ ...complete, province: "Punjab" }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(validationMessage(parsed.error)).toBe("New branch: Karachi is in Sindh")
  })

  it("stores the list's own spelling of the city", () => {
    const parsed = departmentJoinDecisionSchema.safeParse(approval({ ...complete, city: "  karachi " }))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.newBranches?.[0].city).toBe("Karachi")
  })

  it("refuses an over-long field with a message naming it", () => {
    const parsed = departmentJoinDecisionSchema.safeParse(approval({ ...complete, city: "x".repeat(101) }))
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(validationMessage(parsed.error)).toBe("New branch: the city can be at most 100 characters")
  })
})

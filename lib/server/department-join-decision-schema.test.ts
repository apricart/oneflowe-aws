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

describe("departmentJoinDecisionSchema — the created branch's type (plans/OF-JOIN-new-branch-parent-child.md)", () => {
  const parse = (newBranches: Array<Record<string, unknown>>) =>
    departmentJoinDecisionSchema.safeParse({ decision: "approve", newBranches, expectedResolutions: [] })

  it("accepts a parent created with its child, and a child of an existing branch", () => {
    expect(parse([
      { requestBranchId: 1, ...complete, hierarchyRole: "PARENT" },
      { requestBranchId: 2, ...complete, name: "Kid", hierarchyRole: "CHILD", parentRequestBranchId: 1 },
      { requestBranchId: 3, ...complete, name: "Kiosk", hierarchyRole: "CHILD", parentBranchId: 7 },
    ]).success).toBe(true)
  })

  it.each([
    ["a child with no parent", [{ requestBranchId: 1, ...complete, hierarchyRole: "CHILD" }], /Choose the parent branch/],
    ["a child with two parents", [{ requestBranchId: 1, ...complete, hierarchyRole: "CHILD", parentBranchId: 7, parentRequestBranchId: 2 }], /Choose one parent/],
    ["a standalone with a parent", [{ requestBranchId: 1, ...complete, parentBranchId: 7 }], /Only a child branch/],
    ["a type on a mapped CRC", [{ requestBranchId: 1, mapToBranchId: 7, hierarchyRole: "PARENT" }], /keeps that branch's type/],
    ["a child of a branch not created as Parent", [
      { requestBranchId: 1, ...complete },
      { requestBranchId: 2, ...complete, name: "Kid", hierarchyRole: "CHILD", parentRequestBranchId: 1 },
    ], /created here as Parent/],
    ["a child of a request branch not decided here", [{ requestBranchId: 2, ...complete, hierarchyRole: "CHILD", parentRequestBranchId: 99 }], /created here as Parent/],
  ])("refuses %s, saying why", (_case, newBranches, message) => {
    const parsed = parse(newBranches)
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(validationMessage(parsed.error)).toMatch(message)
  })
})

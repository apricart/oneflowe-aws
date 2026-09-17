import { describe, expect, it } from "vitest"
import { userAccessUpdateSchema, userCreateSchema } from "@/lib/server/mutation-validation"

const createBody = {
  firstName: "Group",
  lastName: "User",
  email: "group@example.test",
  username: "group.user",
  password: "StrongPassword1!",
  role: "GROUP_USER",
  organizationId: 17,
  branchId: null,
  groupIds: [12],
  branchIds: [],
}

describe("Group User budget allocation input", () => {
  it("defaults to disabled when a Group User is created without the flag", () => {
    const parsed = userCreateSchema.parse(createBody)
    expect(parsed.budgetAllocationEnabled).toBeUndefined()
  })

  it("accepts explicit boolean grants and rejects non-boolean values", () => {
    expect(userCreateSchema.parse({ ...createBody, budgetAllocationEnabled: true }).budgetAllocationEnabled).toBe(true)
    expect(userAccessUpdateSchema.parse({ budgetAllocationEnabled: false }).budgetAllocationEnabled).toBe(false)
    expect(userAccessUpdateSchema.safeParse({ budgetAllocationEnabled: "true" }).success).toBe(false)
  })

  it("rejects a grant on another role and unknown create/access fields", () => {
    expect(userCreateSchema.safeParse({ ...createBody, role: "BRANCH_ADMIN", budgetAllocationEnabled: true }).success).toBe(false)
    expect(userCreateSchema.safeParse({ ...createBody, budgetAllocationEnabled: true, elevated: true }).success).toBe(false)
    expect(userAccessUpdateSchema.safeParse({ budgetAllocationEnabled: true, elevated: true }).success).toBe(false)
  })
})

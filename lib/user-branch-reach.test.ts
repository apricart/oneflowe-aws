import { describe, expect, it } from "vitest"

import { userReachesAnyBranch } from "@/lib/user-branch-reach"

describe("userReachesAnyBranch", () => {
  const filter = new Set([316])

  it("keeps a single-branch user whose own branch is filtered", () => {
    expect(userReachesAnyBranch({ branchId: 316, assignedBranches: null }, filter)).toBe(true)
  })

  it("keeps a group-based user assigned to a filtered branch", () => {
    expect(userReachesAnyBranch({ branchId: null, assignedBranches: [{ id: 297 }, { id: 316 }] }, filter)).toBe(true)
  })

  it("drops a group-based user assigned only elsewhere", () => {
    expect(userReachesAnyBranch({ branchId: null, assignedBranches: [{ id: 297 }] }, filter)).toBe(false)
  })

  it("drops a user with no branch and no assignments", () => {
    expect(userReachesAnyBranch({ branchId: null, assignedBranches: [] }, filter)).toBe(false)
    expect(userReachesAnyBranch({}, filter)).toBe(false)
  })

  it("drops a single-branch user at another branch", () => {
    expect(userReachesAnyBranch({ branchId: 297 }, filter)).toBe(false)
  })

  it("matches against any of several filtered branches", () => {
    expect(userReachesAnyBranch({ branchId: null, assignedBranches: [{ id: 12 }] }, new Set([11, 12]))).toBe(true)
  })
})

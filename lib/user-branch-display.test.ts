import { describe, expect, it } from "vitest"

import {
  MULTIPLE_BRANCHES_LABEL,
  describeUserBranches,
  userBranchExportText,
} from "@/lib/user-branch-display"

const names = new Map<number, string>([[1, "Clifton"], [2, "Gulshan"]])

describe("describeUserBranches", () => {
  it("shows a single-branch role's own branch", () => {
    expect(describeUserBranches({ role: "BRANCH_ADMIN", branchId: 1, assignedBranches: null }, names))
      .toEqual({ kind: "single", label: "Clifton", branches: [{ id: 1, name: "Clifton" }] })
  })

  it("says Unknown for a branch outside the loaded list rather than Head Office", () => {
    expect(describeUserBranches({ role: "ORDER_PORTAL", branchId: 99 }, names).label).toBe("Unknown")
  })

  it("shows Multiple with every branch for a group user reaching more than one", () => {
    const assignedBranches = [{ id: 1, name: "Clifton" }, { id: 2, name: "Gulshan" }]
    expect(describeUserBranches({ role: "GROUP_USER", assignedBranches }, names)).toEqual({
      kind: "multiple",
      label: MULTIPLE_BRANCHES_LABEL,
      branches: assignedBranches,
    })
  })

  it("shows the one branch by name for a group user reaching exactly one", () => {
    const display = describeUserBranches(
      { role: "GROUP_ORDER_PORTAL", assignedBranches: [{ id: 2, name: "Gulshan" }] },
      names,
    )
    expect(display).toMatchObject({ kind: "single", label: "Gulshan" })
  })

  it("never labels a group user with no branches as Head Office", () => {
    expect(describeUserBranches({ role: "GROUP_USER", assignedBranches: [] }, names))
      .toEqual({ kind: "none", label: "No branches", branches: [] })
  })

  it("keeps Head Office for the tenant-wide role and All branches for a tenant-wide Viewer", () => {
    expect(describeUserBranches({ role: "HEAD_OFFICE" }, names).label).toBe("Head Office")
    expect(describeUserBranches({ role: "VIEWER", branchId: null }, names).label).toBe("All branches")
    expect(describeUserBranches({ role: "VIEWER", branchId: 2 }, names).label).toBe("Gulshan")
  })

  it("shows a dash for Apricart staff, whose reach is granted on their own team pages", () => {
    for (const role of ["ORDER_DESK", "WAREHOUSE", "APRICART_EXECUTIVE"]) {
      expect(describeUserBranches({ role }, names).label).toBe("—")
    }
  })
})

describe("userBranchExportText", () => {
  it("lists every branch of a multi-branch user", () => {
    const display = describeUserBranches(
      { role: "GROUP_USER", assignedBranches: [{ id: 1, name: "Clifton" }, { id: 2, name: "Gulshan" }] },
      names,
    )
    expect(userBranchExportText(display)).toBe("Clifton; Gulshan")
  })

  it("uses the label otherwise", () => {
    expect(userBranchExportText(describeUserBranches({ role: "HEAD_OFFICE" }, names))).toBe("Head Office")
  })
})

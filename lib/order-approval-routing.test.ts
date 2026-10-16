import { describe, expect, it } from "vitest"

import {
  type LevelledDecisionActor,
  approvalLevelForAmount,
  approvalLevelsActive,
  canDecideLevelledOrder,
} from "./order-approval-levels"

/** plans/OF-APPROVAL-LEVELS-route-orders-by-level.md */

describe("approvalLevelsActive — the one switch", () => {
  it("is on only with approval required, levels on and at least one level", () => {
    expect(approvalLevelsActive({ orderApprovalRequired: true, orderApprovalLevelsEnabled: true, levelCount: 2 })).toBe(true)
    expect(approvalLevelsActive({ orderApprovalRequired: false, orderApprovalLevelsEnabled: true, levelCount: 2 })).toBe(false)
    expect(approvalLevelsActive({ orderApprovalRequired: true, orderApprovalLevelsEnabled: false, levelCount: 2 })).toBe(false)
    expect(approvalLevelsActive({ orderApprovalRequired: true, orderApprovalLevelsEnabled: true, levelCount: 0 })).toBe(false)
  })
})

describe("approvalLevelForAmount — the strict bands", () => {
  // Level 1 = 80,000 and above; Level 2 = 40,000 to under 80,000; Level 3 = under 40,000.
  const three = [8_000_000, 4_000_000, 1_000_000]

  it.each([
    [10_000_000, 1],
    [8_000_000, 1],
    [7_999_999, 2],
    [4_000_000, 2],
    [3_999_999, 3],
    // Below the lowest level's own amount still goes to the lowest level.
    [500_000, 3],
    [0, 3],
  ])("puts PKR %i cents at Level %i", (amount, level) => {
    expect(approvalLevelForAmount(amount, three)).toBe(level)
  })

  it("sends everything below Level 1 to Level 2 when there are two levels", () => {
    expect(approvalLevelForAmount(7_999_999, [8_000_000, 4_000_000])).toBe(2)
    expect(approvalLevelForAmount(1, [8_000_000, 4_000_000])).toBe(2)
    expect(approvalLevelForAmount(8_000_000, [8_000_000, 4_000_000])).toBe(1)
  })

  it("sends every order to Level 1 when there is one level, and none when there are none", () => {
    expect(approvalLevelForAmount(1, [8_000_000])).toBe(1)
    expect(approvalLevelForAmount(99_999_999, [8_000_000])).toBe(1)
    expect(approvalLevelForAmount(1, [])).toBeNull()
  })
})

describe("canDecideLevelledOrder", () => {
  const organization = {
    orderApprovalRequired: true,
    orderApprovalLevelsEnabled: true,
    orderApproverRole: "BRANCH_ADMIN",
  }
  const order = { approvalLevel: 2, organizationId: 7, branchId: 10, createdByUserId: "creator" }
  const groupUser = (overrides: Partial<LevelledDecisionActor> = {}): LevelledDecisionActor => ({
    userId: "approver",
    role: "GROUP_USER",
    organizationId: 7,
    branchId: null,
    level: 2,
    scopedBranchIds: [10, 11],
    ...overrides,
  })
  const decides = (actor: LevelledDecisionActor, overrides: Partial<typeof organization> = {}) =>
    canDecideLevelledOrder({ actor, order, organization: { ...organization, ...overrides } })

  it("lets the holder of exactly that level, reaching the branch, decide", () => {
    expect(decides(groupUser())).toBe(true)
    expect(decides(groupUser({ role: "BRANCH_ADMIN", branchId: 10, scopedBranchIds: [] }))).toBe(true)
    expect(decides(groupUser({ role: "HEAD_OFFICE", scopedBranchIds: [] }), { orderApproverRole: "HEAD_OFFICE" })).toBe(true)
  })

  it.each([
    ["a higher level", { level: 1 }],
    ["a lower level", { level: 3 }],
    ["no level", { level: null }],
    ["a Group User not assigned to the branch", { scopedBranchIds: [11] }],
    ["another organization", { organizationId: 8 }],
    ["no organization", { organizationId: null }],
    ["the person who raised the order", { userId: "creator" }],
    ["a role that cannot hold a level", { role: "ORDER_PORTAL" }],
  ])("refuses %s", (_case, overrides) => {
    expect(decides(groupUser(overrides as Partial<LevelledDecisionActor>))).toBe(false)
  })

  it("refuses a Branch Admin of another branch, and one where Head Office is the approver role", () => {
    expect(decides(groupUser({ role: "BRANCH_ADMIN", branchId: 11, scopedBranchIds: [] }))).toBe(false)
    expect(decides(groupUser({ role: "BRANCH_ADMIN", branchId: 10, scopedBranchIds: [] }), { orderApproverRole: "HEAD_OFFICE" })).toBe(false)
  })

  it("refuses Head Office where Branch Admin is the approver role, even holding the level", () => {
    expect(decides(groupUser({ role: "HEAD_OFFICE", scopedBranchIds: [] }))).toBe(false)
  })
})

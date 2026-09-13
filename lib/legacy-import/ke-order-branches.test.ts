import { describe, expect, it } from "vitest"

import {
  indexBranches,
  planOrderBranchRepair,
  resolveLegacyBranch,
  summarizeOrderBranchRepair,
  type BranchAccount,
  type BudgetLedgerRow,
  type CatalogueBranch,
  type PlacedOrder,
} from "./ke-order-branches"

const SOURCE = "KE_LOGISTICS"

function branch(overrides: Partial<CatalogueBranch> & Pick<CatalogueBranch, "id" | "name">): CatalogueBranch {
  return { address: null, externalSource: SOURCE, externalId: null, ...overrides }
}

const JOHAR_1 = branch({ id: 243, name: "Johar |", address: "Plot ST-14", externalId: "146" })
const JOHAR_2 = branch({ id: 244, name: "Johar ||", address: "Plot B-65", externalId: "147" })
const SOCIETY_LOWER = branch({ id: 226, name: "society cluster", externalId: "128" })
const SOCIETY_TITLE = branch({ id: 279, name: "Society Cluster", externalId: "132" })
const UNPINNED = branch({ id: 300, name: "Test Branch", externalSource: null, externalId: null })

describe("resolveLegacyBranch", () => {
  const index = indexBranches([JOHAR_1, JOHAR_2, SOCIETY_LOWER, SOCIETY_TITLE, UNPINNED], SOURCE)

  it("resolves each twin by its legacy id, whatever the names normalise to", () => {
    expect(resolveLegacyBranch(index, { legacyLocationId: 146, branchName: "Johar |" }))
      .toEqual({ kind: "PINNED", branch: JOHAR_1 })
    expect(resolveLegacyBranch(index, { legacyLocationId: 147, branchName: "Johar ||" }))
      .toEqual({ kind: "PINNED", branch: JOHAR_2 })
    expect(resolveLegacyBranch(index, { legacyLocationId: 132, branchName: "Society Cluster" }))
      .toEqual({ kind: "PINNED", branch: SOCIETY_TITLE })
  })

  it("trusts the id over a name that points elsewhere", () => {
    // Legacy renamed a location; the pin still says who it is.
    expect(resolveLegacyBranch(index, { legacyLocationId: 146, branchName: "Johar One" }))
      .toEqual({ kind: "PINNED", branch: JOHAR_1 })
  })

  it("refuses a name that matches only a branch pinned to a different id", () => {
    const withoutJohar1 = indexBranches([JOHAR_2, UNPINNED], SOURCE)
    const result = resolveLegacyBranch(withoutJohar1, { legacyLocationId: 146, branchName: "Johar |" })
    expect(result.kind).toBe("NOT_FOUND")
    expect((result as { detail: string }).detail).toContain("Johar ||")
    expect((result as { detail: string }).detail).toContain("legacy 147")
    expect((result as { detail: string }).detail).toContain("sync:ke")
  })

  it("falls back to the name only for an unpinned branch", () => {
    expect(resolveLegacyBranch(index, { legacyLocationId: 999, branchName: "test   branch" }))
      .toEqual({ kind: "BY_NAME", branch: UNPINNED })
    expect(resolveLegacyBranch(index, { legacyLocationId: null, branchName: "Test Branch" }))
      .toEqual({ kind: "BY_NAME", branch: UNPINNED })
  })

  it("reports two unpinned branches of one name as ambiguous", () => {
    const twins = indexBranches([UNPINNED, branch({ ...UNPINNED, id: 301, name: "test-branch" })], SOURCE)
    const result = resolveLegacyBranch(twins, { legacyLocationId: 999, branchName: "Test Branch" })
    expect(result.kind).toBe("AMBIGUOUS")
  })

  it("reports two branches pinned to one id as ambiguous rather than picking", () => {
    const doublePin = indexBranches([JOHAR_1, branch({ ...JOHAR_2, externalId: "146" })], SOURCE)
    expect(resolveLegacyBranch(doublePin, { legacyLocationId: 146, branchName: "Johar |" }).kind).toBe("AMBIGUOUS")
  })

  it("does not treat a pin from another source as a pin", () => {
    const other = indexBranches([branch({ id: 1, name: "Johar |", externalSource: "OTHER", externalId: "146" })], SOURCE)
    expect(resolveLegacyBranch(other, { legacyLocationId: 146, branchName: "Johar |" }))
      .toEqual({ kind: "BY_NAME", branch: other.unpinnedByName.get("johar")![0] })
  })

  it("is not found when nothing matches", () => {
    const result = resolveLegacyBranch(index, { legacyLocationId: 999, branchName: "Nowhere" })
    expect(result.kind).toBe("NOT_FOUND")
  })
})

// ---------------------------------------------------------------------------
// Repair planning — the two production shapes and their neighbours
// ---------------------------------------------------------------------------

const MUHAMMAD_OP: BranchAccount = {
  userId: "u-muhammad-op", username: "muhammad-13464-op", branchId: 243, isActive: true,
  externalSource: SOURCE, externalId: "13464",
}
const AFSHAN_OP: BranchAccount = {
  userId: "u-afshan-op", username: "afshan-15377084-op", branchId: 244, isActive: true,
  externalSource: SOURCE, externalId: "15377084",
}
const PLACEHOLDER_226: BranchAccount = {
  userId: "u-placeholder-226", username: "legacy_ke_226_142", branchId: 226, isActive: false,
  externalSource: null, externalId: null,
}
const TARIQ_OP: BranchAccount = {
  userId: "u-tariq-op", username: "tariq-103766-op", branchId: 279, isActive: true,
  externalSource: SOURCE, externalId: "103766",
}
const ACCOUNTS = [MUHAMMAD_OP, AFSHAN_OP, PLACEHOLDER_226, TARIQ_OP]

function order(overrides: Partial<PlacedOrder> & Pick<PlacedOrder, "orderId">): PlacedOrder {
  return {
    tid: `KE-LEGACY-${overrides.legacyOrderId ?? overrides.orderId}`,
    branchId: 243,
    status: "FULFILLED",
    totalCents: 100_000,
    refundAmountCents: null,
    period: "2026-08",
    createdByUserId: MUHAMMAD_OP.userId,
    legacyOrderId: overrides.orderId,
    legacyLocationId: 146,
    legacyLocationName: "Johar |",
    ...overrides,
  }
}

function budget(overrides: Partial<BudgetLedgerRow> & Pick<BudgetLedgerRow, "id" | "branchId" | "period">): BudgetLedgerRow {
  return { amountAllocatedCents: 0, amountSpentCents: 0, amountHeldCents: 0, amountCreditedCents: 0, ...overrides }
}

/** Legacy 1472: approved, at Johar || by the name collision, raised by a person whose only account is at Johar |. */
const ORDER_1472 = order({
  orderId: 2016, legacyOrderId: 1472, branchId: 244, status: "APPROVED", totalCents: 3_697_000,
  period: "2026-08", createdByUserId: MUHAMMAD_OP.userId, legacyLocationId: 146, legacyLocationName: "Johar |",
})
/** Legacy 2519: delivered, at society cluster by the collision, attributed to that branch's placeholder. */
const ORDER_2519 = order({
  orderId: 1993, legacyOrderId: 2519, branchId: 226, status: "FULFILLED", totalCents: 3_467_500,
  period: "2026-09", createdByUserId: PLACEHOLDER_226.userId, legacyLocationId: 132, legacyLocationName: "Society Cluster",
})
/** A correctly placed neighbour at Johar || in the same month, so its budget row does not go to zero. */
const ORDER_OK_JOHAR_2 = order({
  orderId: 2000, legacyOrderId: 1400, branchId: 244, status: "APPROVED", totalCents: 500_000,
  period: "2026-08", createdByUserId: AFSHAN_OP.userId, legacyLocationId: 147, legacyLocationName: "Johar ||",
})

const BRANCHES = [JOHAR_1, JOHAR_2, SOCIETY_LOWER, SOCIETY_TITLE, UNPINNED]

describe("planOrderBranchRepair", () => {
  const budgets = [
    budget({ id: 1000, branchId: 243, period: "2026-08" }),
    budget({ id: 1001, branchId: 244, period: "2026-08", amountAllocatedCents: 4_197_000, amountHeldCents: 4_197_000 }),
    budget({ id: 1284, branchId: 226, period: "2026-09", amountAllocatedCents: 3_467_500, amountSpentCents: 3_467_500 }),
  ]
  const plan = planOrderBranchRepair({
    orders: [ORDER_1472, ORDER_2519, ORDER_OK_JOHAR_2], branches: BRANCHES, accounts: ACCOUNTS, budgets, source: SOURCE,
  })

  it("moves exactly the orders whose branch disagrees with their legacy location", () => {
    expect(plan.moves.map((move) => move.legacyOrderId)).toEqual([2519, 1472])
    expect(plan.holds).toEqual([])
    expect(plan.unverifiableLegacyOrderIds).toEqual([])
  })

  it("follows the person to the branch their account is already at", () => {
    const move = plan.moves.find((entry) => entry.legacyOrderId === 1472)!
    expect(move.from).toEqual({ branchId: 244, branchName: "Johar ||" })
    expect(move.to).toEqual({ branchId: 243, branchName: "Johar |", branchAddress: "Plot ST-14" })
    expect(move.creator).toEqual({ from: MUHAMMAD_OP.userId, to: MUHAMMAD_OP.userId, rule: "SAME_PERSON_AT_BRANCH" })
    expect(move.consumption).toEqual({ kind: "HELD", cents: 3_697_000 })
  })

  it("keeps a personal account that has no counterpart at the new branch", () => {
    const misplaced = order({ orderId: 5, legacyOrderId: 5, branchId: 244, createdByUserId: AFSHAN_OP.userId,
      legacyLocationId: 132, legacyLocationName: "Society Cluster" })
    const result = planOrderBranchRepair({ orders: [misplaced], branches: BRANCHES, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.moves[0].to.branchId).toBe(279)
    expect(result.moves[0].creator).toEqual({ from: AFSHAN_OP.userId, to: AFSHAN_OP.userId, rule: "KEPT_PERSONAL_ACCOUNT" })
  })

  it("re-attributes a branch placeholder to the new branch's own account", () => {
    const move = plan.moves.find((entry) => entry.legacyOrderId === 2519)!
    expect(move.creator).toEqual({ from: PLACEHOLDER_226.userId, to: TARIQ_OP.userId, rule: "BRANCH_ACCOUNT" })
    expect(move.consumption).toEqual({ kind: "SPENT", cents: 3_467_500 })
  })

  it("moves to the same person's account at the new branch when one exists", () => {
    const muhammadAtJohar2 = { ...MUHAMMAD_OP, userId: "u-muhammad-op-2", username: "muhammad-13464-op2", branchId: 244 }
    const misplaced = order({ orderId: 5, legacyOrderId: 5, branchId: 243, legacyLocationId: 147, legacyLocationName: "Johar ||" })
    const result = planOrderBranchRepair({
      orders: [misplaced], branches: BRANCHES, accounts: [...ACCOUNTS, muhammadAtJohar2], budgets: [], source: SOURCE,
    })
    expect(result.moves[0].creator).toEqual({ from: MUHAMMAD_OP.userId, to: "u-muhammad-op-2", rule: "SAME_PERSON_AT_BRANCH" })
  })

  it("prefers the active account when the same person has two at the new branch", () => {
    const retired = { ...MUHAMMAD_OP, userId: "u-old", username: "aaa-old", branchId: 244, isActive: false }
    const live = { ...MUHAMMAD_OP, userId: "u-live", username: "zzz-live", branchId: 244, isActive: true }
    const misplaced = order({ orderId: 5, legacyOrderId: 5, branchId: 243, legacyLocationId: 147, legacyLocationName: "Johar ||" })
    const result = planOrderBranchRepair({
      orders: [misplaced], branches: BRANCHES, accounts: [...ACCOUNTS, retired, live], budgets: [], source: SOURCE,
    })
    expect(result.moves[0].creator.to).toBe("u-live")
  })

  it("recomputes the budget rows of every touched branch/month from the post-move order set", () => {
    expect(plan.budgetChanges).toEqual([
      // society cluster 2026-09: its only order left; spent goes to zero, allocation stays.
      {
        operation: "UPDATE", budgetId: 1284, branchId: 226, branchName: "society cluster", period: "2026-09",
        previous: { allocated: 3_467_500, spent: 3_467_500, held: 0, credited: 0 },
        target: { allocated: 3_467_500, spent: 0, held: 0, credited: 0 },
      },
      // Johar | 2026-08: gains the held order; allocation raised to cover it.
      {
        operation: "UPDATE", budgetId: 1000, branchId: 243, branchName: "Johar |", period: "2026-08",
        previous: { allocated: 0, spent: 0, held: 0, credited: 0 },
        target: { allocated: 3_697_000, spent: 0, held: 3_697_000, credited: 0 },
      },
      // Johar || 2026-08: keeps its own order's hold; the synthetic allocation is not lowered.
      {
        operation: "UPDATE", budgetId: 1001, branchId: 244, branchName: "Johar ||", period: "2026-08",
        previous: { allocated: 4_197_000, spent: 0, held: 4_197_000, credited: 0 },
        target: { allocated: 4_197_000, spent: 0, held: 500_000, credited: 0 },
      },
      // Society Cluster 2026-09: no row yet; inserted at the minimum allocation.
      {
        operation: "INSERT", budgetId: null, branchId: 279, branchName: "Society Cluster", period: "2026-09",
        previous: { allocated: 0, spent: 0, held: 0, credited: 0 },
        target: { allocated: 3_467_500, spent: 3_467_500, held: 0, credited: 0 },
      },
    ])
  })

  it("nets a partial refund out of what moves, as the backfill does", () => {
    const refunded = { ...ORDER_2519, refundAmountCents: 467_500 }
    const result = planOrderBranchRepair({ orders: [refunded], branches: BRANCHES, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.moves[0].consumption).toEqual({ kind: "SPENT", cents: 3_000_000 })
    expect(result.budgetChanges.find((change) => change.branchId === 279)!.target.spent).toBe(3_000_000)
  })

  it("moves a rejected or refunded order without touching any budget row", () => {
    const rejected = { ...ORDER_1472, status: "REJECTED" }
    const result = planOrderBranchRepair({
      orders: [rejected], branches: BRANCHES, accounts: ACCOUNTS,
      budgets: [budget({ id: 1, branchId: 243, period: "2026-08" }), budget({ id: 2, branchId: 244, period: "2026-08" })],
      source: SOURCE,
    })
    expect(result.moves).toHaveLength(1)
    expect(result.moves[0].consumption).toEqual({ kind: "NONE", cents: 0 })
    expect(result.budgetChanges).toEqual([])
  })

  it("credits count toward the invariant so allocation is only raised by the shortfall", () => {
    const result = planOrderBranchRepair({
      orders: [ORDER_1472], branches: BRANCHES, accounts: ACCOUNTS,
      budgets: [budget({ id: 1, branchId: 243, period: "2026-08", amountAllocatedCents: 1_000_000, amountCreditedCents: 2_000_000 })],
      source: SOURCE,
    })
    const johar1 = result.budgetChanges.find((change) => change.branchId === 243)!
    expect(johar1.target).toEqual({ allocated: 1_697_000, spent: 0, held: 3_697_000, credited: 2_000_000 })
  })

  it("leaves correctly placed orders and unrelated budgets alone", () => {
    const result = planOrderBranchRepair({
      orders: [ORDER_OK_JOHAR_2], branches: BRANCHES, accounts: ACCOUNTS,
      budgets: [budget({ id: 1001, branchId: 244, period: "2026-08", amountAllocatedCents: 500_000, amountHeldCents: 500_000 })],
      source: SOURCE,
    })
    expect(result).toEqual({ moves: [], holds: [], unverifiableLegacyOrderIds: [], budgetChanges: [] })
  })

  it("ignores an order that was never imported", () => {
    const native = order({ orderId: 9, legacyOrderId: null, legacyLocationId: null, branchId: 244 })
    const result = planOrderBranchRepair({ orders: [native], branches: BRANCHES, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.moves).toEqual([])
    expect(result.unverifiableLegacyOrderIds).toEqual([])
  })

  it("lists an import whose payload carries no location as unverifiable, and never moves it", () => {
    const old = order({ orderId: 9, legacyOrderId: 60, legacyLocationId: null, legacyLocationName: null, branchId: 244 })
    const result = planOrderBranchRepair({ orders: [old], branches: BRANCHES, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.moves).toEqual([])
    expect(result.unverifiableLegacyOrderIds).toEqual([60])
  })

  it("holds an order whose legacy location has no pinned branch instead of matching by name", () => {
    const orphan = order({ orderId: 9, legacyOrderId: 9, branchId: 244, legacyLocationId: 900, legacyLocationName: "Johar ||" })
    const result = planOrderBranchRepair({ orders: [orphan], branches: BRANCHES, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.moves).toEqual([])
    expect(result.holds[0].reason).toBe("TARGET_BRANCH_NOT_PINNED")
    expect(result.holds[0].detail).toContain("sync:ke")
  })

  it("holds an order whose target has no order-portal account for a placeholder creator", () => {
    const misplaced = { ...ORDER_2519, legacyLocationId: 146, legacyLocationName: "Johar |" }
    const result = planOrderBranchRepair({
      orders: [misplaced], branches: BRANCHES, accounts: [PLACEHOLDER_226, AFSHAN_OP], budgets: [], source: SOURCE,
    })
    expect(result.moves).toEqual([])
    expect(result.holds[0].reason).toBe("NO_ACCOUNT_AT_TARGET")
    expect(result.budgetChanges).toEqual([])
  })

  it("holds when two branches are pinned to the order's location", () => {
    const doublePinned = [...BRANCHES, branch({ id: 999, name: "Johar | (dup)", externalId: "146" })]
    const result = planOrderBranchRepair({ orders: [ORDER_1472], branches: doublePinned, accounts: ACCOUNTS, budgets: [], source: SOURCE })
    expect(result.holds[0].reason).toBe("TARGET_BRANCH_AMBIGUOUS")
  })

  it("is deterministic regardless of input order", () => {
    const shuffled = planOrderBranchRepair({
      orders: [ORDER_OK_JOHAR_2, ORDER_1472, ORDER_2519], branches: [...BRANCHES].reverse(),
      accounts: [...ACCOUNTS].reverse(), budgets: [...budgets].reverse(), source: SOURCE,
    })
    expect(shuffled).toEqual(plan)
  })

  it("summarises the plan", () => {
    expect(summarizeOrderBranchRepair(plan)).toEqual({
      moves: 2,
      movedCents: 7_164_500,
      creatorRules: { BRANCH_ACCOUNT: 1, SAME_PERSON_AT_BRANCH: 1 },
      holds: 0,
      holdReasons: {},
      unverifiable: 0,
      budgetUpdates: 3,
      budgetInserts: 1,
      allocationRaisedCents: 3_697_000 + 3_467_500,
    })
  })
})

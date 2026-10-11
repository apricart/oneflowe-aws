import { describe, expect, it } from "vitest"

import {
  isPlaceholderAccount,
  personKey,
  planOrderCreatorRepair,
  summarizeOrderCreatorRepair,
  type CreatorRepairInput,
  type ImportedOrder,
  type OrganizationAccount,
  type PinnedBranch,
  type TakerMapping,
} from "./ke-order-creators"

const SOURCE = "KE_LOGISTICS"

const MARCOMM: PinnedBranch = { id: 282, name: "Marcomm", externalSource: SOURCE, externalId: "166" }
const ALMAWA: PinnedBranch = { id: 197, name: "ALMAWA", externalSource: SOURCE, externalId: "99" }
const CLUSTER_JOHAR: PinnedBranch = { id: 223, name: "Cluster Johar", externalSource: SOURCE, externalId: "125" }
const JOHAR_TECHNICAL: PinnedBranch = { id: 287, name: "Johar Technical", externalSource: SOURCE, externalId: "148" }
const HEALTH: PinnedBranch = { id: 283, name: "Health And Wellbeing", externalSource: SOURCE, externalId: "167" }

function account(overrides: Partial<OrganizationAccount> & Pick<OrganizationAccount, "userId" | "username">): OrganizationAccount {
  return {
    email: `${overrides.username}@ke.example`,
    fullName: null,
    firstName: null,
    lastName: null,
    role: "ORDER_PORTAL",
    branchId: null,
    isActive: true,
    isDeleted: false,
    externalSource: SOURCE,
    externalId: null,
    ...overrides,
  }
}

function placeholder(username: string, fullName: string, branchId: number): OrganizationAccount {
  return account({
    userId: `u-${username}`, username, email: `${username}@historical.invalid`,
    fullName, firstName: fullName, branchId, isActive: false, externalSource: null,
  })
}

let nextOrderId = 1000
function order(overrides: Partial<ImportedOrder> & Pick<ImportedOrder, "branchId" | "createdByUserId">): ImportedOrder {
  const orderId = overrides.orderId ?? nextOrderId++
  return {
    orderId,
    tid: `KE-LEGACY-${orderId}`,
    legacyOrderId: orderId,
    legacyTakerId: null,
    legacyTakerName: null,
    legacyLocationId: null,
    ...overrides,
  }
}

const TANVEER_PLACEHOLDER = placeholder("legacy_ke_loc166_user196", "Tanveer Ghori", MARCOMM.id)
const TANVEER = account({
  userId: "u-tanveer-op", username: "tanveer-10058-op", firstName: "Tanveer", lastName: "Ghori",
  fullName: "Tanveer Ghori", branchId: MARCOMM.id, externalId: "10058",
})
const TANVEER_BA = account({ ...TANVEER, userId: "u-tanveer-ba", username: "tanveer-10058-ba", role: "BRANCH_ADMIN" })

function tanveerOrder(orderId: number): ImportedOrder {
  return order({
    orderId, branchId: MARCOMM.id, createdByUserId: TANVEER_PLACEHOLDER.userId,
    legacyTakerId: 196, legacyTakerName: "Tanveer Ghori", legacyLocationId: 166,
  })
}

const TANVEER_MAPPING: TakerMapping = {
  id: 77, legacyOrderTakerId: 196, branchId: MARCOMM.id, userId: TANVEER_PLACEHOLDER.userId, isSynthetic: true,
}

function input(overrides: Partial<CreatorRepairInput>): CreatorRepairInput {
  return {
    orders: [],
    accounts: [],
    branches: [MARCOMM, ALMAWA, CLUSTER_JOHAR, JOHAR_TECHNICAL, HEALTH],
    mappings: [],
    source: SOURCE,
    ...overrides,
  }
}

describe("personKey", () => {
  it("ignores case, punctuation and spacing only", () => {
    expect(personKey("Muhammad Tahir .Shafi")).toBe(personKey("Muhammad Tahir Shafi"))
    expect(personKey("Burhanuddin Abbas .")).toBe(personKey("Burhanuddin Abbas"))
    expect(personKey("Muhammad-babar -")).toBe(personKey("Muhammad babar"))
    expect(personKey("Tanveer Ghori")).not.toBe(personKey("Tanveer Ghauri"))
    expect(personKey(null)).toBe("")
  })
})

describe("isPlaceholderAccount", () => {
  it("needs the username, the synthetic email and no external source together", () => {
    expect(isPlaceholderAccount(TANVEER_PLACEHOLDER)).toBe(true)
    expect(isPlaceholderAccount({ ...TANVEER_PLACEHOLDER, email: "tanveer@ke.com.pk" })).toBe(false)
    expect(isPlaceholderAccount({ ...TANVEER_PLACEHOLDER, externalSource: SOURCE })).toBe(false)
    expect(isPlaceholderAccount({ ...TANVEER_PLACEHOLDER, username: "tanveer-10058-op" })).toBe(false)
  })
})

describe("planOrderCreatorRepair", () => {
  it("moves a placeholder's orders to the one active ordering account of that name at that branch", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [tanveerOrder(1722), tanveerOrder(1897)],
      accounts: [TANVEER_PLACEHOLDER, TANVEER, TANVEER_BA],
      mappings: [TANVEER_MAPPING],
    }))

    expect(plan.holds).toEqual([])
    expect(plan.moves.map((move) => [move.orderId, move.from.username, move.to.username])).toEqual([
      [1722, "legacy_ke_loc166_user196", "tanveer-10058-op"],
      [1897, "legacy_ke_loc166_user196", "tanveer-10058-op"],
    ])
    expect(plan.mappingChanges).toEqual([{
      mappingId: 77, legacyOrderTakerId: 196, branchId: MARCOMM.id,
      from: { userId: TANVEER_PLACEHOLDER.userId, isSynthetic: true },
      to: { userId: TANVEER.userId, isSynthetic: false },
    }])
    expect(summarizeOrderCreatorRepair(plan)).toEqual({
      moves: 2, people: 1, mappingChanges: 1, holds: 0, holdsByReason: {},
    })
  })

  it("matches names that differ only in punctuation, against first and last name too", () => {
    const tahirPlaceholder = placeholder("legacy_ke_loc167_user197", "Muhammad Tahir .Shafi", HEALTH.id)
    const tahir = account({
      userId: "u-tahir", username: "muhammad-13645-op", firstName: "Muhammad", lastName: "Tahir Shafi",
      fullName: null, branchId: HEALTH.id, externalId: "13645",
    })
    const plan = planOrderCreatorRepair(input({
      orders: [order({
        orderId: 1761, branchId: HEALTH.id, createdByUserId: tahirPlaceholder.userId,
        legacyTakerId: 197, legacyTakerName: "Muhammad Tahir .Shafi", legacyLocationId: 167,
      })],
      accounts: [tahirPlaceholder, tahir],
    }))
    expect(plan.moves.map((move) => move.to.username)).toEqual(["muhammad-13645-op"])
  })

  it("leaves orders on active creators alone", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [order({
        orderId: 2089, branchId: MARCOMM.id, createdByUserId: TANVEER.userId,
        legacyTakerId: 196, legacyTakerName: "Tanveer Ghori", legacyLocationId: 166,
      })],
      accounts: [TANVEER],
    }))
    expect(plan).toEqual({ moves: [], mappingChanges: [], holds: [] })
  })

  it("never moves an order off a retired person — the login was reissued", () => {
    const retired = account({
      userId: "u-checking-11631-op", username: "checking-11631-op", fullName: "Syed Kashif Raza",
      branchId: ALMAWA.id, isActive: false, externalSource: "KE_LOGISTICS_RETIRED", externalId: "11631",
    })
    const currentHolder = account({
      userId: "u-syed-11631-op", username: "syed-11631-op", firstName: "Syed", lastName: "Musharaf Hassan",
      branchId: ALMAWA.id, externalId: "11631",
    })
    const plan = planOrderCreatorRepair(input({
      orders: [
        order({ orderId: 1003, branchId: ALMAWA.id, createdByUserId: retired.userId,
          legacyTakerId: 113, legacyTakerName: "Syed Kashif Raza -", legacyLocationId: 99 }),
        // Recorded under the new holder's name, yet still not provably theirs.
        order({ orderId: 1709, branchId: ALMAWA.id, createdByUserId: retired.userId,
          legacyTakerId: 113, legacyTakerName: "Syed Musharaf Hassan -", legacyLocationId: 99 }),
      ],
      accounts: [retired, currentHolder],
    }))
    expect(plan.moves).toEqual([])
    expect(plan.holds.map((hold) => [hold.orderId, hold.reason])).toEqual([
      [1003, "CREATOR_IS_A_PERSON"],
      [1709, "CREATOR_IS_A_PERSON"],
    ])
  })

  it("holds a placeholder whose legacy login was recorded under more than one name", () => {
    const shared = placeholder("legacy_ke_loc166_user196", "Tanveer Ghori", MARCOMM.id)
    const plan = planOrderCreatorRepair(input({
      orders: [
        tanveerOrder(1722),
        // The same login, on an order already attributed elsewhere, under another name.
        order({ orderId: 1500, branchId: MARCOMM.id, createdByUserId: TANVEER.userId,
          legacyTakerId: 196, legacyTakerName: "Someone Else", legacyLocationId: 166 }),
      ],
      accounts: [shared, TANVEER],
    }))
    expect(plan.moves).toEqual([])
    expect(plan.holds).toHaveLength(1)
    expect(plan.holds[0]).toMatchObject({ orderId: 1722, reason: "TAKER_NAME_CHANGED" })
  })

  it("does not count an order with no recorded name as a second name", () => {
    const headOffice = placeholder("legacy_ke_136_10", "Head Office K-Electric", 136)
    const plan = planOrderCreatorRepair(input({
      branches: [{ id: 136, name: "ACCOUNT PAYABLE", externalSource: SOURCE, externalId: "7" }],
      orders: [
        order({ orderId: 1259, branchId: 136, createdByUserId: headOffice.userId,
          legacyTakerId: 10, legacyTakerName: "Head Office K-Electric", legacyLocationId: 7 }),
        order({ orderId: 1297, branchId: 136, createdByUserId: headOffice.userId,
          legacyTakerId: 10, legacyTakerName: null, legacyLocationId: 7 }),
      ],
      accounts: [headOffice],
    }))
    expect(plan.holds.map((hold) => [hold.orderId, hold.reason])).toEqual([
      [1259, "NO_ACCOUNT_AT_BRANCH"],
      [1297, "NO_LEGACY_NAME"],
    ])
  })

  it("holds when the person's account is at another branch, and says where", () => {
    const nabeelPlaceholder = placeholder("legacy_ke_223_139", "Muhammad Nabeel Noor", CLUSTER_JOHAR.id)
    const nabeel = account({
      userId: "u-nabeel", username: "muhammad-12211-op", firstName: "Muhammad", lastName: "Nabeel Noor",
      branchId: JOHAR_TECHNICAL.id, externalId: "12211",
    })
    const plan = planOrderCreatorRepair(input({
      orders: [order({ orderId: 1149, branchId: CLUSTER_JOHAR.id, createdByUserId: nabeelPlaceholder.userId,
        legacyTakerId: 139, legacyTakerName: "Muhammad Nabeel Noor -", legacyLocationId: 125 })],
      accounts: [nabeelPlaceholder, nabeel],
    }))
    expect(plan.moves).toEqual([])
    expect(plan.holds[0].reason).toBe("NO_ACCOUNT_AT_BRANCH")
    expect(plan.holds[0].detail).toContain("muhammad-12211-op at \"Johar Technical\" (287)")
  })

  it("holds when two active accounts of that name are at the branch", () => {
    const twin = account({ ...TANVEER, userId: "u-tanveer-2", username: "tanveer-99999-op", externalId: "99999" })
    const plan = planOrderCreatorRepair(input({
      orders: [tanveerOrder(1722)],
      accounts: [TANVEER_PLACEHOLDER, TANVEER, twin],
    }))
    expect(plan.moves).toEqual([])
    expect(plan.holds[0].reason).toBe("AMBIGUOUS_ACCOUNT")
  })

  it("only targets active, undeleted, mirrored Order Portal accounts", () => {
    for (const target of [
      { ...TANVEER, isActive: false },
      { ...TANVEER, isDeleted: true },
      { ...TANVEER, role: "BRANCH_ADMIN" },
      { ...TANVEER, externalSource: null },
      { ...TANVEER, externalSource: "KE_LOGISTICS_RETIRED" },
    ]) {
      const plan = planOrderCreatorRepair(input({
        orders: [tanveerOrder(1722)],
        accounts: [TANVEER_PLACEHOLDER, target],
      }))
      expect(plan.moves).toEqual([])
      expect(plan.holds[0].reason).toBe("NO_ACCOUNT_AT_BRANCH")
    }
  })

  it("holds an order not at the branch its legacy location is pinned to", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [{ ...tanveerOrder(1722), legacyLocationId: 165 }],
      accounts: [TANVEER_PLACEHOLDER, TANVEER],
    }))
    expect(plan.holds[0].reason).toBe("BRANCH_NOT_AT_LEGACY_LOCATION")

    const unpinned = planOrderCreatorRepair(input({
      branches: [{ ...MARCOMM, externalSource: null }],
      orders: [tanveerOrder(1722)],
      accounts: [TANVEER_PLACEHOLDER, TANVEER],
    }))
    expect(unpinned.holds[0].reason).toBe("BRANCH_NOT_AT_LEGACY_LOCATION")
  })

  it("holds when the placeholder itself carries a different name", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [tanveerOrder(1722)],
      accounts: [{ ...TANVEER_PLACEHOLDER, fullName: "Someone Else", firstName: "Someone Else" }, TANVEER],
    }))
    expect(plan.holds[0].reason).toBe("PLACEHOLDER_NAME_DIFFERS")
  })

  it("holds an order with no legacy taker or no known creator", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [
        { ...tanveerOrder(1722), legacyTakerId: null },
        { ...tanveerOrder(1897), createdByUserId: "u-missing" },
        { ...tanveerOrder(1898), createdByUserId: null },
      ],
      accounts: [TANVEER_PLACEHOLDER, TANVEER],
    }))
    expect(plan.holds.map((hold) => [hold.orderId, hold.reason])).toEqual([
      [1722, "NO_LEGACY_TAKER"],
      [1897, "CREATOR_UNKNOWN"],
      [1898, "CREATOR_UNKNOWN"],
    ])
  })

  it("keeps the placeholder's mapping when any of its orders is held", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [tanveerOrder(1722), { ...tanveerOrder(1897), legacyTakerName: null }],
      accounts: [TANVEER_PLACEHOLDER, TANVEER],
      mappings: [TANVEER_MAPPING],
    }))
    expect(plan.moves.map((move) => move.orderId)).toEqual([1722])
    expect(plan.holds.map((hold) => hold.orderId)).toEqual([1897])
    expect(plan.mappingChanges).toEqual([])
  })

  it("leaves a mapping alone that names another taker or branch", () => {
    const plan = planOrderCreatorRepair(input({
      orders: [tanveerOrder(1722)],
      accounts: [TANVEER_PLACEHOLDER, TANVEER],
      mappings: [
        { ...TANVEER_MAPPING, id: 1, legacyOrderTakerId: 999 },
        { ...TANVEER_MAPPING, id: 2, branchId: ALMAWA.id },
      ],
    }))
    expect(plan.moves).toHaveLength(1)
    expect(plan.mappingChanges).toEqual([])
  })

  it("is independent of input order", () => {
    const base = {
      orders: [tanveerOrder(1897), tanveerOrder(1722)],
      accounts: [TANVEER_BA, TANVEER, TANVEER_PLACEHOLDER],
      mappings: [TANVEER_MAPPING],
    }
    const reversed = {
      orders: [...base.orders].reverse(),
      accounts: [...base.accounts].reverse(),
      mappings: base.mappings,
    }
    expect(planOrderCreatorRepair(input(base))).toEqual(planOrderCreatorRepair(input(reversed)))
  })
})

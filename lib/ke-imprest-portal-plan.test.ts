import { describe, expect, it } from "vitest"

import { planImprestAccounts, type ImprestPortalRow } from "./ke-imprest-portal-plan"

const base: ImprestPortalRow = {
  rowNumber: 2,
  branchName: "Branch One",
  employeeNumber: "100",
  adminName: "Malik Ahmed Ali Awan",
  adminEmail: "malik.ahmed@ke.com.pk",
  address: "Branch One address",
  contact: "0300-1111111",
  ordererName: "Ammar Bin Feroz",
  ordererEmail: "ammar@ke.com.pk",
}

const options = {
  repeatedAdminOrderer: true,
  separateRepeatedNamedOrderer: false,
  groupContact: "blank" as const,
}

describe("K-Electric imprest account planning", () => {
  it("turns a repeated admin into one group pair across all appearances", () => {
    const rows: ImprestPortalRow[] = [
      base,
      { ...base, rowNumber: 3, branchName: "Branch Two", address: "Branch Two address",
        contact: "0300-2222222", ordererName: "Second Orderer", ordererEmail: "second@ke.com.pk" },
      { ...base, rowNumber: 4, branchName: "Branch Three", address: "Branch Three address",
        contact: "0300-3333333", adminName: "Unique Admin", adminEmail: "unique@ke.com.pk",
        ordererName: "Malik Ahmed Ali Awan", ordererEmail: "malik.ahmed@ke.com.pk" },
    ]
    const accounts = planImprestAccounts(rows, options)
    const malik = accounts.filter((account) => account.email === base.adminEmail)
    expect(malik.map((account) => account.role)).toEqual(["GROUP_USER", "GROUP_ORDER_PORTAL"])
    expect(malik.map((account) => account.username)).toEqual([
      "malik.ahmedaliawan-ba", "malik.ahmedaliawan-op",
    ])
    expect(malik[0].branchNames).toEqual(["Branch One", "Branch Two"])
    expect(malik[1].branchNames).toEqual(["Branch One", "Branch Two", "Branch Three"])
    expect(malik.every((account) => account.phone === null && account.address === null)).toBe(true)
    expect(accounts.filter((account) => account.role === "ORDER_PORTAL")).toHaveLength(2)
    expect(accounts.find((account) => account.username === "ammar.binferoz-op")).toMatchObject({
      phone: "0300-1111111", address: "Branch One address", branchNames: ["Branch One"],
    })
  })

  it("uses the first listed branch contact for both group roles when requested", () => {
    const accounts = planImprestAccounts([
      base,
      { ...base, rowNumber: 3, branchName: "Branch Two", address: "Branch Two address",
        contact: "0300-2222222", ordererName: "Second Orderer", ordererEmail: "second@ke.com.pk" },
    ], { ...options, groupContact: "first" })
    const groupAccounts = accounts.filter((account) => account.role.startsWith("GROUP_"))
    expect(groupAccounts).toHaveLength(2)
    expect(groupAccounts.every((account) => account.phone === base.contact && account.address === base.address)).toBe(true)
  })

  it("refuses usernames that collide after name normalization", () => {
    expect(() => planImprestAccounts([
      base,
      { ...base, rowNumber: 3, branchName: "Branch Two", adminName: "Malik Ahmed-Ali Awan",
        adminEmail: "different@ke.com.pk", ordererName: "Another Orderer",
        ordererEmail: "another@ke.com.pk" },
    ], options)).toThrow(/Username malik\.ahmedaliawan-ba/)
  })

  it("refuses one email attached to different people", () => {
    expect(() => planImprestAccounts([
      base,
      { ...base, rowNumber: 3, branchName: "Branch Two", adminName: "Another Person",
        ordererName: "Second Orderer", ordererEmail: "second@ke.com.pk" },
    ], options)).toThrow(/different names/)
  })
})

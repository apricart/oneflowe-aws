import { describe, expect, it } from "vitest"

import {
  DEPARTMENTS,
  approverListError,
  createsChildBranch,
  crcError,
  deriveNameFromEmail,
  deriveUsernameFromEmail,
  initiatorRoleForBranchCount,
  isDepartment,
  joinUsesApprovalLevels,
  newBranchChoiceHierarchyError,
  newBranchDecisionHierarchyError,
  newBranchDraftErrors,
  newBranchFieldError,
  normalizeBranchName,
  normalizeCrc,
  requestedBranchCityError,
  requestedBranchHierarchyError,
  requestedBranchLocation,
  requestedBranchNameError,
  requestedHierarchyOf,
  requestedNewBranches,
  requestedParentBranchIds,
  splitFullName,
  UNLISTED_CITY_MESSAGE,
} from "./join-department-signup"

/** plans/OF-JOIN-department-signup-multi-user.md */

describe("joinUsesApprovalLevels — which join form an organization takes", () => {
  it("is the department sign-up only with approval required, levels on, and at least one level", () => {
    expect(joinUsesApprovalLevels({ orderApprovalRequired: true, orderApprovalLevelsEnabled: true, levelCount: 3 })).toBe(true)
  })

  it.each([
    ["approval not required", { orderApprovalRequired: false, orderApprovalLevelsEnabled: true, levelCount: 3 }],
    ["levels switched off", { orderApprovalRequired: true, orderApprovalLevelsEnabled: false, levelCount: 3 }],
    ["no levels saved", { orderApprovalRequired: true, orderApprovalLevelsEnabled: true, levelCount: 0 }],
  ])("keeps the standard form when %s", (_case, organization) => {
    expect(joinUsesApprovalLevels(organization)).toBe(false)
  })
})

describe("initiatorRoleForBranchCount", () => {
  it("gives one CRC the shop and more than one the group storefront", () => {
    expect(initiatorRoleForBranchCount(1)).toBe("ORDER_PORTAL")
    expect(initiatorRoleForBranchCount(2)).toBe("GROUP_ORDER_PORTAL")
    expect(initiatorRoleForBranchCount(10)).toBe("GROUP_ORDER_PORTAL")
  })
})

describe("names and usernames from an email", () => {
  it("takes the username from the part before the @, lower-cased", () => {
    expect(deriveUsernameFromEmail("Huzaifa.Abid@ubl.com.pk")).toBe("huzaifa.abid")
    expect(deriveUsernameFromEmail("solo")).toBe("solo")
  })

  it("makes an approver's name from the address alone", () => {
    expect(deriveNameFromEmail("huzaifa.abid@ubl.com.pk")).toEqual({ firstName: "Huzaifa", lastName: "Abid" })
    expect(deriveNameFromEmail("ali_raza-khan@ubl.com.pk")).toEqual({ firstName: "Ali", lastName: "Raza Khan" })
    expect(deriveNameFromEmail("zain@ubl.com.pk")).toEqual({ firstName: "Zain", lastName: "" })
  })

  it("splits a complete name into first and last", () => {
    expect(splitFullName("  Muhammad  Ali Khan ")).toEqual({ firstName: "Muhammad", lastName: "Ali Khan" })
    expect(splitFullName("Madonna")).toEqual({ firstName: "Madonna", lastName: "" })
  })
})

describe("CRC numbers", () => {
  it("are trimmed and upper-cased", () => {
    expect(normalizeCrc("  ab-abc-123 ")).toBe("AB-ABC-123")
  })

  it("accept letters, digits and inner dashes only", () => {
    expect(crcError("AB-ABC-123")).toBeNull()
    expect(crcError("12345")).toBeNull()
    expect(crcError("")).toMatch(/Enter/)
    expect(crcError("-AB")).toMatch(/letters, numbers/)
    expect(crcError("AB 12")).toMatch(/letters, numbers/)
    expect(crcError("A".repeat(33))).toMatch(/at most 32/)
  })
})

describe("new branches", () => {
  it("take the applicant's name, trimmed with inner spaces collapsed", () => {
    expect(normalizeBranchName("  Korangi   Depot ")).toBe("Korangi Depot")
    expect(normalizeBranchName(undefined)).toBe("")
    expect(requestedBranchNameError("Korangi Depot")).toBeNull()
    expect(requestedBranchNameError("  ")).toBe("Enter the branch name")
    expect(requestedBranchNameError("K")).toBe("The branch name needs at least 2 characters")
    expect(requestedBranchNameError("x".repeat(101))).toBe("The branch name can be at most 100 characters")
  })

  it("are one per CRC, normalised, keeping the first name and the first city given", () => {
    expect(requestedNewBranches([
      { branchId: 4 },
      { crc: " ab-1 ", name: " Korangi  Depot ", city: "karachi", province: "Sindh" },
      { crc: "AB-1", name: "Another name", city: "Lahore", province: "Punjab" },
      { crc: "cd-2" },
      { crc: "CD-2", name: "Saddar", city: "Hyderabad", province: "Sindh" },
    ])).toEqual([
      { crc: "AB-1", name: "Korangi Depot", city: "Karachi", province: "Sindh", hierarchy: null },
      { crc: "CD-2", name: "Saddar", city: "Hyderabad", province: "Sindh", hierarchy: null },
    ])
  })

  it("leave a CRC with no name or city without them, for Head Office to give at review", () => {
    expect(requestedNewBranches([{ crc: "OLD-1" }, { crc: "OLD-2", name: "  " }]))
      .toEqual([
        { crc: "OLD-1", name: null, city: null, province: null, hierarchy: null },
        { crc: "OLD-2", name: null, city: null, province: null, hierarchy: null },
      ])
  })

  it("take the province from the list, never from what was sent with the city", () => {
    expect(requestedBranchLocation(" KARACHI ")).toEqual({ city: "Karachi", province: "Sindh" })
    expect(requestedBranchLocation("Karachee")).toEqual({ city: null, province: null })
    expect(requestedBranchLocation(undefined)).toEqual({ city: null, province: null })
    expect(requestedNewBranches([{ crc: "AB-1", name: "Depot", city: "Karachi", province: "Punjab" }]))
      .toEqual([{ crc: "AB-1", name: "Depot", city: "Karachi", province: "Sindh", hierarchy: null }])
  })

  it("refuse a blank, unlisted or mis-provinced city", () => {
    expect(requestedBranchCityError("Karachi")).toBeNull()
    expect(requestedBranchCityError("karachi", "Sindh")).toBeNull()
    expect(requestedBranchCityError(" ")).toBe("Choose the city of the new branch")
    expect(requestedBranchCityError("Karachee")).toBe(UNLISTED_CITY_MESSAGE)
    expect(requestedBranchCityError("Karachi", "Punjab")).toBe("Karachi is in Sindh")
  })
})

describe("a new branch's proposed type (plans/OF-JOIN-new-branch-parent-child.md)", () => {
  const branch = (crc: string, hierarchy: Parameters<typeof requestedHierarchyOf>[0] = {}) => ({
    crc, name: `Branch ${crc}`, city: null, province: null, hierarchy: requestedHierarchyOf(hierarchy),
  })

  it("is read from an entry, normalised; none when no type is given", () => {
    expect(requestedHierarchyOf({})).toBeNull()
    expect(requestedHierarchyOf({ hierarchyRole: null, parentBranchId: 3 })).toBeNull()
    expect(requestedHierarchyOf({ hierarchyRole: "CHILD", parentCrc: " ab-1 " }))
      .toEqual({ hierarchyRole: "CHILD", parentBranchId: null, parentCrc: "AB-1" })
    expect(requestedHierarchyOf({ hierarchyRole: "PARENT", parentCrc: "  " }))
      .toEqual({ hierarchyRole: "PARENT", parentBranchId: null, parentCrc: null })
  })

  it("keeps the first type given for a CRC listed twice", () => {
    expect(requestedNewBranches([
      { crc: "AB-1" },
      { crc: "ab-1", hierarchyRole: "PARENT" },
      { crc: "AB-1", hierarchyRole: "CHILD", parentBranchId: 4 },
    ])[0].hierarchy).toEqual({ hierarchyRole: "PARENT", parentBranchId: null, parentCrc: null })
  })

  it("accepts a parent with children, a child of an existing parent, and branches with no type", () => {
    expect(requestedBranchHierarchyError([
      branch("P-1", { hierarchyRole: "PARENT" }),
      branch("C-1", { hierarchyRole: "CHILD", parentCrc: "p-1" }),
      branch("C-2", { hierarchyRole: "CHILD", parentBranchId: 9 }),
      branch("S-1", { hierarchyRole: "STANDALONE" }),
      branch("OLD-1"),
    ])).toBeNull()
  })

  it.each([
    ["a child with no parent", [branch("C-1", { hierarchyRole: "CHILD" })], /choose its parent branch/],
    ["a child with two parents", [branch("P-1", { hierarchyRole: "PARENT" }), branch("C-1", { hierarchyRole: "CHILD", parentBranchId: 9, parentCrc: "P-1" })], /choose one parent branch/],
    ["a child of itself", [branch("C-1", { hierarchyRole: "CHILD", parentCrc: "C-1" })], /cannot be its own parent/],
    ["a parent with a parent", [branch("P-1", { hierarchyRole: "PARENT", parentBranchId: 9 })], /only a child branch has a parent/],
    ["a standalone with a parent", [branch("S-1", { hierarchyRole: "STANDALONE", parentCrc: "X" })], /only a child branch has a parent/],
    ["a child of a CRC not on the list", [branch("C-1", { hierarchyRole: "CHILD", parentCrc: "GONE" })], /marked Parent/],
    ["a child of a branch not proposed as Parent", [branch("S-1", { hierarchyRole: "STANDALONE" }), branch("C-1", { hierarchyRole: "CHILD", parentCrc: "S-1" })], /marked Parent/],
    ["a child of another child", [branch("P-1", { hierarchyRole: "PARENT" }), branch("C-1", { hierarchyRole: "CHILD", parentCrc: "P-1" }), branch("C-2", { hierarchyRole: "CHILD", parentCrc: "C-1" })], /marked Parent/],
  ])("refuses %s", (_case, branches, message) => {
    expect(requestedBranchHierarchyError(branches)).toMatch(message)
  })

  it("names the existing parents once each", () => {
    expect(requestedParentBranchIds([
      branch("C-1", { hierarchyRole: "CHILD", parentBranchId: 9 }),
      branch("C-2", { hierarchyRole: "CHILD", parentBranchId: 9 }),
      branch("C-3", { hierarchyRole: "CHILD", parentCrc: "P" }),
    ])).toEqual([9])
  })
})

describe("Head Office's type for a branch created at approval", () => {
  it("is Standalone with nothing, and refuses a parent on anything but a child", () => {
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1 })).toBeNull()
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, hierarchyRole: "PARENT", parentBranchId: 3 }))
      .toBe("Only a child branch has a parent branch")
  })

  it("asks a child for exactly one parent, never itself", () => {
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, hierarchyRole: "CHILD" })).toMatch(/Choose the parent/)
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, hierarchyRole: "CHILD", parentBranchId: 3, parentRequestBranchId: 2 }))
      .toMatch(/Choose one parent/)
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, hierarchyRole: "CHILD", parentRequestBranchId: 1 })).toMatch(/own parent/)
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, hierarchyRole: "CHILD", parentBranchId: 3 })).toBeNull()
  })

  it("gives a CRC mapped onto an existing branch no type", () => {
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, mapToBranchId: 5 })).toBeNull()
    expect(newBranchChoiceHierarchyError({ requestBranchId: 1, mapToBranchId: 5, hierarchyRole: "PARENT" })).toMatch(/keeps that branch's type/)
  })

  it("lets a child name only a branch this approval creates as Parent", () => {
    const parent = { requestBranchId: 1, hierarchyRole: "PARENT" as const }
    const child = { requestBranchId: 2, hierarchyRole: "CHILD" as const, parentRequestBranchId: 1 }
    expect(newBranchDecisionHierarchyError([parent, child])).toBeNull()
    expect(newBranchDecisionHierarchyError([child])).toMatch(/created here as Parent/)
    expect(newBranchDecisionHierarchyError([{ requestBranchId: 1 }, child])).toMatch(/created here as Parent/)
    expect(newBranchDecisionHierarchyError([{ requestBranchId: 1, mapToBranchId: 5 }, child])).toMatch(/created here as Parent/)
  })

  it("creates children after every other branch", () => {
    expect(createsChildBranch({ requestBranchId: 2, hierarchyRole: "CHILD", parentBranchId: 3 })).toBe(true)
    expect(createsChildBranch({ requestBranchId: 2, hierarchyRole: "PARENT" })).toBe(false)
    expect(createsChildBranch({ requestBranchId: 2, mapToBranchId: 5 })).toBe(false)
    expect(createsChildBranch(undefined)).toBe(false)
  })
})

describe("departments", () => {
  it("are the design's nine, and nothing else", () => {
    expect(DEPARTMENTS).toHaveLength(9)
    expect(isDepartment("Finance")).toBe(true)
    expect(isDepartment("finance")).toBe(false)
  })
})

describe("approverListError", () => {
  const base = {
    initiatorEmail: "initiator@ubl.com.pk",
    levelCount: 2,
    emailDomain: "ubl.com.pk",
  }
  const approvers = [
    { level: 1, email: "first.approver@ubl.com.pk", designation: "Manager" },
    { level: 2, email: "second.approver@ubl.com.pk", designation: "Head" },
  ]

  it("accepts one approver per level at the domain", () => {
    expect(approverListError({ ...base, approvers })).toBeNull()
  })

  it("requires every level, and no extra one", () => {
    expect(approverListError({ ...base, approvers: approvers.slice(0, 1) })).toMatch(/each of the 2/)
    expect(approverListError({ ...base, approvers: [...approvers, { level: 3, email: "x@ubl.com.pk", designation: "X X" }] }))
      .toMatch(/each of the 2/)
    expect(approverListError({ ...base, approvers: [approvers[0], { ...approvers[1], level: 1 }] })).toMatch(/each of the 2/)
  })

  it("refuses another domain, a subdomain, the initiator and a repeated person", () => {
    expect(approverListError({ ...base, approvers: [approvers[0], { ...approvers[1], email: "x@gmail.com" }] }))
      .toMatch(/Level 2: use an @ubl.com.pk/)
    expect(approverListError({ ...base, approvers: [approvers[0], { ...approvers[1], email: "x@mail.ubl.com.pk" }] }))
      .toMatch(/Level 2: use an @ubl.com.pk/)
    expect(approverListError({ ...base, approvers: [approvers[0], { ...approvers[1], email: "INITIATOR@ubl.com.pk" }] }))
      .toMatch(/cannot be the person placing the orders/)
    expect(approverListError({ ...base, approvers: [approvers[0], { ...approvers[1], email: approvers[0].email }] }))
      .toMatch(/different approver/)
  })
})

describe("newBranchFieldError — the details Head Office gives a new branch at review", () => {
  it("asks for a field left empty or only spaces, by name", () => {
    expect(newBranchFieldError("province", "")).toBe("Enter the province")
    expect(newBranchFieldError("city", "   ")).toBe("Enter the city")
  })

  it("names the field and its minimum when too short", () => {
    expect(newBranchFieldError("province", "S")).toBe("The province needs at least 2 characters")
    expect(newBranchFieldError("address", "B-12")).toBe("The branch address needs at least 5 characters")
  })

  it("accepts exactly the minimum and exactly the maximum, after trimming", () => {
    expect(newBranchFieldError("city", " KH ")).toBeNull()
    expect(newBranchFieldError("name", "x".repeat(100))).toBeNull()
    expect(newBranchFieldError("address", "x".repeat(500))).toBeNull()
  })

  it("names the field and its maximum when too long", () => {
    expect(newBranchFieldError("name", "x".repeat(101))).toBe("The branch name can be at most 100 characters")
  })
})

describe("newBranchDraftErrors", () => {
  it("is empty when every field is acceptable", () => {
    expect(newBranchDraftErrors({ name: "DEMOTTTT", province: "Sindh", city: "Karachi", address: "Plot 4, Clifton" })).toEqual({})
  })

  it("lists every field that is not, and only those", () => {
    expect(newBranchDraftErrors({ name: "DEMOTTTT", province: "", city: "K", address: "Plot 4, Clifton" })).toEqual({
      province: "Enter the province",
      city: "The city needs at least 2 characters",
    })
  })

  // plans/OF-JOIN-new-branch-city-warehouse.md
  it("asks for a city from the list rather than one typed", () => {
    expect(newBranchDraftErrors({ name: "DEMOTTTT", province: "Sindh", city: "Karachee", address: "Plot 4, Clifton" })).toEqual({
      city: UNLISTED_CITY_MESSAGE,
    })
  })

  it("names the province a city is in when another was given", () => {
    expect(newBranchDraftErrors({ name: "DEMOTTTT", province: "Punjab", city: "karachi", address: "Plot 4, Clifton" })).toEqual({
      province: "Karachi is in Sindh",
    })
  })
})

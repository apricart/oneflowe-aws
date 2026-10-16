import { describe, expect, it } from "vitest"

import {
  DEPARTMENTS,
  approverListError,
  crcError,
  deriveNameFromEmail,
  deriveUsernameFromEmail,
  initiatorRoleForBranchCount,
  isDepartment,
  joinUsesApprovalLevels,
  newBranchDraftErrors,
  newBranchFieldError,
  normalizeCrc,
  splitFullName,
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
})

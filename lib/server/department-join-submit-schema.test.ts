import { describe, expect, it } from "vitest"

import { departmentJoinSubmitSchema } from "./mutation-validation"

/**
 * The public department sign-up body (plans/OF-JOIN-department-signup-multi-user.md):
 * every branch is an existing one picked by id, or a new one with a name of
 * its own, its CRC number — never a CRC alone, which is how branches came to be
 * created named after their cost centre — and the listed city it is in with
 * that city's province (plans/OF-JOIN-applicant-new-branch-city.md).
 */
const KARACHI = { city: "Karachi", province: "Sindh" }
const valid = {
  formVersion: 2,
  code: "DEMO-JOIN-2026",
  fullName: "Huzaifa Abid",
  email: "huzaifa.abid@demo.test",
  password: "Str0ng!Password",
  phone: "03001234567",
  ipExtension: "1234",
  employeeId: "E-1",
  department: "Finance",
  branches: [{ branchId: 4 }, { name: "Korangi Depot", crc: "AB-ABC-123", ...KARACHI }],
  addresses: ["Plot 1, Clifton, Karachi"],
  approvers: [{ level: 1, email: "first.approver@demo.test", designation: "Head of Finance" }],
  termsAccepted: true,
  emailVerification: { challengeId: "6f0c3a52-8a3f-4b8e-9a37-0c2b0d4e5f61", proof: "a".repeat(43) },
}

const parse = (body: Record<string, unknown>) => departmentJoinSubmitSchema.safeParse(body)

describe("departmentJoinSubmitSchema — branches", () => {
  it("accepts an existing branch and a new branch given its name, CRC, city and province", () => {
    const parsed = parse(valid)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.branches[1]).toEqual({ name: "Korangi Depot", crc: "AB-ABC-123", ...KARACHI })
  })

  it("trims a new branch's name and CRC, and takes the list's spelling of its city", () => {
    const parsed = parse({ ...valid, branches: [{ name: "  Korangi Depot ", crc: " AB-1 ", city: "  KARACHI ", province: " Sindh " }] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.branches[0]).toEqual({ name: "Korangi Depot", crc: "AB-1", ...KARACHI })
  })

  it.each([
    ["a CRC with no name", [{ crc: "AB-1", ...KARACHI }]],
    ["a name with no CRC", [{ name: "Korangi Depot", ...KARACHI }]],
    ["a name too short", [{ name: "K", crc: "AB-1", ...KARACHI }]],
    ["a blank name", [{ name: "   ", crc: "AB-1", ...KARACHI }]],
    ["a name too long", [{ name: "x".repeat(101), crc: "AB-1", ...KARACHI }]],
    ["a CRC too long", [{ name: "Korangi Depot", crc: "A".repeat(33), ...KARACHI }]],
    ["an existing branch with a name", [{ branchId: 4, name: "Korangi Depot" }]],
    ["an existing branch with a city", [{ branchId: 4, ...KARACHI }]],
    ["a new branch with no city or province", [{ name: "Korangi Depot", crc: "AB-1" }]],
    ["a new branch with a city but no province", [{ name: "Korangi Depot", crc: "AB-1", city: "Karachi" }]],
    ["a new branch with a province but no city", [{ name: "Korangi Depot", crc: "AB-1", province: "Sindh" }]],
    ["a city not on the list", [{ name: "Korangi Depot", crc: "AB-1", city: "Karachee", province: "Sindh" }]],
    ["a province that is not the city's", [{ name: "Korangi Depot", crc: "AB-1", city: "Karachi", province: "Punjab" }]],
    ["a blank city", [{ name: "Korangi Depot", crc: "AB-1", city: " ", province: "Sindh" }]],
    ["a city that is not a string", [{ name: "Korangi Depot", crc: "AB-1", city: 7, province: "Sindh" }]],
    ["an unknown field", [{ name: "Korangi Depot", crc: "AB-1", ...KARACHI, address: "Plot 4" }]],
  ])("refuses %s", (_case, branches) => {
    expect(parse({ ...valid, branches }).success).toBe(false)
  })

  it("accepts a name at exactly the bounds", () => {
    expect(parse({ ...valid, branches: [{ name: "KD", crc: "AB-1", ...KARACHI }] }).success).toBe(true)
    expect(parse({ ...valid, branches: [{ name: "x".repeat(100), crc: "AB-1", ...KARACHI }] }).success).toBe(true)
  })
})

describe("departmentJoinSubmitSchema — a new branch's type (plans/OF-JOIN-new-branch-parent-child.md)", () => {
  const parentBranch = { name: "Gulshan Hub", crc: "PAR-1", ...KARACHI, hierarchyRole: "PARENT" }
  const branchesOf = (...branches: Array<Record<string, unknown>>) => parse({ ...valid, branches })

  it("accepts a parent and its child on the same request, and a child of an existing branch", () => {
    const parsed = branchesOf(
      parentBranch,
      { name: "Gulshan Block 2", crc: "KID-1", ...KARACHI, hierarchyRole: "CHILD", parentCrc: " par-1 " },
      { name: "North Kiosk", crc: "KID-2", ...KARACHI, hierarchyRole: "CHILD", parentBranchId: 7 },
    )
    expect(parsed.success).toBe(true)
  })

  it("still accepts a new branch sent without a type", () => {
    expect(branchesOf({ name: "Korangi Depot", crc: "AB-1", ...KARACHI }).success).toBe(true)
  })

  it.each([
    ["an unknown type", [{ ...parentBranch, hierarchyRole: "GRANDPARENT" }]],
    ["a child with no parent", [{ ...parentBranch, hierarchyRole: "CHILD" }]],
    ["a child with two parents", [parentBranch, { ...parentBranch, crc: "KID-1", name: "Kid", hierarchyRole: "CHILD", parentCrc: "PAR-1", parentBranchId: 7 }]],
    ["a parent naming a parent", [{ ...parentBranch, parentBranchId: 7 }]],
    ["a parent with no type", [{ name: "Kid", crc: "KID-1", ...KARACHI, parentBranchId: 7 }]],
    ["a child of itself", [{ ...parentBranch, hierarchyRole: "CHILD", parentCrc: "PAR-1" }]],
    ["a child of a CRC not on the request", [{ ...parentBranch, hierarchyRole: "CHILD", parentCrc: "ELSEWHERE" }]],
    ["a child of a new branch not marked Parent", [{ ...parentBranch, hierarchyRole: "STANDALONE" }, { name: "Kid", crc: "KID-1", ...KARACHI, hierarchyRole: "CHILD", parentCrc: "PAR-1" }]],
    ["a type on an existing branch", [{ branchId: 4, hierarchyRole: "PARENT" }]],
  ])("refuses %s", (_case, branches) => {
    expect(branchesOf(...branches).success).toBe(false)
  })
})

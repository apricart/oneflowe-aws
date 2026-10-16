import { describe, expect, it } from "vitest"

import { departmentJoinSubmitSchema } from "./mutation-validation"

/**
 * The public department sign-up body (plans/OF-JOIN-department-signup-multi-user.md):
 * every branch is an existing one picked by id, or a new one with both a name
 * of its own and its CRC number — never a CRC alone, which is how branches
 * came to be created named after their cost centre.
 */
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
  branches: [{ branchId: 4 }, { name: "Korangi Depot", crc: "AB-ABC-123" }],
  addresses: ["Plot 1, Clifton, Karachi"],
  approvers: [{ level: 1, email: "first.approver@demo.test", designation: "Head of Finance" }],
  termsAccepted: true,
}

const parse = (body: Record<string, unknown>) => departmentJoinSubmitSchema.safeParse(body)

describe("departmentJoinSubmitSchema — branches", () => {
  it("accepts an existing branch and a new branch given its name and CRC", () => {
    const parsed = parse(valid)
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.branches[1]).toEqual({ name: "Korangi Depot", crc: "AB-ABC-123" })
  })

  it("trims a new branch's name and CRC", () => {
    const parsed = parse({ ...valid, branches: [{ name: "  Korangi Depot ", crc: " AB-1 " }] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.branches[0]).toEqual({ name: "Korangi Depot", crc: "AB-1" })
  })

  it.each([
    ["a CRC with no name", [{ crc: "AB-1" }]],
    ["a name with no CRC", [{ name: "Korangi Depot" }]],
    ["a name too short", [{ name: "K", crc: "AB-1" }]],
    ["a blank name", [{ name: "   ", crc: "AB-1" }]],
    ["a name too long", [{ name: "x".repeat(101), crc: "AB-1" }]],
    ["a CRC too long", [{ name: "Korangi Depot", crc: "A".repeat(33) }]],
    ["an existing branch with a name", [{ branchId: 4, name: "Korangi Depot" }]],
    ["an unknown field", [{ name: "Korangi Depot", crc: "AB-1", city: "Karachi" }]],
  ])("refuses %s", (_case, branches) => {
    expect(parse({ ...valid, branches }).success).toBe(false)
  })

  it("accepts a name at exactly the bounds", () => {
    expect(parse({ ...valid, branches: [{ name: "KD", crc: "AB-1" }] }).success).toBe(true)
    expect(parse({ ...valid, branches: [{ name: "x".repeat(100), crc: "AB-1" }] }).success).toBe(true)
  })
})

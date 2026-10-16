import { describe, expect, it } from "vitest"

import { departmentJoinUpdateSchema } from "./mutation-validation"

/**
 * Head Office correcting a pending department sign-up. Every field the
 * applicant typed may be sent, and nothing the applicant could not send —
 * least of all a password, a role, a status or a tenant.
 */
const valid = {
  firstName: "Sana",
  lastName: "Mir",
  email: "Sana.Mir@Demo.Test",
  username: "Sana.Mir",
  phone: "03001234567",
  ipExtension: "1234",
  employeeId: "E-7",
  department: "Finance",
  branches: [{ branchId: 5 }, { crc: "CRC-9" }],
  addresses: ["Plot 4, Clifton"],
  approvers: [{ level: 1, email: "one@demo.test", designation: "Director" }],
}

const parse = (update: Record<string, unknown>) => departmentJoinUpdateSchema.safeParse({ update })

describe("departmentJoinUpdateSchema", () => {
  it("accepts a complete edit and lower-cases the identities", () => {
    const parsed = parse(valid)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.update.email).toBe("sana.mir@demo.test")
      expect(parsed.data.update.username).toBe("sana.mir")
    }
  })

  it("accepts an empty last name", () => {
    expect(parse({ ...valid, lastName: "" }).success).toBe(true)
  })

  it.each(["password", "passwordHash", "termsAccepted", "organizationId", "role", "status", "requestedRole", "createdUserId"])(
    "refuses %s, which Head Office may not set",
    (field) => {
      expect(parse({ ...valid, [field]: "x" }).success).toBe(false)
    },
  )

  it("refuses a field beside the update", () => {
    expect(departmentJoinUpdateSchema.safeParse({ update: valid, decision: "approve" }).success).toBe(false)
  })

  it.each([
    ["firstName", ""],
    ["email", "not-an-email"],
    ["username", "a b"],
    ["username", "ab"],
    ["phone", "3001234567"],
    ["ipExtension", "12"],
    ["employeeId", ""],
    ["department", "Nowhere"],
    ["branches", []],
    ["branches", [{ branchId: 5 }, { branchId: 5 }]],
    ["branches", [{ crc: "a-1" }, { crc: "A-1" }]],
    ["branches", [{ branchId: 5, crc: "A-1" }]],
    ["addresses", []],
    ["addresses", ["abc"]],
    ["addresses", ["Plot 4, Clifton", "plot 4, clifton"]],
    ["approvers", []],
    ["approvers", [{ level: 1, email: "one@demo.test", designation: "Director", userId: "x" }]],
  ])("refuses %s = %j", (field, value) => {
    expect(parse({ ...valid, [field]: value }).success).toBe(false)
  })
})

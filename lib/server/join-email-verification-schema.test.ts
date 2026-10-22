import { describe, expect, it } from "vitest"

import {
  departmentJoinSubmitSchema,
  joinEmailCodeRequestSchema,
  joinEmailCodeVerifySchema,
  joinRequestSubmitSchema,
} from "./mutation-validation"

/**
 * The bodies of the join page's email proof (plans/OF-JOIN-email-otp-verification.md):
 * asking for a code, entering it, and carrying the proof on either submission.
 */
const CHALLENGE_ID = "6f0c3a52-8a3f-4b8e-9a37-0c2b0d4e5f61"
const PROOF = "Ab0_-".repeat(8) + "xyz"
const verification = { challengeId: CHALLENGE_ID, proof: PROOF }

describe("joinEmailCodeRequestSchema", () => {
  it("takes the join code and the address, normalising the code", () => {
    const parsed = joinEmailCodeRequestSchema.safeParse({ code: "demo-join-2026", email: " ada@demo.test " })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual({ code: "DEMO-JOIN-2026", email: "ada@demo.test" })
  })

  it.each([
    ["an organization id", { organizationId: 4 }],
    ["an email domain", { emailDomain: "evil.test" }],
  ])("refuses %s", (_label, extra) => {
    expect(joinEmailCodeRequestSchema.safeParse({ code: "DEMO-JOIN-2026", email: "ada@demo.test", ...extra }).success)
      .toBe(false)
  })

  it.each(["", "ada", "ada@", `${"a".repeat(250)}@demo.test`])("refuses the address %j", (email) => {
    expect(joinEmailCodeRequestSchema.safeParse({ code: "DEMO-JOIN-2026", email }).success).toBe(false)
  })

  it("refuses a missing or malformed code", () => {
    expect(joinEmailCodeRequestSchema.safeParse({ email: "ada@demo.test" }).success).toBe(false)
    expect(joinEmailCodeRequestSchema.safeParse({ code: "ab", email: "ada@demo.test" }).success).toBe(false)
  })
})

describe("joinEmailCodeVerifySchema", () => {
  it("takes the challenge and six digits", () => {
    expect(joinEmailCodeVerifySchema.safeParse({ challengeId: CHALLENGE_ID, otp: " 012345 " }).success).toBe(true)
  })

  it.each(["12345", "1234567", "12a456", ""])("refuses the code %j", (otp) => {
    expect(joinEmailCodeVerifySchema.safeParse({ challengeId: CHALLENGE_ID, otp }).success).toBe(false)
  })

  it("refuses a challenge that is not a UUID, and any other field", () => {
    expect(joinEmailCodeVerifySchema.safeParse({ challengeId: "1", otp: "123456" }).success).toBe(false)
    expect(joinEmailCodeVerifySchema.safeParse({ challengeId: CHALLENGE_ID, otp: "123456", email: "a@b.test" }).success)
      .toBe(false)
  })
})

const standard = {
  code: "DEMO-JOIN-2026",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@demo.test",
  username: "ada",
  password: "Str0ng!Password",
  role: "ORDER_PORTAL",
  branchId: 4,
}

const department = {
  formVersion: 2,
  code: "DEMO-JOIN-2026",
  fullName: "Huzaifa Abid",
  email: "huzaifa.abid@demo.test",
  password: "Str0ng!Password",
  phone: "03001234567",
  ipExtension: "1234",
  employeeId: "E-1",
  department: "Finance",
  branches: [{ branchId: 4 }],
  addresses: ["Plot 1, Clifton, Karachi"],
  approvers: [{ level: 1, email: "first.approver@demo.test", designation: "Head of Finance" }],
  termsAccepted: true,
}

describe.each([
  ["the standard submission", joinRequestSubmitSchema, standard],
  ["the department sign-up", departmentJoinSubmitSchema, department],
] as const)("%s carries the email proof", (_label, schema, body) => {
  it("accepts a well-formed proof", () => {
    expect(schema.safeParse({ ...body, emailVerification: verification }).success).toBe(true)
  })

  it("refuses a submission without one", () => {
    const parsed = schema.safeParse(body)
    expect(parsed.success).toBe(false)
  })

  it.each([
    ["a short proof", { challengeId: CHALLENGE_ID, proof: "abc" }],
    ["a proof with padding", { challengeId: CHALLENGE_ID, proof: `${PROOF.slice(0, 42)}=` }],
    ["a challenge that is not a UUID", { challengeId: "x", proof: PROOF }],
    ["an extra field", { ...verification, email: "someone@demo.test" }],
    ["a bare string", PROOF],
  ])("refuses %s", (_case, emailVerification) => {
    expect(schema.safeParse({ ...body, emailVerification }).success).toBe(false)
  })
})

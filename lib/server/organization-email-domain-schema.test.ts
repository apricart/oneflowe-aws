import { describe, expect, it } from "vitest"

import {
  organizationCreateSchema,
  organizationUpdateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

/**
 * The email domain as the organization endpoints receive it.
 *
 * The schema is where a domain is normalised, so the route stores exactly what
 * this returns: these cases are what reaches `organizations.email_domain`.
 */

const validCreate = { name: "Acme Inc.", code: "ACME" }

describe("organizationCreateSchema.emailDomain", () => {
  it("is optional, and absent stays absent", () => {
    const parsed = organizationCreateSchema.parse(validCreate)
    expect(parsed.emailDomain).toBeUndefined()
  })

  it.each([
    ["ke.com.pk", "ke.com.pk"],
    ["  @KE.com.PK ", "ke.com.pk"],
    ["Example.TEST", "example.test"],
  ])("normalises %j to %j", (input, expected) => {
    expect(organizationCreateSchema.parse({ ...validCreate, emailDomain: input }).emailDomain)
      .toBe(expected)
  })

  it("turns a blank value into null rather than storing an empty string", () => {
    expect(organizationCreateSchema.parse({ ...validCreate, emailDomain: "  " }).emailDomain)
      .toBeNull()
  })

  it.each(["localhost", "name@ke.com.pk", "ke..com", "ke.123", "ke com.pk"])(
    "refuses %j with a message the dialog would also show",
    (emailDomain) => {
      const parsed = organizationCreateSchema.safeParse({ ...validCreate, emailDomain })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(validationMessage(parsed.error)).toMatch(/domain/i)
      }
    },
  )

  it("refuses an oversized value before normalising it", () => {
    const parsed = organizationCreateSchema.safeParse({
      ...validCreate,
      emailDomain: `${"a".repeat(300)}.com`,
    })
    expect(parsed.success).toBe(false)
  })

  it("refuses a non-string", () => {
    for (const emailDomain of [42, true, ["ke.com.pk"], { domain: "ke.com.pk" }]) {
      expect(organizationCreateSchema.safeParse({ ...validCreate, emailDomain }).success).toBe(false)
    }
  })
})

describe("organizationUpdateSchema.emailDomain", () => {
  it("sets a normalised domain", () => {
    expect(organizationUpdateSchema.parse({ emailDomain: "@KE.com.pk" }).emailDomain)
      .toBe("ke.com.pk")
  })

  it("clears it with null or a blank string", () => {
    expect(organizationUpdateSchema.parse({ emailDomain: null }).emailDomain).toBeNull()
    expect(organizationUpdateSchema.parse({ emailDomain: "" }).emailDomain).toBeNull()
  })

  it("leaves it untouched when absent", () => {
    const parsed = organizationUpdateSchema.parse({ name: "Renamed" })
    expect("emailDomain" in parsed).toBe(false)
  })

  it("counts as a field on its own, so a domain-only edit is a valid body", () => {
    expect(organizationUpdateSchema.safeParse({ emailDomain: "ke.com.pk" }).success).toBe(true)
  })

  it("refuses a malformed domain", () => {
    expect(organizationUpdateSchema.safeParse({ emailDomain: "not a domain" }).success).toBe(false)
  })
})

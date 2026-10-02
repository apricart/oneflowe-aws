import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  EMAIL_DOMAIN_MAX_LENGTH,
  EMAIL_DOMAIN_PATTERN,
  EMAIL_LOCAL_PART_MAX_LENGTH,
  composeDomainEmail,
  emailDomainError,
  emailLocalPartError,
  emailMatchesDomain,
  normalizeEmailDomain,
} from "@/lib/organization-email-domain"

/** A label of `length` characters, all `a`. */
const label = (length: number) => "a".repeat(length)

/** The server's own address rule, which every composed address must pass. */
const serverEmail = z.string().trim().pipe(z.email().max(255))

describe("normalizeEmailDomain", () => {
  it.each([
    ["ke.com.pk", "ke.com.pk"],
    ["  KE.com.PK  ", "ke.com.pk"],
    ["@ke.com.pk", "ke.com.pk"],
    [" @Example.TEST ", "example.test"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalizeEmailDomain(input)).toBe(expected)
  })

  it("drops only one leading @, so a doubled one is still refused", () => {
    expect(normalizeEmailDomain("@@ke.com.pk")).toBe("@ke.com.pk")
    expect(emailDomainError("@@ke.com.pk")).not.toBeNull()
  })

  it.each([null, undefined, 42, {}, ["ke.com.pk"]])("treats %j as empty", (input) => {
    expect(normalizeEmailDomain(input)).toBe("")
  })
})

describe("emailDomainError", () => {
  it.each([
    "ke.com.pk",
    "example.com",
    "mail.example.co.uk",
    "a.io",
    "x-y.example.org",
    "123.example.com",
    "@KE.COM.PK",
  ])("accepts %j", (domain) => {
    expect(emailDomainError(domain)).toBeNull()
  })

  it.each([
    ["", /enter an email domain/i],
    ["   ", /enter an email domain/i],
    ["localhost", /domain such as/i],
    ["ke", /domain such as/i],
    ["-ke.com", /domain such as/i],
    ["ke-.com", /domain such as/i],
    ["ke..com", /domain such as/i],
    [".ke.com", /domain such as/i],
    ["ke.com.", /domain such as/i],
    ["ke.c", /domain such as/i],
    ["ke.123", /domain such as/i],
    ["192.168.0.1", /domain such as/i],
    ["ke com.pk", /domain such as/i],
    ["ke_com.pk", /domain such as/i],
    ["kë.com", /domain such as/i],
    ["name@ke.com.pk", /without a name or @/i],
    ["ke.com.pk/path", /domain such as/i],
  ])("refuses %j", (domain, message) => {
    expect(emailDomainError(domain)).toMatch(message)
  })

  it("holds each label to 63 characters", () => {
    expect(emailDomainError(`${label(63)}.com`)).toBeNull()
    expect(emailDomainError(`${label(64)}.com`)).not.toBeNull()
  })

  it("holds the whole domain to 253 characters", () => {
    // Four 60-character labels and a 9-character top level: 4*61 + 9 = 253.
    const atLimit = `${Array.from({ length: 4 }, () => label(60)).join(".")}.${"b".repeat(9)}`
    expect(atLimit).toHaveLength(EMAIL_DOMAIN_MAX_LENGTH)
    expect(emailDomainError(atLimit)).toBeNull()

    const overLimit = `a${atLimit}`
    expect(emailDomainError(overLimit)).toMatch(/at most 253/)
  })

  it("is the same pattern the database check constraint holds", () => {
    // The migration and db/schema.ts spell the regex out as SQL; this pins the
    // TypeScript side to the identical text so the two cannot drift apart.
    expect(EMAIL_DOMAIN_PATTERN.source).toBe(
      "^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$",
    )
  })
})

describe("emailLocalPartError", () => {
  it.each(["ada", "ada.lovelace", "ada_l", "ada+join", "o'brien", "a-b", "a", "A.B"])(
    "accepts %j",
    (localPart) => {
      expect(emailLocalPartError(localPart)).toBeNull()
    },
  )

  it("refuses a blank value", () => {
    expect(emailLocalPartError("")).toMatch(/enter your email/i)
    expect(emailLocalPartError("   ")).toMatch(/enter your email/i)
    expect(emailLocalPartError(undefined)).toMatch(/enter your email/i)
  })

  it("refuses an @ rather than silently cutting the address down", () => {
    // `ada@gmail.com` must not quietly become `ada@<the organization's domain>`,
    // which could be someone else's mailbox.
    expect(emailLocalPartError("ada@gmail.com")).toMatch(/only the part before the @/i)
    expect(emailLocalPartError("@")).toMatch(/only the part before the @/i)
  })

  it.each([".ada", "ada.", "ad..a", "ada lovelace", "ada,l", "ada\"l", "ada'", "a(b)", "ädå"])(
    "refuses %j",
    (localPart) => {
      expect(emailLocalPartError(localPart)).toMatch(/letters, numbers/i)
    },
  )

  it("holds the local part to 64 characters", () => {
    expect(emailLocalPartError(label(EMAIL_LOCAL_PART_MAX_LENGTH))).toBeNull()
    expect(emailLocalPartError(label(EMAIL_LOCAL_PART_MAX_LENGTH + 1))).toMatch(/at most 64/)
  })
})

describe("composeDomainEmail", () => {
  it("joins the typed part to the domain, lower-cased and trimmed", () => {
    expect(composeDomainEmail("  Ada.Lovelace ", "KE.com.pk")).toBe("ada.lovelace@ke.com.pk")
    expect(composeDomainEmail("ada", "@ke.com.pk")).toBe("ada@ke.com.pk")
  })

  it("only ever produces an address the server's own email rule accepts", () => {
    // Every local part the form accepts, against domains at the edges of what
    // an organization may set. Anything the form lets through that the server
    // then refused would be an error the applicant could not act on.
    const localParts = ["ada", "a", "ada.lovelace", "o'brien", "a+b", "a_b", "a-b", label(64)]
    const domains = ["ke.com.pk", "a.io", `${label(63)}.com`, "x-y.example.org"]
    for (const localPart of localParts) {
      expect(emailLocalPartError(localPart)).toBeNull()
      for (const domain of domains) {
        expect(emailDomainError(domain)).toBeNull()
        expect(serverEmail.safeParse(composeDomainEmail(localPart, domain)).success).toBe(true)
      }
    }
  })
})

describe("emailMatchesDomain", () => {
  it("accepts an address at exactly the domain, in any case", () => {
    expect(emailMatchesDomain("ada@ke.com.pk", "ke.com.pk")).toBe(true)
    expect(emailMatchesDomain("Ada@KE.COM.PK", "ke.com.pk")).toBe(true)
    expect(emailMatchesDomain("ada@ke.com.pk", "@KE.com.pk")).toBe(true)
  })

  it.each([
    ["ada@mail.ke.com.pk", "a subdomain"],
    ["ada@ke.com.pk.evil.test", "the domain followed by more labels"],
    ["ada@evilke.com.pk", "a name that merely ends in the domain"],
    ["ada@ke.com", "a parent of the domain"],
    ["ada@gmail.com", "another domain"],
    ["ke.com.pk", "no @ at all"],
    ["@ke.com.pk", "nothing before the @"],
    ["ada@", "nothing after the @"],
  ])("refuses %j (%s)", (email) => {
    expect(emailMatchesDomain(email, "ke.com.pk")).toBe(false)
  })

  it("judges the part after the last @, which is where mail is delivered", () => {
    expect(emailMatchesDomain("ada@ke.com.pk@evil.test", "ke.com.pk")).toBe(false)
  })

  it("never matches when the organization has no domain", () => {
    expect(emailMatchesDomain("ada@ke.com.pk", "")).toBe(false)
    expect(emailMatchesDomain("ada@", "")).toBe(false)
  })
})

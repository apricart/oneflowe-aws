import { describe, expect, it } from "vitest"

import { accountFieldsFrom, accountPasswordProblem, buildAccountPatch } from "@/lib/apricart-account-edit"

const initial = accountFieldsFrom({
  firstName: "Zain",
  lastName: "Ahmed",
  email: "zain@example.test",
  username: "zain.desk",
  phone: null,
})

describe("buildAccountPatch", () => {
  it("sends only what changed, trimmed", () => {
    expect(buildAccountPatch(initial, { ...initial, lastName: "  Khan ", phone: " 0300 1234567 " }, null)).toEqual({
      ok: true,
      patch: { lastName: "Khan", phone: "0300 1234567" },
    })
  })

  it("treats surrounding space as no change", () => {
    expect(buildAccountPatch(initial, { ...initial, email: " zain@example.test " }, null)).toEqual({ ok: false, error: "Nothing has changed" })
  })

  it("sends a cleared phone as null", () => {
    const withPhone = { ...initial, phone: "021 111" }
    expect(buildAccountPatch(withPhone, { ...withPhone, phone: "  " }, null)).toEqual({ ok: true, patch: { phone: null } })
  })

  it.each([["firstName", "First name"], ["lastName", "Last name"], ["email", "Email"], ["username", "Username"]] as const)(
    "refuses to clear %s",
    (key, label) => {
      expect(buildAccountPatch(initial, { ...initial, [key]: " " }, null)).toEqual({ ok: false, error: `${label} is required` })
    },
  )

  it("does not require a field the account never had until it is typed", () => {
    const unnamed = accountFieldsFrom({ firstName: null, lastName: null, email: "a@example.test", username: null, phone: null })
    expect(buildAccountPatch(unnamed, { ...unnamed, phone: "021 111" }, null)).toEqual({ ok: true, patch: { phone: "021 111" } })
  })

  it("adds a valid new password, alone or with other changes", () => {
    const password = { password: "N3w-Passw0rd!x", confirmation: "N3w-Passw0rd!x" }
    expect(buildAccountPatch(initial, initial, password)).toEqual({ ok: true, patch: { password: "N3w-Passw0rd!x" } })
    expect(buildAccountPatch(initial, { ...initial, firstName: "Zayn" }, password)).toEqual({
      ok: true,
      patch: { firstName: "Zayn", password: "N3w-Passw0rd!x" },
    })
  })

  it("refuses a weak or mismatched password and sends nothing", () => {
    const result = buildAccountPatch(initial, { ...initial, firstName: "Zayn" }, { password: "short", confirmation: "short" })
    expect(result).toEqual({ ok: false, error: "The password must be at least 12 characters" })
  })
})

describe("accountPasswordProblem", () => {
  it.each([
    ["Abcdefgh1!", /at least 12/],
    ["abcdefghijk1!", /upper and lower/],
    ["ABCDEFGHIJK1!", /upper and lower/],
    ["Abcdefghijkl!", /a number/],
    ["Abcdefghijk12", /a symbol/],
    [`Aa1!${"x".repeat(125)}`, /at most 128/],
  ])("refuses %s", (password, message) => {
    expect(accountPasswordProblem(password, password)).toMatch(message)
  })

  it("refuses a confirmation that differs", () => {
    expect(accountPasswordProblem("Abcdefghijk1!", "Abcdefghijk1?")).toBe("The two passwords do not match")
  })

  it("accepts exactly 12 characters meeting every rule", () => {
    expect(accountPasswordProblem("Abcdefghij1!", "Abcdefghij1!")).toBeNull()
  })
})

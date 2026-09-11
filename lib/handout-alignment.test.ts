import { describe, expect, it } from "vitest"

import {
  HandoutAlignmentError,
  buildAlignmentPlan,
  codeKey,
  isHandoutUsername,
  matchHandoutRows,
  roleOfUsername,
  type AlignmentAccount,
  type HandoutRow,
  type VerifiedMatch,
} from "./handout-alignment"

function row(overrides: Partial<HandoutRow> = {}): HandoutRow {
  return {
    index: 0,
    name: "Imran Khan",
    email: "imrank@ke.com.pk",
    branch: "Distribution Strategy",
    username: "imran-17655-ba",
    loginCode: "17655",
    mustChangePassword: true,
    ...overrides,
  }
}

function account(overrides: Partial<AlignmentAccount> = {}): AlignmentAccount {
  return {
    id: "a1",
    email: "imrank@ke.com.pk",
    role: "BRANCH_ADMIN",
    branch: "Distribution Strategy",
    username: "17655-ba",
    externalId: "17655",
    fullName: "Imran Khan Muhammad",
    firstName: "Imran Khan Muhammad",
    lastName: null,
    isActive: true,
    mustChangePassword: true,
    ...overrides,
  }
}

function verified(rows: HandoutRow[], accounts: AlignmentAccount[], ok = true): VerifiedMatch[] {
  return matchHandoutRows(rows, accounts).matches.map((m) => ({ ...m, passwordVerified: ok }))
}

describe("roleOfUsername / codeKey / isHandoutUsername", () => {
  it("reads the portal role from the suffix", () => {
    expect(roleOfUsername("imran-17655-ba")).toBe("BRANCH_ADMIN")
    expect(roleOfUsername("IMRAN-17655-OP")).toBe("ORDER_PORTAL")
    expect(roleOfUsername("17655")).toBeNull()
    expect(roleOfUsername("legacy_ke_133_10")).toBeNull()
  })

  it("compares employee codes as letters and digits only", () => {
    expect(codeKey(" KE-157 ")).toBe("ke157")
    expect(codeKey(17655)).toBe("17655")
  })

  it("accepts only the <name>-<code>-<suffix> shape for the matching role", () => {
    expect(isHandoutUsername("imran-17655-ba", "BRANCH_ADMIN")).toBe(true)
    expect(isHandoutUsername("imran-17655-ba", "ORDER_PORTAL")).toBe(false)
    expect(isHandoutUsername("Imran-17655-ba", "BRANCH_ADMIN")).toBe(false)
    expect(isHandoutUsername("17655-ba", "BRANCH_ADMIN")).toBe(false)
  })
})

describe("matchHandoutRows", () => {
  it("matches by login code and portal suffix first", () => {
    const result = matchHandoutRows([row()], [account(), account({ id: "a2", role: "ORDER_PORTAL", username: "17655-op" })])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.account.id).toBe("a1")
    expect(result.matches[0]!.matchedBy).toBe("login_code")
    expect(result.unmatchedAccounts.map((a) => a.id)).toEqual(["a2"])
  })

  it("falls back to email and role when the account's external_id does not carry the code", () => {
    const result = matchHandoutRows([row({ loginCode: "15377084" })], [account({ externalId: "15377", username: "15377-ba" })])
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.matchedBy).toBe("email")
  })

  it("prefers the account code over the login code when a legacy login changed hands", () => {
    // 18716 stayed with its previous holder; the new holder was given ke75.
    const rows = [row({ email: "hamza@ke.com.pk", username: "hamza-18716-ba", loginCode: "18716", accountCode: "ke75" })]
    const accounts = [
      account({ id: "old", email: "shehryar@ke.com.pk", externalId: "18716", username: "18716-ba" }),
      account({ id: "new", email: "hamza@ke.com.pk", externalId: "ke75", username: "ke75-ba" }),
    ]
    const result = matchHandoutRows(rows, accounts)
    expect(result.matches.map((m) => [m.account.id, m.matchedBy])).toEqual([["new", "login_code"]])
    const { plan } = buildAlignmentPlan(result.matches.map((m) => ({ ...m, passwordVerified: true })), [])
    expect(plan[0]!.remaining).toContain("EXTERNAL_ID_DIFFERS_FROM_LOGIN_CODE")
  })

  it("tells two employee codes behind one email apart", () => {
    const rows = [
      row({ index: 0, name: "Hafiz M. Irfan", email: "h@ke.com.pk", username: "hafiz-18553-ba", loginCode: "18553" }),
      row({ index: 1, name: "Hafiz Muhammad Irfan", email: "h@ke.com.pk", username: "hafiz-16944-ba", loginCode: "16944" }),
    ]
    const accounts = [
      account({ id: "x", email: "h@ke.com.pk", externalId: "18553", username: "18553-ba" }),
      account({ id: "y", email: "h@ke.com.pk", externalId: "16944", username: "16944-ba" }),
    ]
    const result = matchHandoutRows(rows, accounts)
    expect(result.matches.map((m) => [m.row.index, m.account.id])).toEqual([[0, "x"], [1, "y"]])
    expect(result.skipped).toEqual([])
  })

  it("refuses an email fallback that is ambiguous rather than guessing", () => {
    const rows = [row({ loginCode: "99999" })]
    const accounts = [account({ id: "x", externalId: "1" }), account({ id: "y", externalId: "2" })]
    const result = matchHandoutRows(rows, accounts)
    expect(result.matches).toEqual([])
    expect(result.skipped[0]!.reason).toBe("AMBIGUOUS_ACCOUNT")
  })

  it("reports a row nothing matches and a username without a portal suffix", () => {
    const result = matchHandoutRows(
      [row({ index: 0, loginCode: "1", email: "nobody@ke.com.pk" }), row({ index: 1, username: "17655" })],
      [account()],
    )
    expect(result.skipped.map((s) => s.reason)).toEqual(["NO_ACCOUNT", "UNSUPPORTED_USERNAME_SUFFIX"])
  })

  it("lets a login-code match win over an earlier row's email fallback", () => {
    // Row 0's own account (12297) is gone; it shares an email with 16291, which row 1 names by code.
    const rows = [
      row({ index: 0, email: "r@ke.com.pk", username: "ramsha-12297-ba", loginCode: "12297" }),
      row({ index: 1, email: "r@ke.com.pk", username: "ramsha-16291-ba", loginCode: "16291" }),
    ]
    const result = matchHandoutRows(rows, [account({ id: "k", email: "r@ke.com.pk", externalId: "16291", username: "16291-ba" })])
    expect(result.matches.map((m) => [m.row.index, m.account.id, m.matchedBy])).toEqual([[1, "k", "login_code"]])
    expect(result.skipped.map((s) => [s.sheetIndex, s.reason])).toEqual([[0, "NO_ACCOUNT"]])
  })

  it("refuses a second row carrying the same login code and portal as an earlier one", () => {
    const rows = [row({ index: 0 }), row({ index: 1, name: "Someone Else", username: "someone-17655-ba" })]
    const result = matchHandoutRows(rows, [account()])
    expect(result.matches).toHaveLength(1)
    expect(result.skipped[0]!.reason).toBe("ACCOUNT_CLAIMED_TWICE")
  })

  it("does not let an email fallback take an account another row already holds by code", () => {
    const rows = [row({ index: 0 }), row({ index: 1, loginCode: "different", email: "imrank@ke.com.pk" })]
    const result = matchHandoutRows(rows, [account()])
    expect(result.matches).toHaveLength(1)
    expect(result.skipped[0]!.reason).toBe("NO_ACCOUNT")
  })
})

describe("buildAlignmentPlan", () => {
  it("plans the username and the split name for a verified row", () => {
    const { plan, skipped, unchanged } = buildAlignmentPlan(verified([row()], [account()]), [{ id: "a1", username: "17655-ba" }])
    expect(skipped).toEqual([])
    expect(unchanged).toEqual([])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.before.username).toBe("17655-ba")
    expect(plan[0]!.after).toEqual({ username: "imran-17655-ba", fullName: "Imran Khan", firstName: "Imran", lastName: "Khan" })
    expect(plan[0]!.usernameChanges).toBe(true)
    expect(plan[0]!.nameChanges).toBe(true)
  })

  it("never plans a row whose password did not verify", () => {
    const { plan, skipped } = buildAlignmentPlan(verified([row()], [account()], false), [])
    expect(plan).toEqual([])
    expect(skipped[0]!.reason).toBe("PASSWORD_MISMATCH")
  })

  it("treats an account that already carries every value as unchanged", () => {
    const already = account({ username: "imran-17655-ba", fullName: "Imran Khan", firstName: "Imran", lastName: "Khan" })
    const { plan, unchanged } = buildAlignmentPlan(verified([row()], [already]), [])
    expect(plan).toEqual([])
    expect(unchanged).toHaveLength(1)
  })

  it("refuses a target username held by an account outside the plan, whatever its tenant or deletion state", () => {
    const { plan, skipped } = buildAlignmentPlan(verified([row()], [account()]), [{ id: "deleted-elsewhere", username: "imran-17655-ba" }])
    expect(plan).toEqual([])
    expect(skipped[0]!.reason).toBe("USERNAME_TAKEN")
  })

  it("allows a target username currently held by another account the plan renames", () => {
    const rows = [
      row({ index: 0, username: "imran-17655-ba", loginCode: "17655" }),
      row({ index: 1, name: "Sabir Tunio", email: "s@ke.com.pk", username: "sabir-11363-ba", loginCode: "11363" }),
    ]
    const accounts = [account(), account({ id: "a2", email: "s@ke.com.pk", externalId: "11363", username: "imran-17655-ba" })]
    const { plan, skipped } = buildAlignmentPlan(verified(rows, accounts), accounts.map((a) => ({ id: a.id, username: a.username })))
    expect(skipped).toEqual([])
    expect(plan).toHaveLength(2)
  })

  it("refuses a target username that is not the rule's shape or the wrong portal", () => {
    const rows = [row({ index: 0, username: "Imran-17655-ba" })]
    const { skipped } = buildAlignmentPlan(verified(rows, [account()]), [])
    // "Imran-17655-ba" ends in -ba so it matches the BRANCH_ADMIN account, but is not lowercase.
    expect(skipped[0]!.reason).toBe("INVALID_TARGET_USERNAME")
  })

  it("refuses an empty hand-out name and a name that will not fit", () => {
    const rows = [row({ index: 0, name: "   " }), row({ index: 1, name: "x".repeat(101), username: "imran-17655-op", loginCode: "17655" })]
    const accounts = [account(), account({ id: "a2", role: "ORDER_PORTAL", username: "17655-op" })]
    const { skipped } = buildAlignmentPlan(verified(rows, accounts), [])
    expect(skipped.map((s) => s.reason)).toEqual(["EMPTY_NAME", "NAME_TOO_LONG"])
  })

  it("throws when the hand-out gives two rows the same username", () => {
    const rows = [row({ index: 0 }), row({ index: 1, email: "o@ke.com.pk", loginCode: "2" })]
    const accounts = [account(), account({ id: "a2", email: "o@ke.com.pk", externalId: "2" })]
    expect(() => buildAlignmentPlan(verified(rows, accounts), [])).toThrow(HandoutAlignmentError)
  })

  it("reports what it leaves alone: branch, external_id, must-change flag, inactive", () => {
    const rows = [row({ branch: "GSO", loginCode: "15377084", mustChangePassword: true })]
    const accounts = [account({ branch: "1. GSO", externalId: "15377", mustChangePassword: false, isActive: false })]
    const { plan } = buildAlignmentPlan(verified(rows, accounts), [])
    expect(plan[0]!.matchedBy).toBe("email")
    expect(plan[0]!.remaining).toEqual([
      "BRANCH_DIFFERS",
      "EXTERNAL_ID_DIFFERS_FROM_LOGIN_CODE",
      "MUST_CHANGE_PASSWORD_DIFFERS",
      "ACCOUNT_INACTIVE",
    ])
  })
})

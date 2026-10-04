import { describe, expect, it } from "vitest"

import {
  NameCorrectionError,
  buildNameCorrectionPlan,
  canonicalJson,
  matchKey,
  phoneDigits,
  splitName,
  withoutTrailingDash,
  type SheetRow,
  type UserRow,
} from "./user-name-correction"

describe("withoutTrailingDash", () => {
  it("drops a lone trailing dash and the whitespace around it", () => {
    expect(withoutTrailingDash("Imran Khan -")).toBe("Imran Khan")
    expect(withoutTrailingDash("Imran Khan\t-  \n")).toBe("Imran Khan")
    expect(withoutTrailingDash("Imran Khan-")).toBe("Imran Khan")
  })

  it("leaves a name without a trailing dash untouched, trailing space included", () => {
    expect(withoutTrailingDash("Imran Khan ")).toBe("Imran Khan ")
    expect(withoutTrailingDash("Imran-Khan")).toBe("Imran-Khan")
    expect(withoutTrailingDash("")).toBe("")
  })

  it("removes only the last of several dashes", () => {
    expect(withoutTrailingDash("Khan --")).toBe("Khan -")
  })

  it("agrees with the regex it replaces", () => {
    const samples = ["", "-", " - ", "a - b -", "a\u00A0-\u2028", "--", "a -\r\n", " ".repeat(5) + "x", "a-\t"]
    for (const sample of samples) {
      expect(withoutTrailingDash(sample)).toBe(sample.replace(/\s*-\s*$/, ""))
    }
  })
})

function sheetRow(overrides: Partial<SheetRow> & Pick<SheetRow, "index">): SheetRow {
  return {
    name: "Imran Khan Muhammad",
    email: "imrank@ke.com.pk",
    role: "BRANCH_ADMIN",
    branch: "Distribution Strategy",
    phone: "03411352446",
    ...overrides,
  }
}

function userRow(overrides: Partial<UserRow> & Pick<UserRow, "id">): UserRow {
  return {
    email: "imrank@ke.com.pk",
    username: "17655-BA",
    employeeId: "17655",
    fullName: "Imran Khan",
    firstName: "Imran",
    lastName: "Khan",
    phone: "03411352446",
    role: "BRANCH_ADMIN",
    branch: "Distribution Strategy",
    ...overrides,
  }
}

describe("splitName", () => {
  it("puts the first token in first name and the remainder in last name", () => {
    expect(splitName("Imran Khan Muhammad")).toEqual({
      fullName: "Imran Khan Muhammad",
      firstName: "Imran",
      lastName: "Khan Muhammad",
    })
  })

  it("gives a single-token name a null last name", () => {
    expect(splitName("KASHIF")).toEqual({ fullName: "KASHIF", firstName: "KASHIF", lastName: null })
  })

  it("preserves the reviewer's capitalisation verbatim", () => {
    expect(splitName("khawar Hassan")).toEqual({
      fullName: "khawar Hassan",
      firstName: "khawar",
      lastName: "Hassan",
    })
    expect(splitName("RIZWAN BAIG").firstName).toBe("RIZWAN")
  })

  it("trims and collapses stray whitespace", () => {
    expect(splitName("  Daniyal   Fatmi ")).toEqual({
      fullName: "Daniyal Fatmi",
      firstName: "Daniyal",
      lastName: "Fatmi",
    })
  })

  it("keeps a hyphenated single token whole", () => {
    expect(splitName("Imran-ul-Hassan")).toEqual({
      fullName: "Imran-ul-Hassan",
      firstName: "Imran-ul-Hassan",
      lastName: null,
    })
  })
})

describe("phoneDigits", () => {
  it("compares formatting-insensitively", () => {
    expect(phoneDigits("0341-1352446")).toBe(phoneDigits("03411352446"))
  })

  it("treats the export's em dash and a null column as the same absence", () => {
    expect(phoneDigits("—")).toBe("")
    expect(phoneDigits(null)).toBe("")
    expect(phoneDigits("")).toBe("")
  })
})

describe("matchKey", () => {
  it("ignores case and whitespace on every part", () => {
    expect(matchKey("Imrank@KE.com.pk", "branch_admin", "IBC  SITE (Security)"))
      .toBe(matchKey("imrank@ke.com.pk", "BRANCH_ADMIN", "IBC SITE (Security)"))
  })

  it("separates two people who share an email but sit at different branches", () => {
    expect(matchKey("khawar.hasan@ke.com.pk", "BRANCH_ADMIN", "CEO Task Force"))
      .not.toBe(matchKey("khawar.hasan@ke.com.pk", "BRANCH_ADMIN", "KE Police (Security)"))
  })

  it("separates the two role accounts of one person", () => {
    expect(matchKey("sara.malik@ke.com.pk", "BRANCH_ADMIN", "IR"))
      .not.toBe(matchKey("sara.malik@ke.com.pk", "ORDER_PORTAL", "IR"))
  })
})

describe("buildNameCorrectionPlan", () => {
  it("plans the full name and the split for a matched account", () => {
    const { plan, skipped, unchanged } = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "Imran Khan Muhammad" })],
      [userRow({ id: "u1" })],
    )

    expect(skipped).toEqual([])
    expect(unchanged).toBe(0)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      userId: "u1",
      before: { fullName: "Imran Khan", firstName: "Imran", lastName: "Khan" },
      after: { fullName: "Imran Khan Muhammad", firstName: "Imran", lastName: "Khan Muhammad" },
    })
  })

  it("writes a null last name for a single-token name", () => {
    const { plan } = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "KASHIF", email: "kashif.memon@ke.com.pk", branch: "GSMP North" })],
      [userRow({ id: "u1", email: "kashif.memon@ke.com.pk", branch: "GSMP North", fullName: "Kashif Memon", firstName: "Kashif", lastName: "Memon" })],
    )

    expect(plan[0]!.after).toEqual({ fullName: "KASHIF", firstName: "KASHIF", lastName: null })
  })

  it("counts an already-correct account as unchanged rather than updating it", () => {
    const { plan, unchanged } = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "Imran Khan" })],
      [userRow({ id: "u1", fullName: "Imran Khan", firstName: "Imran", lastName: "Khan" })],
    )

    expect(plan).toEqual([])
    expect(unchanged).toBe(1)
  })

  it("keeps two people apart when they share an email, matching each to its branch", () => {
    const sheet = [
      sheetRow({ index: 0, name: "khawar Hassan", email: "khawar.hasan@ke.com.pk", branch: "CEO Task Force", phone: "0300-1112222" }),
      sheetRow({ index: 1, name: "Mustafa Khan", email: "khawar.hasan@ke.com.pk", branch: "KE Police (Security)", phone: "0300-3334444" }),
    ]
    const users = [
      userRow({ id: "task-force", email: "khawar.hasan@ke.com.pk", branch: "CEO Task Force", phone: "03001112222", fullName: "Wrong One", firstName: "Wrong", lastName: "One" }),
      userRow({ id: "ke-police", email: "khawar.hasan@ke.com.pk", branch: "KE Police (Security)", phone: "03003334444", fullName: "Other", firstName: "Other", lastName: null }),
    ]

    const { plan } = buildNameCorrectionPlan(sheet, users)

    expect(plan.find((row) => row.userId === "task-force")!.after.fullName).toBe("khawar Hassan")
    expect(plan.find((row) => row.userId === "ke-police")!.after.fullName).toBe("Mustafa Khan")
  })

  it("writes neither role row when a person's two rows disagree about the name", () => {
    const sheet = [
      sheetRow({ index: 0, name: "Sayyed Sami Uddin Qadri", email: "sayyed.sami@ke.com.pk", branch: "MEGA CENTER", role: "BRANCH_ADMIN" }),
      sheetRow({ index: 1, name: "Sayyed Sami Uddin Qadri Sayyed Sami Uddin Qadri", email: "sayyed.sami@ke.com.pk", branch: "MEGA CENTER", role: "ORDER_PORTAL" }),
    ]
    const users = [
      userRow({ id: "ba", email: "sayyed.sami@ke.com.pk", branch: "MEGA CENTER", role: "BRANCH_ADMIN", fullName: "old", firstName: "old", lastName: null }),
      userRow({ id: "op", email: "sayyed.sami@ke.com.pk", branch: "MEGA CENTER", role: "ORDER_PORTAL", fullName: "old", firstName: "old", lastName: null }),
    ]

    const { plan, skipped } = buildNameCorrectionPlan(sheet, users)

    expect(plan).toEqual([])
    expect(skipped.map((row) => row.reason)).toEqual([
      "NAME_CONFLICT_BETWEEN_ROLE_ROWS",
      "NAME_CONFLICT_BETWEEN_ROLE_ROWS",
    ])
  })

  it("refuses the whole plan when phone stops confirming a match", () => {
    expect(() =>
      buildNameCorrectionPlan(
        [sheetRow({ index: 0, phone: "0300-0000000" })],
        [userRow({ id: "u1", phone: "03411352446" })],
      ),
    ).toThrow(NameCorrectionError)
  })

  it("accepts a match where both sides have no phone", () => {
    const { plan } = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "Adnan Siddiqui", phone: "—" })],
      [userRow({ id: "u1", phone: null, fullName: "Adnan", firstName: "Adnan", lastName: null })],
    )

    expect(plan).toHaveLength(1)
  })

  it("refuses a sheet whose rows cannot be told apart", () => {
    expect(() =>
      buildNameCorrectionPlan(
        [sheetRow({ index: 0, name: "One" }), sheetRow({ index: 1, name: "Two" })],
        [userRow({ id: "u1" })],
      ),
    ).toThrow(/Sheet has 1 group/)
  })

  it("refuses when two accounts share the identifying key", () => {
    expect(() =>
      buildNameCorrectionPlan(
        [sheetRow({ index: 0 })],
        [userRow({ id: "u1" }), userRow({ id: "u2" })],
      ),
    ).toThrow(/Database has 1 group/)
  })

  it("reports a sheet row with no account instead of writing one", () => {
    const { plan, skipped } = buildNameCorrectionPlan(
      [sheetRow({ index: 0, email: "ghost@ke.com.pk" })],
      [userRow({ id: "u1" })],
    )

    expect(plan).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "NO_MATCHING_ACCOUNT", email: "ghost@ke.com.pk" })
  })

  it("reports accounts the sheet never mentions", () => {
    const { unmatchedDbUsers } = buildNameCorrectionPlan(
      [sheetRow({ index: 0 })],
      [userRow({ id: "u1" }), userRow({ id: "u2", role: "ORDER_PORTAL", username: "17655-OP" })],
    )

    expect(unmatchedDbUsers.map((user) => user.id)).toEqual(["u2"])
  })

  it("rejects a first name longer than the column", () => {
    expect(() =>
      buildNameCorrectionPlan([sheetRow({ index: 0, name: "A".repeat(101) })], [userRow({ id: "u1" })]),
    ).toThrow(/first name exceeds 100/)
  })

  it("rejects an empty name rather than blanking the account", () => {
    expect(() =>
      buildNameCorrectionPlan([sheetRow({ index: 0, name: "   " })], [userRow({ id: "u1" })]),
    ).toThrow(/empty Name/)
  })

  it("produces a plan that does not depend on input order", () => {
    const users = [
      userRow({ id: "u2", role: "ORDER_PORTAL", fullName: "b", firstName: "b", lastName: null }),
      userRow({ id: "u1", fullName: "a", firstName: "a", lastName: null }),
    ]
    const forwards = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "Sara Malik" }), sheetRow({ index: 1, name: "Sara Malik", role: "ORDER_PORTAL" })],
      users,
    )
    const backwards = buildNameCorrectionPlan(
      [sheetRow({ index: 0, name: "Sara Malik", role: "ORDER_PORTAL" }), sheetRow({ index: 1, name: "Sara Malik" })],
      [...users].reverse(),
    )

    expect(canonicalJson(forwards.plan)).toBe(canonicalJson(backwards.plan))
  })
})

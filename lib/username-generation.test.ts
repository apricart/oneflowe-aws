import { describe, expect, it } from "vitest"

import {
  UsernameGenerationError,
  buildUsername,
  buildUsernamePlan,
  roleSuffix,
  slugToken,
  type ExistingUsername,
  type UsernameSourceRow,
} from "./username-generation"

function source(overrides: Partial<UsernameSourceRow> & Pick<UsernameSourceRow, "id">): UsernameSourceRow {
  return {
    email: "imrank@ke.com.pk",
    role: "BRANCH_ADMIN",
    firstName: "Imran",
    fullName: "Imran Khan Muhammad",
    employeeId: "17655",
    username: "17655-ba",
    branch: "Distribution Strategy",
    ...overrides,
  }
}

describe("slugToken", () => {
  it("lowercases, because the login form lowercases the credential before matching", () => {
    expect(slugToken("KASHIF")).toBe("kashif")
  })

  it("drops every character a username may not carry", () => {
    expect(slugToken("Imran-ul-Hassan")).toBe("imranulhassan")
    expect(slugToken("mukesh.kumar")).toBe("mukeshkumar")
    expect(slugToken("O'Brien Jr.")).toBe("obrienjr")
  })

  it("keeps digits, so an employee code survives", () => {
    expect(slugToken("80008335")).toBe("80008335")
  })

  it("returns empty for a value with nothing usable", () => {
    expect(slugToken("—")).toBe("")
    expect(slugToken(null)).toBe("")
    expect(slugToken("   ")).toBe("")
  })
})

describe("roleSuffix", () => {
  it("maps the two portal roles", () => {
    expect(roleSuffix("BRANCH_ADMIN")).toBe("ba")
    expect(roleSuffix("ORDER_PORTAL")).toBe("op")
  })

  it("refuses a role the rule does not cover", () => {
    expect(roleSuffix("SUPER_ADMIN")).toBeNull()
    expect(roleSuffix("HEAD_OFFICE")).toBeNull()
    expect(roleSuffix("GROUP_ORDER_PORTAL")).toBeNull()
  })
})

describe("buildUsername", () => {
  it("builds first name, employee code, role suffix", () => {
    expect(buildUsername("Imran", "17655", "BRANCH_ADMIN")).toEqual({ username: "imran-17655-ba" })
    expect(buildUsername("Imran", "17655", "ORDER_PORTAL")).toEqual({ username: "imran-17655-op" })
  })

  it("reports rather than guesses when a part is missing", () => {
    expect(buildUsername(null, "17655", "BRANCH_ADMIN")).toEqual({ error: "MISSING_FIRST_NAME" })
    expect(buildUsername("Imran", null, "BRANCH_ADMIN")).toEqual({ error: "MISSING_EMPLOYEE_CODE" })
    expect(buildUsername("Imran", "17655", "SUPER_ADMIN")).toEqual({ error: "UNSUPPORTED_ROLE" })
  })

  it("never produces an uppercase username", () => {
    const built = buildUsername("MUHAMMAD", "80008335", "BRANCH_ADMIN")
    expect(built).toEqual({ username: "muhammad-80008335-ba" })
  })
})

describe("buildUsernamePlan", () => {
  it("plans a rename and keeps the previous value for rollback", () => {
    const { plan, skipped, unchanged } = buildUsernamePlan([source({ id: "u1" })], [{ id: "u1", username: "17655-ba" }])

    expect(skipped).toEqual([])
    expect(unchanged).toBe(0)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ userId: "u1", before: "17655-ba", after: "imran-17655-ba" })
  })

  it("separates the two role accounts of one person by suffix alone", () => {
    const { plan } = buildUsernamePlan(
      [
        source({ id: "ba", role: "BRANCH_ADMIN", username: "17655-ba" }),
        source({ id: "op", role: "ORDER_PORTAL", username: "17655-op" }),
      ],
      [],
    )

    expect(plan.map((row) => row.after).sort()).toEqual(["imran-17655-ba", "imran-17655-op"])
  })

  it("keeps nineteen people called Muhammad apart by employee code", () => {
    const targets = ["11111", "22222", "33333"].map((code) =>
      source({ id: `u-${code}`, firstName: "Muhammad", employeeId: code, username: `${code}-ba` }),
    )

    const { plan } = buildUsernamePlan(targets, [])

    expect(plan.map((row) => row.after)).toEqual([
      "muhammad-11111-ba",
      "muhammad-22222-ba",
      "muhammad-33333-ba",
    ])
  })

  it("counts an account already on the rule as unchanged", () => {
    const { plan, unchanged } = buildUsernamePlan(
      [source({ id: "u1", username: "imran-17655-ba" })],
      [{ id: "u1", username: "imran-17655-ba" }],
    )

    expect(plan).toEqual([])
    expect(unchanged).toBe(1)
  })

  it("refuses when two accounts want the same username", () => {
    expect(() =>
      buildUsernamePlan(
        [
          source({ id: "a", firstName: "Muhammad", employeeId: "17655" }),
          source({ id: "b", firstName: "Muhammad", employeeId: "17655" }),
        ],
        [],
      ),
    ).toThrow(UsernameGenerationError)
  })

  it("refuses when the name is held by an account outside this run, including another tenant", () => {
    expect(() =>
      buildUsernamePlan(
        [source({ id: "ke-user" })],
        [
          { id: "ke-user", username: "17655-ba" },
          { id: "zoomato-user", username: "imran-17655-ba" },
        ],
      ),
    ).toThrow(/already held by zoomato-user/)
  })

  it("treats a soft-deleted account's username as still claimed, because the unique index ignores deleted_at", () => {
    expect(() =>
      buildUsernamePlan(
        [source({ id: "live" })],
        [
          { id: "live", username: "17655-ba" },
          { id: "soft-deleted", username: "imran-17655-ba" },
        ],
      ),
    ).toThrow(/already held by soft-deleted/)
  })

  it("lets an account keep a name it already holds itself", () => {
    const { unchanged } = buildUsernamePlan(
      [source({ id: "u1", username: "imran-17655-ba" })],
      [{ id: "u1", username: "imran-17655-ba" }],
    )

    expect(unchanged).toBe(1)
  })

  it("skips an account missing a first name instead of writing a bare code", () => {
    const { plan, skipped } = buildUsernamePlan([source({ id: "u1", firstName: "  " })], [])

    expect(plan).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "MISSING_FIRST_NAME", userId: "u1" })
  })

  it("skips an account missing an employee code", () => {
    const { skipped } = buildUsernamePlan([source({ id: "u1", employeeId: null })], [])

    expect(skipped[0]).toMatchObject({ reason: "MISSING_EMPLOYEE_CODE" })
  })

  it("skips a role the rule does not cover rather than inventing a suffix", () => {
    const { skipped } = buildUsernamePlan([source({ id: "u1", role: "HEAD_OFFICE" })], [])

    expect(skipped[0]).toMatchObject({ reason: "UNSUPPORTED_ROLE" })
  })

  it("allows a swap, where one account takes a name another is giving up", () => {
    // a currently holds what b will take, and vice versa. The end state is
    // valid; the script is responsible for staging the writes.
    const { plan } = buildUsernamePlan(
      [
        source({ id: "a", firstName: "Imran", employeeId: "200", username: "sara-100-ba" }),
        source({ id: "b", firstName: "Sara", employeeId: "100", username: "imran-200-ba" }),
      ],
      [
        { id: "a", username: "sara-100-ba" },
        { id: "b", username: "imran-200-ba" },
      ],
    )

    expect(plan.map((row) => `${row.before} -> ${row.after}`).sort()).toEqual([
      "imran-200-ba -> sara-100-ba",
      "sara-100-ba -> imran-200-ba",
    ])
  })

  it("rejects a duplicated account id in the target set", () => {
    expect(() => buildUsernamePlan([source({ id: "u1" }), source({ id: "u1" })], [])).toThrow(/duplicate account id/)
  })

  it("produces the same plan whatever order the rows arrive in", () => {
    const rows = [
      source({ id: "u2", firstName: "Sara", employeeId: "222", username: "222-ba" }),
      source({ id: "u1", firstName: "Imran", employeeId: "111", username: "111-ba" }),
    ]
    const accounts: ExistingUsername[] = [
      { id: "u1", username: "111-ba" },
      { id: "u2", username: "222-ba" },
    ]

    const forwards = buildUsernamePlan(rows, accounts)
    const backwards = buildUsernamePlan([...rows].reverse(), [...accounts].reverse())

    expect(forwards.plan).toEqual(backwards.plan)
  })
})

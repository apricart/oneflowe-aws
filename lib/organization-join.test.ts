import { describe, expect, it } from "vitest"

import {
  DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE,
  JOINABLE_ROLES,
  JOINABLE_ROLE_LABELS,
  JOIN_CODE_MAX_LENGTH,
  JOIN_CODE_MIN_LENGTH,
  JOIN_DECISIONS,
  JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE,
  JOIN_IDENTITY_CONFLICT_MESSAGE,
  JOIN_REQUEST_STATUSES,
  UNKNOWN_JOIN_CODE_MESSAGE,
  isJoinRequestStatus,
  isJoinableRole,
  isSingleBranchJoinableRole,
  joinCodeError,
  joinEmailDomainMismatchMessage,
  joinEmailDomainRefusal,
  joinRequestScopeShapeError,
  normalizeJoinCode,
} from "@/lib/organization-join"

describe("the roles an applicant may ask for", () => {
  it("is exactly the four the tenant's own portals use", () => {
    expect([...JOINABLE_ROLES]).toEqual([
      "BRANCH_ADMIN",
      "ORDER_PORTAL",
      "GROUP_USER",
      "GROUP_ORDER_PORTAL",
    ])
  })

  it("never admits an administrative role, however it is spelled", () => {
    for (const role of ["HEAD_OFFICE", "SUPER_ADMIN", "head_office", "super_admin"]) {
      expect(isJoinableRole(role)).toBe(false)
    }
  })

  it("rejects anything that is not one of the four", () => {
    for (const value of [null, undefined, 1, {}, [], "", "EMPLOYEE", "BRANCH_ADMIN "]) {
      expect(isJoinableRole(value)).toBe(false)
    }
  })

  it("names every one of them, so the form cannot render a bare enum", () => {
    for (const role of JOINABLE_ROLES) {
      expect(JOINABLE_ROLE_LABELS[role]).toBeTruthy()
    }
  })

  it("splits them into the two assignment shapes the user table has", () => {
    expect(isSingleBranchJoinableRole("BRANCH_ADMIN")).toBe(true)
    expect(isSingleBranchJoinableRole("ORDER_PORTAL")).toBe(true)
    expect(isSingleBranchJoinableRole("GROUP_USER")).toBe(false)
    expect(isSingleBranchJoinableRole("GROUP_ORDER_PORTAL")).toBe(false)
  })
})

describe("normalizing a join code", () => {
  it("upper-cases and trims the ends, so case and stray spaces do not matter", () => {
    expect(normalizeJoinCode("  acde-4fgh  ")).toBe("ACDE-4FGH")
  })

  it("leaves internal whitespace in place rather than silently closing it up", () => {
    // Collapsing it would make "AB CD1234" and "ABCD1234" the same code and make
    // the unique index a lie about what was typed. It is rejected instead.
    expect(normalizeJoinCode("AB CD1234")).toBe("AB CD1234")
    expect(joinCodeError("AB CD1234")).toMatch(/letters, numbers and dashes/)
  })

  it("answers with an empty string for anything that is not a string", () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(normalizeJoinCode(value)).toBe("")
    }
  })
})

describe("validating a join code", () => {
  it("accepts a code at each end of the allowed length", () => {
    expect(joinCodeError("A".repeat(JOIN_CODE_MIN_LENGTH))).toBeNull()
    expect(joinCodeError("A".repeat(JOIN_CODE_MAX_LENGTH))).toBeNull()
  })

  it("refuses one character short and one character long", () => {
    expect(joinCodeError("A".repeat(JOIN_CODE_MIN_LENGTH - 1))).toMatch(/at least/)
    expect(joinCodeError("A".repeat(JOIN_CODE_MAX_LENGTH + 1))).toMatch(/at most/)
  })

  it("refuses an empty or missing code distinctly from a short one", () => {
    expect(joinCodeError("")).toBe("Enter a join code")
    expect(joinCodeError("   ")).toBe("Enter a join code")
    expect(joinCodeError(null)).toBe("Enter a join code")
  })

  it("accepts dashes and digits, and refuses every other punctuation", () => {
    expect(joinCodeError("ACDE-4FGH-7JKL")).toBeNull()
    expect(joinCodeError("12345678")).toBeNull()
    for (const bad of ["ACDE_4FGH", "ACDE.4FGH", "ACDE/4FGH", "ACDE'4FGH", "ACDE;4FGH", "AÇDE4FGH"]) {
      expect(joinCodeError(bad)).toMatch(/letters, numbers and dashes/)
    }
  })

  it("judges a lower-case code by its normalized form", () => {
    expect(joinCodeError("acde4fgh")).toBeNull()
  })

  it("is the floor the migration's own check constraint holds", () => {
    // The constraint is `code ~ '^[A-Z0-9-]{8,32}$'`. Anything this function
    // accepts must satisfy it, or a valid-looking code would fail on insert.
    const pattern = /^[A-Z0-9-]{8,32}$/
    for (const good of ["ACDE4FGH", "ACDE-4FGH-7JKL", "A".repeat(32), "12345678"]) {
      expect(joinCodeError(good)).toBeNull()
      expect(pattern.test(normalizeJoinCode(good))).toBe(true)
    }
  })
})

describe("the assignment shape a requested role needs", () => {
  const single = { role: "ORDER_PORTAL" as const, branchId: 7, groupIds: [], branchIds: [] }
  const group = { role: "GROUP_USER" as const, branchId: null, groupIds: [3], branchIds: [] }

  it("accepts a single-branch role with exactly one branch", () => {
    expect(joinRequestScopeShapeError(single)).toBeNull()
    expect(joinRequestScopeShapeError({ ...single, role: "BRANCH_ADMIN" })).toBeNull()
  })

  it("refuses a single-branch role with no branch", () => {
    expect(joinRequestScopeShapeError({ ...single, branchId: null }))
      .toMatch(/must be assigned one branch/)
  })

  it("refuses a single-branch role carrying group or branch lists", () => {
    expect(joinRequestScopeShapeError({ ...single, groupIds: [1] }))
      .toMatch(/only to the group-based roles/)
    expect(joinRequestScopeShapeError({ ...single, branchIds: [1] }))
      .toMatch(/only to the group-based roles/)
  })

  it("accepts a group role with groups, with branches, or with both", () => {
    expect(joinRequestScopeShapeError(group)).toBeNull()
    expect(joinRequestScopeShapeError({ ...group, groupIds: [], branchIds: [9] })).toBeNull()
    expect(joinRequestScopeShapeError({ ...group, groupIds: [3], branchIds: [9] })).toBeNull()
    expect(joinRequestScopeShapeError({ ...group, role: "GROUP_ORDER_PORTAL" })).toBeNull()
  })

  it("refuses a group role pinned to a single branch", () => {
    expect(joinRequestScopeShapeError({ ...group, branchId: 4 }))
      .toMatch(/not assigned a single branch/)
  })

  it("refuses a group role with nothing assigned — the empty set never widens", () => {
    expect(joinRequestScopeShapeError({ ...group, groupIds: [], branchIds: [] }))
      .toMatch(/at least one group or one branch/)
  })
})

describe("the statuses and decisions", () => {
  it("are the three the check constraint allows", () => {
    expect([...JOIN_REQUEST_STATUSES]).toEqual(["pending", "approved", "rejected"])
  })

  it("recognise only those three", () => {
    expect(isJoinRequestStatus("pending")).toBe(true)
    for (const value of ["PENDING", "deleted", "", null, 0]) {
      expect(isJoinRequestStatus(value)).toBe(false)
    }
  })

  it("offer approve and reject, and nothing that creates a user by itself", () => {
    expect([...JOIN_DECISIONS]).toEqual(["approve", "reject"])
  })
})

describe("the messages the public endpoints answer with", () => {
  // A constant per form is what keeps a clash from singling out its field: the
  // same text answers every cause. Listing every checked field is what tells
  // the applicant what to look at.
  it("list every field the standard form checks, including the username it asks for", () => {
    for (const field of ["email address", "username", "mobile number", "employee number"]) {
      expect(JOIN_IDENTITY_CONFLICT_MESSAGE).toContain(field)
    }
  })

  it("list every field the department sign-up checks, and no username, which it never asks for", () => {
    for (const field of ["email address", "mobile number", "employee number"]) {
      expect(DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE).toContain(field)
    }
    expect(DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE.toLowerCase()).not.toContain("username")
  })

  it("say why a field can clash and where to go if every field is the applicant's own", () => {
    for (const message of [JOIN_IDENTITY_CONFLICT_MESSAGE, DEPARTMENT_JOIN_IDENTITY_CONFLICT_MESSAGE]) {
      expect(message).toMatch(/only one account/)
      expect(message).toMatch(/waiting request/)
      expect(message).toMatch(/Forgot password/)
      expect(message).toMatch(/head office/)
    }
  })

  it("never name an organization when a code is not recognised", () => {
    expect(UNKNOWN_JOIN_CODE_MESSAGE).not.toMatch(/inactive|disabled|closed|not open/i)
    expect(UNKNOWN_JOIN_CODE_MESSAGE).toMatch(/not recognised/)
  })
})

describe("the organization's email domain on a submission", () => {
  it("refuses every address with 409 when the organization has set no domain", () => {
    for (const domain of [null, ""]) {
      expect(joinEmailDomainRefusal("ada@ke.com.pk", domain)).toEqual({
        message: JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE,
        status: 409,
      })
    }
  })

  it("accepts an address at exactly the domain", () => {
    expect(joinEmailDomainRefusal("ada@ke.com.pk", "ke.com.pk")).toBeNull()
    expect(joinEmailDomainRefusal("Ada@KE.com.pk", "ke.com.pk")).toBeNull()
  })

  it.each([
    "ada@gmail.com",
    "ada@mail.ke.com.pk",
    "ada@ke.com.pk.evil.test",
    "ada@evilke.com.pk",
  ])("refuses %j with 400, naming the domain to use", (email) => {
    expect(joinEmailDomainRefusal(email, "ke.com.pk")).toEqual({
      message: "Use your @ke.com.pk email address to join.",
      status: 400,
    })
  })

  it("says what to do, without naming the organization or the code", () => {
    expect(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE).toMatch(/email domain is not set/i)
    expect(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE).toMatch(/contact your organization/i)
    expect(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE).not.toMatch(/code/i)
    expect(joinEmailDomainMismatchMessage("ke.com.pk")).toBe("Use your @ke.com.pk email address to join.")
  })
})

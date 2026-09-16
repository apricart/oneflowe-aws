import { describe, expect, it } from "vitest"

import {
  findSharedEmails,
  forcedPasswordRotationPlanLines,
  forcedPasswordRotationReversalLines,
  planForcedPasswordRotation,
  planForcedPasswordRotationReversal,
  summarizeForcedPasswordRotation,
  summarizeRotationStatus,
  type RotationAccount,
  type RotationOptions,
} from "@/lib/forced-password-rotation"

const KE = "KE_LOGISTICS"

function account(overrides: Partial<RotationAccount> & Pick<RotationAccount, "id" | "username">): RotationAccount {
  return {
    email: `${overrides.username}@example.test`,
    role: "ORDER_PORTAL",
    externalSource: KE,
    externalId: overrides.username?.split("-")[1] ?? null,
    isActive: true,
    mustChangePassword: false,
    sessionVersion: 1,
    passwordChangedAt: null,
    ...overrides,
  }
}

const OPTIONS: RotationOptions = {
  roles: ["BRANCH_ADMIN", "ORDER_PORTAL"],
  externalSources: [KE],
  includeUnroutable: false,
}

/** A small K-Electric-shaped tenant: pairs, a retired holder, an HO account, a derived email. */
function tenant(): RotationAccount[] {
  return [
    account({ id: "u1", username: "imran-17655-ba", role: "BRANCH_ADMIN", email: "imrank@ke.com.pk", externalId: "17655", sessionVersion: 3 }),
    account({ id: "u2", username: "imran-17655-op", role: "ORDER_PORTAL", email: "imrank@ke.com.pk", externalId: "17655", sessionVersion: 1 }),
    account({ id: "u3", username: "saeed-12040-ba", role: "BRANCH_ADMIN", email: "shared@ke.com.pk", externalId: "12040" }),
    account({ id: "u4", username: "saeed-12040-op", role: "ORDER_PORTAL", email: "shared@ke.com.pk", externalId: "12040" }),
    account({ id: "u5", username: "asif-19001-ba", role: "BRANCH_ADMIN", email: "shared@ke.com.pk", externalId: "19001" }),
    account({ id: "u6", username: "asif-19001-op", role: "ORDER_PORTAL", email: "shared@ke.com.pk", externalId: "19001" }),
    account({ id: "u7", username: "nadia-15100-op", role: "ORDER_PORTAL", email: "nadia.khan@ke-legacy.invalid", externalId: "15100" }),
    account({ id: "u8", username: "nadia-15100-ba", role: "BRANCH_ADMIN", email: "nadia.khan@ke-legacy.invalid", externalId: "15100", mustChangePassword: true }),
    account({ id: "u9", username: "checking-18716-op", role: "ORDER_PORTAL", email: "hamza@ke.com.pk", externalId: "18716", externalSource: "KE_LOGISTICS_RETIRED", isActive: false }),
    account({ id: "u10", username: "hamza-18716-op", role: "ORDER_PORTAL", email: "hamza@ke.com.pk", externalId: "18716" }),
    account({ id: "u11", username: "ke.headoffice", role: "HEAD_OFFICE", email: "ho@ke.com.pk", externalSource: null, externalId: null }),
    account({ id: "u12", username: "ghost-1-op", role: "ORDER_PORTAL", email: "ghost@historical.invalid", externalSource: null, externalId: null, isActive: false }),
    account({ id: "u13", username: "left-17000-op", role: "ORDER_PORTAL", email: "left@ke.com.pk", externalId: "17000", isActive: false }),
  ]
}

describe("planForcedPasswordRotation", () => {
  it("flags every active mirrored -ba/-op account with a reachable address and nothing else", () => {
    const plan = planForcedPasswordRotation(tenant(), OPTIONS)

    expect(plan.targets.map((target) => target.username)).toEqual([
      "asif-19001-ba", "asif-19001-op",
      "hamza-18716-op",
      "imran-17655-ba", "imran-17655-op",
      "saeed-12040-ba", "saeed-12040-op",
    ])
    // The HEAD_OFFICE account, the retired holder and the synthetic author
    // are simply not the population — not even skips. An inactive account
    // *in* the population is a skip, so a deactivation between the dry run
    // and the commit changes the digest.
    expect(plan.skipped).toEqual([
      expect.objectContaining({ username: "left-17000-op", reason: "INACTIVE" }),
      expect.objectContaining({ username: "nadia-15100-ba", reason: "ALREADY_FLAGGED" }),
      expect.objectContaining({ username: "nadia-15100-op", reason: "EMAIL_UNROUTABLE" }),
    ])
  })

  it("pins each target to the session_version it read", () => {
    const plan = planForcedPasswordRotation(tenant(), OPTIONS)
    const imran = plan.targets.find((target) => target.username === "imran-17655-ba")
    expect(imran?.sessionVersion).toBe(3)
  })

  it("reports the addresses more than one person uses and marks their targets", () => {
    const plan = planForcedPasswordRotation(tenant(), OPTIONS)

    expect(plan.sharedEmails).toEqual([
      { email: "shared@ke.com.pk", people: 2, usernames: ["asif-19001-ba", "asif-19001-op", "saeed-12040-ba", "saeed-12040-op"] },
    ])
    // One person's own pair is not "shared": the same person reads both codes.
    expect(plan.sharedEmails.some((entry) => entry.email === "imrank@ke.com.pk")).toBe(false)
    expect(plan.targets.filter((target) => target.emailShared).map((target) => target.username)).toEqual([
      "asif-19001-ba", "asif-19001-op", "saeed-12040-ba", "saeed-12040-op",
    ])
  })

  it("is idempotent: a second run over the flagged rows plans nothing", () => {
    const first = planForcedPasswordRotation(tenant(), OPTIONS)
    const afterCommit = tenant().map((row) =>
      first.targets.some((target) => target.id === row.id)
        ? { ...row, mustChangePassword: true, sessionVersion: row.sessionVersion + 1 }
        : row,
    )

    const second = planForcedPasswordRotation(afterCommit, OPTIONS)

    expect(second.targets).toEqual([])
    expect(second.skipped.filter((skip) => skip.reason === "ALREADY_FLAGGED")).toHaveLength(first.targets.length + 1)
    expect(second.skipped.filter((skip) => skip.reason === "INACTIVE")).toHaveLength(1)
  })

  it("narrows to pinned usernames, case-insensitively, and names a pin that matches nothing", () => {
    const plan = planForcedPasswordRotation(tenant(), {
      ...OPTIONS,
      usernames: ["IMRAN-17655-OP", "imran-17655-ba", "nobody-1-op"],
    })

    expect(plan.targets.map((target) => target.username)).toEqual(["imran-17655-ba", "imran-17655-op"])
    expect(plan.skipped).toEqual([
      expect.objectContaining({ id: null, username: "nobody-1-op", reason: "NOT_SELECTED" }),
    ])
  })

  it("says so when a pinned name is outside the population rather than silently ignoring it", () => {
    const plan = planForcedPasswordRotation(tenant(), { ...OPTIONS, usernames: ["ke.headoffice", "checking-18716-op"] })

    expect(plan.targets).toEqual([])
    expect(plan.skipped.map((skip) => [skip.username, skip.reason])).toEqual([
      ["checking-18716-op", "NOT_SELECTED"],
      ["ke.headoffice", "NOT_SELECTED"],
    ])
  })

  it("narrows by role", () => {
    const plan = planForcedPasswordRotation(tenant(), { ...OPTIONS, roles: ["BRANCH_ADMIN"] })
    expect(plan.targets.every((target) => target.role === "BRANCH_ADMIN")).toBe(true)
    expect(plan.targets).toHaveLength(3)
  })

  it("never selects a portal-created account even when its role matches", () => {
    const rows = [account({ id: "p1", username: "portal-op", role: "ORDER_PORTAL", externalSource: null, externalId: null })]
    expect(planForcedPasswordRotation(rows, OPTIONS).targets).toEqual([])
  })

  it("flags an unreachable address only when told to, and says it will lock the account out", () => {
    const plan = planForcedPasswordRotation(tenant(), { ...OPTIONS, includeUnroutable: true })
    const nadia = plan.targets.find((target) => target.username === "nadia-15100-op")

    expect(nadia).toEqual(expect.objectContaining({ emailUnroutable: true }))
    expect(plan.skipped.some((skip) => skip.reason === "EMAIL_UNROUTABLE")).toBe(false)
    expect(forcedPasswordRotationPlanLines(plan)).toContain("FLAG u7 nadia-15100-op ORDER_PORTAL sv=1 unroutable-email")
  })

  it("treats an inactive account in the population as a skip, not a target", () => {
    const plan = planForcedPasswordRotation(tenant(), { ...OPTIONS, usernames: ["left-17000-op"] })
    expect(plan.targets).toEqual([])
    expect(plan.skipped).toEqual([expect.objectContaining({ username: "left-17000-op", reason: "INACTIVE" })])
  })

  it("produces stable lines so the digest changes exactly when a decision does", () => {
    const lines = forcedPasswordRotationPlanLines(planForcedPasswordRotation(tenant(), OPTIONS))

    expect(lines).toEqual([
      "FLAG u5 asif-19001-ba BRANCH_ADMIN sv=1 shared-email",
      "FLAG u6 asif-19001-op ORDER_PORTAL sv=1 shared-email",
      "FLAG u10 hamza-18716-op ORDER_PORTAL sv=1",
      "FLAG u1 imran-17655-ba BRANCH_ADMIN sv=3",
      "FLAG u2 imran-17655-op ORDER_PORTAL sv=1",
      "FLAG u3 saeed-12040-ba BRANCH_ADMIN sv=1 shared-email",
      "FLAG u4 saeed-12040-op ORDER_PORTAL sv=1 shared-email",
      "SKIP INACTIVE u13 left-17000-op",
      "SKIP ALREADY_FLAGGED u8 nadia-15100-ba",
      "SKIP EMAIL_UNROUTABLE u7 nadia-15100-op",
    ])
    // Input order does not matter.
    expect(forcedPasswordRotationPlanLines(planForcedPasswordRotation([...tenant()].reverse(), OPTIONS))).toEqual(lines)
  })

  it("summarises per role and per skip reason", () => {
    expect(summarizeForcedPasswordRotation(planForcedPasswordRotation(tenant(), OPTIONS))).toEqual({
      targets: 7,
      targetsByRole: { BRANCH_ADMIN: 3, ORDER_PORTAL: 4 },
      targetsWithSharedEmail: 4,
      skipped: 3,
      skippedByReason: { ALREADY_FLAGGED: 1, EMAIL_UNROUTABLE: 1, INACTIVE: 1, NOT_SELECTED: 0 },
      sharedEmails: 1,
    })
  })
})

describe("findSharedEmails", () => {
  it("counts people, not accounts, and ignores inactive rows", () => {
    const rows = [
      account({ id: "a", username: "one-1-ba", email: "X@ke.com.pk", externalId: "1" }),
      account({ id: "b", username: "one-1-op", email: "x@ke.com.pk", externalId: "1" }),
      account({ id: "c", username: "two-2-op", email: "x@KE.com.pk", externalId: "2", isActive: false }),
    ]
    expect(findSharedEmails(rows)).toEqual([])

    rows[2].isActive = true
    expect(findSharedEmails(rows)).toEqual([
      { email: "x@ke.com.pk", people: 2, usernames: ["one-1-ba", "one-1-op", "two-2-op"] },
    ])
  })

  it("treats an unstamped account as its own person", () => {
    const rows = [
      account({ id: "a", username: "ho", email: "x@ke.com.pk", externalSource: null, externalId: null, role: "HEAD_OFFICE" }),
      account({ id: "b", username: "one-1-op", email: "x@ke.com.pk", externalId: "1" }),
    ]
    expect(findSharedEmails(rows)[0]?.people).toBe(2)
  })
})

describe("planForcedPasswordRotationReversal", () => {
  const committed = [
    { id: "u1", username: "imran-17655-ba", sessionVersion: 3 },
    { id: "u2", username: "imran-17655-op", sessionVersion: 1 },
    { id: "u3", username: "saeed-12040-ba", sessionVersion: 1 },
    { id: "u4", username: "saeed-12040-op", sessionVersion: 1 },
    { id: "u99", username: "gone-1-op", sessionVersion: 1 },
  ]

  it("clears only accounts exactly as the run left them", () => {
    const current = [
      // Untouched since the run: flag set, version bumped once.
      account({ id: "u1", username: "imran-17655-ba", mustChangePassword: true, sessionVersion: 4 }),
      // Rotated: the person set a password; the flag is clear and the stamp is set.
      account({ id: "u2", username: "imran-17655-op", mustChangePassword: false, sessionVersion: 3, passwordChangedAt: new Date("2026-09-17T08:00:00Z") }),
      // An administrator cleared the flag by hand.
      account({ id: "u3", username: "saeed-12040-ba", mustChangePassword: false, sessionVersion: 2 }),
      // Something else bumped the version again (a lockout reset, another script).
      account({ id: "u4", username: "saeed-12040-op", mustChangePassword: true, sessionVersion: 3 }),
    ]

    const reversal = planForcedPasswordRotationReversal(committed, current)

    expect(reversal.clears).toEqual([{ id: "u1", username: "imran-17655-ba", sessionVersion: 4 }])
    expect(reversal.skipped.map((skip) => [skip.username, skip.reason])).toEqual([
      ["gone-1-op", "NOT_FOUND"],
      ["imran-17655-op", "ROTATED"],
      ["saeed-12040-ba", "ALREADY_CLEARED"],
      ["saeed-12040-op", "SESSION_MOVED"],
    ])
    expect(forcedPasswordRotationReversalLines(reversal)).toEqual([
      "CLEAR u1 imran-17655-ba sv=4",
      "SKIP NOT_FOUND u99 gone-1-op",
      "SKIP ROTATED u2 imran-17655-op",
      "SKIP ALREADY_CLEARED u3 saeed-12040-ba",
      "SKIP SESSION_MOVED u4 saeed-12040-op",
    ])
  })

  it("leaves a rotated account alone even if the flag were somehow set again", () => {
    const current = [account({ id: "u1", username: "imran-17655-ba", mustChangePassword: true, sessionVersion: 4, passwordChangedAt: "2026-09-17T08:00:00Z" })]
    const reversal = planForcedPasswordRotationReversal(committed.slice(0, 1), current)
    expect(reversal.clears).toEqual([])
    expect(reversal.skipped[0]?.reason).toBe("ROTATED")
  })
})

describe("summarizeRotationStatus", () => {
  it("counts pending, completed since the run, and pending-but-unreachable per role", () => {
    const since = new Date("2026-09-17T00:00:00Z")
    const rows = [
      account({ id: "u1", username: "a-1-ba", role: "BRANCH_ADMIN", mustChangePassword: true }),
      account({ id: "u2", username: "a-1-op", role: "ORDER_PORTAL", mustChangePassword: false, passwordChangedAt: "2026-09-17T09:00:00Z" }),
      account({ id: "u3", username: "b-2-op", role: "ORDER_PORTAL", mustChangePassword: false, passwordChangedAt: "2026-08-01T09:00:00Z" }),
      account({ id: "u4", username: "c-3-op", role: "ORDER_PORTAL", mustChangePassword: true, email: "c@ke-legacy.invalid" }),
      account({ id: "u5", username: "ho", role: "HEAD_OFFICE", externalSource: null, externalId: null, mustChangePassword: true }),
      account({ id: "u6", username: "d-4-op", role: "ORDER_PORTAL", mustChangePassword: true, isActive: false }),
    ]

    expect(summarizeRotationStatus(rows, OPTIONS, since)).toEqual({
      byRole: [
        { role: "BRANCH_ADMIN", pending: 1, completed: 0, unroutable: 0 },
        { role: "ORDER_PORTAL", pending: 1, completed: 1, unroutable: 1 },
      ],
      pendingUsernames: ["a-1-ba", "c-3-op"],
      unroutableUsernames: ["c-3-op"],
    })
  })
})

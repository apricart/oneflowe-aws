import { describe, expect, it } from "vitest"

import {
  BRANCH_NAME_OVERRIDES,
  KE_SYNC_SOURCE,
  isSyntheticAccount,
  planBranches,
  planDigest,
  planGroups,
  planUsernameMigration,
  planUsers,
  contestedIdentityFor,
  fallbackEmail,
  isSamePerson,
  summarize,
  type CurrentBranch,
  type CurrentUser,
  type LegacyLocation,
  type LegacySubUser,
} from "./ke-sync"

function location(overrides: Partial<LegacyLocation> & { ID: number; Name: string }): LegacyLocation {
  return { StatusID: 1, Address: null, ContactNo: null, Email: null, MonthlyBudget: 0, ...overrides }
}

function branch(overrides: Partial<CurrentBranch> & { id: number; name: string }): CurrentBranch {
  return { externalSource: null, externalId: null, groupId: null, ...overrides }
}

function subUser(overrides: Partial<LegacySubUser> & { ID: number }): LegacySubUser {
  return {
    Email: `user${overrides.ID}@ke.com.pk`,
    Passcode: String(10000 + overrides.ID),
    Password: "secret12",
    FirstName: "Test",
    LastName: "Person",
    LocationID: 1,
    StatusID: 1,
    ...overrides,
  }
}

function user(overrides: Partial<CurrentUser> & { id: string; roleName: string }): CurrentUser {
  return {
    username: null,
    email: "someone@ke.com.pk",
    fullName: null,
    branchId: 1,
    isActive: true,
    externalSource: null,
    externalId: null,
    ...overrides,
  }
}

describe("planBranches", () => {
  it("keeps a branch pinned by legacy id even when the names disagree", () => {
    const plan = planBranches(
      [location({ ID: 110, Name: "BALDIA IBC" })],
      [branch({ id: 208, name: "BALDIA", externalSource: KE_SYNC_SOURCE, externalId: "110" })],
    )
    expect(plan.pins).toHaveLength(1)
    expect(plan.pins[0]).toMatchObject({ branchId: 208, via: "EXTERNAL_ID", needsPin: false })
    expect(plan.pins[0].rename).toEqual({ from: "BALDIA", to: "BALDIA IBC" })
    expect(plan.creates).toHaveLength(0)
  })

  it("uses a confirmed override rather than the similarly named legacy record", () => {
    // Legacy holds both "GSO" (never used) and "1. GSO" (the real branch).
    const plan = planBranches(
      [location({ ID: 15, Name: "GSO" }), location({ ID: 44, Name: "1. GSO" })],
      [branch({ id: 141, name: "GSO" })],
    )
    const pinned = plan.pins.find((pin) => pin.branchId === 141)
    expect(pinned).toMatchObject({ legacyLocationId: 44, via: "NAME_OVERRIDE", needsPin: true })
    expect(pinned?.rename).toEqual({ from: "GSO", to: "1. GSO" })
    // The unused legacy record becomes a new branch rather than stealing the pin.
    expect(plan.creates.map((create) => create.legacyLocationId)).toEqual([15])
  })

  it("separates names that differ only in punctuation", () => {
    // Normalization strips punctuation, so "Johar |" and "Johar ||" collapse to
    // the same string — but they are different branches and match exactly.
    const plan = planBranches(
      [location({ ID: 146, Name: "Johar |" }), location({ ID: 147, Name: "Johar ||" })],
      [branch({ id: 243, name: "Johar |" }), branch({ id: 244, name: "Johar ||" })],
    )
    expect(plan.ambiguous).toHaveLength(0)
    expect(plan.creates).toHaveLength(0)
    expect(plan.pins.map((pin) => [pin.legacyLocationId, pin.branchId])).toEqual([[146, 243], [147, 244]])
  })

  it("still matches across punctuation drift when only one candidate remains", () => {
    const plan = planBranches(
      [location({ ID: 60, Name: "IBC-Malir" })],
      [branch({ id: 9, name: "IBC Malir" })],
    )
    expect(plan.pins).toHaveLength(1)
    expect(plan.pins[0].rename).toEqual({ from: "IBC Malir", to: "IBC-Malir" })
  })

  it("refuses to guess when the same name appears twice on one side", () => {
    const plan = planBranches(
      [location({ ID: 85, Name: "Distribution Strategy" }), location({ ID: 86, Name: "Distribution Strategy" })],
      [branch({ id: 1, name: "Distribution Strategy" })],
    )
    expect(plan.pins).toHaveLength(0)
    expect(plan.ambiguous.length).toBeGreaterThan(0)
    expect(plan.unmatched.map((b) => b.id)).toEqual([1])
  })

  it("prefers a character-for-character match over a case-insensitive rival", () => {
    // Legacy holds this pair for real. Both are pinned by id in production, so
    // this only decides what happens to a fresh database: the exact match wins
    // and the other legacy record becomes its own branch, rather than the sync
    // stalling or attaching the branch to whichever row was read first.
    const plan = planBranches(
      [location({ ID: 85, Name: "Distribution Strategy" }), location({ ID: 86, Name: "DISTRIBUTION STRATEGY" })],
      [branch({ id: 1, name: "Distribution Strategy" })],
    )
    expect(plan.pins.map((pin) => [pin.legacyLocationId, pin.branchId])).toEqual([[85, 1]])
    expect(plan.creates.map((create) => create.legacyLocationId)).toEqual([86])
    expect(plan.ambiguous).toHaveLength(0)
  })

  it("never claims one branch for two legacy locations", () => {
    const plan = planBranches(
      [location({ ID: 7, Name: "IBC Malir" }), location({ ID: 8, Name: "IBC Malir" })],
      [branch({ id: 3, name: "IBC Malir" })],
    )
    const claimed = plan.pins.map((pin) => pin.branchId)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it("reports a OneFlowe-only branch instead of deleting or renaming it", () => {
    const plan = planBranches([], [branch({ id: 245, name: "Technical" })])
    expect(plan.unmatched.map((b) => b.name)).toEqual(["Technical"])
    expect(plan.pins).toHaveLength(0)
  })

  it("creates the legacy locations that have no branch", () => {
    const plan = planBranches(
      [location({ ID: 168, Name: "IR", Address: " Head Office ", ContactNo: "" })],
      [],
    )
    expect(plan.creates).toEqual([
      { legacyLocationId: 168, name: "IR", address: "Head Office", contactNo: null, email: null },
    ])
  })

  it("is a no-op on a second run", () => {
    const legacy = [location({ ID: 44, Name: "1. GSO" })]
    const after = [branch({ id: 141, name: "1. GSO", externalSource: KE_SYNC_SOURCE, externalId: "44" })]
    const plan = planBranches(legacy, after)
    expect(plan.pins[0].needsPin).toBe(false)
    expect(plan.pins[0].rename).toBeNull()
    expect(plan.creates).toHaveLength(0)
  })
})

describe("planGroups", () => {
  const pins = planBranches(
    [location({ ID: 20, Name: "IBC Landhi" })],
    [branch({ id: 5, name: "IBC Landhi" })],
  ).pins

  it("assigns a pinned branch to its legacy group", () => {
    const plan = planGroups(
      [{ ID: 1, Name: "Enabling Group", LocationIDs: [20] }],
      [{ id: 13, name: "Enabling Group" }],
      pins,
      [branch({ id: 5, name: "IBC Landhi" })],
    )
    expect(plan.assignments).toEqual([
      { branchId: 5, branchName: "IBC Landhi", groupId: 13, groupName: "Enabling Group", fromGroupId: null },
    ])
  })

  it("skips a branch already in the right group", () => {
    const plan = planGroups(
      [{ ID: 1, Name: "Enabling Group", LocationIDs: [20] }],
      [{ id: 13, name: "Enabling Group" }],
      pins,
      [branch({ id: 5, name: "IBC Landhi", groupId: 13 })],
    )
    expect(plan.assignments).toHaveLength(0)
  })

  it("reports an unknown legacy group instead of creating one", () => {
    const plan = planGroups(
      [{ ID: 9, Name: "Brand New Group", LocationIDs: [20] }],
      [{ id: 13, name: "Enabling Group" }],
      pins,
      [branch({ id: 5, name: "IBC Landhi" })],
    )
    expect(plan.missingGroups).toEqual(["Brand New Group"])
    expect(plan.assignments).toHaveLength(0)
  })
})

describe("planUsernameMigration", () => {
  it("moves both roles onto the -ba / -op convention", () => {
    const { renames, collisions } = planUsernameMigration([
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997" }),
      user({ id: "b", roleName: "ORDER_PORTAL", username: "12997_op" }),
    ])
    expect(renames.map((r) => r.to).sort()).toEqual(["12997-ba", "12997-op"])
    expect(collisions).toHaveLength(0)
  })

  it("leaves synthetic historical placeholders alone", () => {
    const { renames } = planUsernameMigration([
      user({
        id: "s",
        roleName: "ORDER_PORTAL",
        username: "legacy_ke_133_10",
        email: "legacy_ke_133_10@historical.invalid",
        isActive: false,
      }),
    ])
    expect(renames).toHaveLength(0)
  })

  it("is a no-op once already migrated", () => {
    const { renames } = planUsernameMigration([
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997-ba" }),
      user({ id: "b", roleName: "ORDER_PORTAL", username: "12997-op" }),
    ])
    expect(renames).toHaveLength(0)
  })

  it("flags a rename that would land on a name already in use", () => {
    const { collisions } = planUsernameMigration([
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "500" }),
      user({ id: "b", roleName: "BRANCH_ADMIN", username: "500-ba" }),
    ])
    expect(collisions.map((c) => c.to)).toEqual(["500-ba"])
  })
})

describe("planUsers", () => {
  const pins = planBranches(
    [location({ ID: 1, Name: "IBC Malir" })],
    [branch({ id: 5, name: "IBC Malir" })],
  ).pins

  it("creates one approver and one order-portal account per legacy person", () => {
    const plan = planUsers([subUser({ ID: 201, Passcode: "15100" })], pins, [])
    expect(plan.people).toHaveLength(1)
    expect(plan.people[0].accounts).toEqual([
      { roleName: "BRANCH_ADMIN", username: "15100-ba" },
      { roleName: "ORDER_PORTAL", username: "15100-op" },
    ])
    expect(plan.people[0].branchId).toBe(5)
    expect(plan.people[0].legacyPassword).toBe("secret12")
  })

  it("collapses a doubled legacy name", () => {
    const plan = planUsers(
      [subUser({ ID: 199, FirstName: "Muhammad Yousuf Qasim", LastName: "Muhammad Yousuf Qasim" })],
      pins,
      [],
    )
    expect(plan.people[0].fullName).toBe("Muhammad Yousuf Qasim")
  })

  it("does not re-create someone who already holds accounts", () => {
    const plan = planUsers([subUser({ ID: 5, Passcode: "12997" })], pins, [
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997-ba", email: "user5@ke.com.pk" }),
      user({ id: "b", roleName: "ORDER_PORTAL", username: "12997-op", email: "user5@ke.com.pk" }),
    ])
    expect(plan.people).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(1)
    expect(plan.backfill).toHaveLength(0)
  })

  it("recognises a person whose accounts predate the rename", () => {
    const existing = [
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997", email: "user5@ke.com.pk" }),
      user({ id: "b", roleName: "ORDER_PORTAL", username: "12997_op", email: "user5@ke.com.pk" }),
    ]
    const renames = planUsernameMigration(existing).renames
    const plan = planUsers([subUser({ ID: 5, Passcode: "12997" })], pins, existing, { renames })
    expect(plan.people).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(1)
  })

  it("backfills the missing half of an incomplete pair", () => {
    const plan = planUsers([subUser({ ID: 5, Passcode: "12997" })], pins, [
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997-ba", branchId: 5, email: "user5@ke.com.pk" }),
    ])
    expect(plan.backfill).toEqual([
      { legacySubUserId: 5, email: "user5@ke.com.pk", username: "12997-op", roleName: "ORDER_PORTAL", branchId: 5 },
    ])
  })

  it("skips rather than invents when the source is incomplete", () => {
    const plan = planUsers(
      [
        subUser({ ID: 101, Passcode: "" }),
        subUser({ ID: 102, Password: "" }),
        subUser({ ID: 103, LocationID: null, SubuserLocations: [] }),
        subUser({ ID: 104, LocationID: 999 }),
      ],
      pins,
      [],
    )
    expect(plan.people).toHaveLength(0)
    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(
      ["BRANCH_NOT_PINNED", "NO_LOCATION", "NO_PASSCODE", "NO_PASSWORD"],
    )
  })

  it("derives an unroutable address for a person legacy has no email for", () => {
    const plan = planUsers(
      [subUser({ ID: 100, Email: null, FirstName: "Imran Khan", LastName: "Muhammad Bs" })],
      pins,
      [],
    )
    expect(plan.people).toHaveLength(1)
    expect(plan.people[0].email).toBe("imran.khan.muhammad.bs@ke-legacy.invalid")
    expect(plan.people[0].emailIsDerived).toBe(true)
    // Never a real domain: the outbox would mail a stranger K-Electric's orders.
    expect(plan.people[0].email).toMatch(/\.invalid$/)
  })

  it("falls back to a multi-location person's first location", () => {
    const plan = planUsers(
      [subUser({ ID: 7, LocationID: null, SubuserLocations: [{ LocationID: 1 }, { LocationID: 2 }] })],
      pins,
      [],
    )
    expect(plan.people[0].branchId).toBe(5)
  })

  it("never plans a username that another account already holds", () => {
    const plan = planUsers([subUser({ ID: 9, Passcode: "777" })], pins, [
      user({ id: "x", roleName: "BRANCH_ADMIN", username: "777-ba", email: "other@ke.com.pk" }),
    ])
    // A stranger holds the code, so the person is created beside them rather
    // than merged into them or dropped.
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.people.flatMap((p) => p.accounts.map((a) => a.username))).toEqual(["ke9-ba", "ke9-op"])
    expect(plan.people[0].accounts.every((a) => a.username !== "777-ba")).toBe(true)
  })

  it("stamps existing accounts with their employee code so email login stops applying", () => {
    const plan = planUsers([], pins, [
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997-ba" }),
      user({ id: "b", roleName: "ORDER_PORTAL", username: "12997-op" }),
    ])
    expect(plan.stamps).toEqual([
      { userId: "a", username: "12997-ba", externalId: "12997" },
      { userId: "b", username: "12997-op", externalId: "12997" },
    ])
  })

  it("does not stamp an account twice or stamp a synthetic placeholder", () => {
    const plan = planUsers([], pins, [
      user({ id: "a", roleName: "BRANCH_ADMIN", username: "12997-ba", externalSource: KE_SYNC_SOURCE, externalId: "12997" }),
      user({
        id: "s",
        roleName: "ORDER_PORTAL",
        username: "legacy_ke_133_10",
        email: "legacy_ke_133_10@historical.invalid",
        isActive: false,
      }),
    ])
    expect(plan.stamps).toHaveLength(0)
  })

  it("stamps the name the migration is about to give the account, not the old one", () => {
    const currentUsers = [user({ id: "a", roleName: "ORDER_PORTAL", username: "12997_op" })]
    const renames = planUsernameMigration(currentUsers).renames
    const plan = planUsers([], pins, currentUsers, { renames })
    expect(plan.stamps).toEqual([{ userId: "a", username: "12997-op", externalId: "12997" }])
  })

  it("gives two people at the same shared email their own accounts", () => {
    const plan = planUsers(
      [
        subUser({ ID: 10, Passcode: "111", Email: "shared@ke.com.pk" }),
        subUser({ ID: 11, Passcode: "222", Email: "shared@ke.com.pk" }),
      ],
      pins,
      [],
    )
    expect(plan.people).toHaveLength(2)
    expect(plan.people.flatMap((p) => p.accounts.map((a) => a.username))).toEqual([
      "111-ba", "111-op", "222-ba", "222-op",
    ])
  })
})

describe("planDigest", () => {
  const build = (name: string) => {
    const branches = planBranches([location({ ID: 1, Name: name })], [])
    return {
      branches,
      groups: { assignments: [], missingGroups: [] },
      usernames: { renames: [], collisions: [] },
      users: planUsers([], branches.pins, []),
    }
  }

  it("is stable for the same plan and moves when the plan moves", () => {
    expect(planDigest(build("IR"))).toBe(planDigest(build("IR")))
    expect(planDigest(build("IR"))).not.toBe(planDigest(build("IR 2")))
  })

  it("does not change when only a password changes", () => {
    const pins = planBranches([location({ ID: 1, Name: "IBC Malir" })], [branch({ id: 5, name: "IBC Malir" })]).pins
    const withPassword = (password: string) => ({
      branches: { pins, creates: [], unmatched: [], ambiguous: [] },
      groups: { assignments: [], missingGroups: [] },
      usernames: { renames: [], collisions: [] },
      users: planUsers([subUser({ ID: 1, Password: password })], pins, []),
    })
    expect(planDigest(withPassword("aaaaaaaa"))).toBe(planDigest(withPassword("bbbbbbbb")))
  })
})

describe("guards", () => {
  it("recognises synthetic historical accounts", () => {
    expect(isSyntheticAccount("legacy_ke_133_10@historical.invalid")).toBe(true)
    expect(isSyntheticAccount("real.person@ke.com.pk")).toBe(false)
    expect(isSyntheticAccount(null)).toBe(false)
  })

  it("only overrides branch names that were confirmed against order history", () => {
    expect([...BRANCH_NAME_OVERRIDES.keys()].sort((a, b) => a - b)).toEqual([44, 109, 110])
  })

  it("summarizes a plan without throwing on empty input", () => {
    const branches = planBranches([], [])
    expect(summarize({
      branches,
      groups: { assignments: [], missingGroups: [] },
      usernames: { renames: [], collisions: [] },
      users: planUsers([], [], []),
    })).toMatchObject({ branchesToCreate: 0, peopleToCreate: 0, accountsToCreate: 0 })
  })
})


describe("employee code conflicts", () => {
  const pins = planBranches(
    [location({ ID: 1, Name: "IBC Malir" })],
    [branch({ id: 5, name: "IBC Malir" })],
  ).pins

  const malaika = subUser({
    ID: 148,
    Passcode: "16476",
    FirstName: "Malaika Fayyaz Khan",
    LastName: "-",
    Email: "malaika.khan@ke.com.pk",
  })

  it("does not treat a different person holding the code as the same person", () => {
    // OneFlowe has 16476 on Danyal, who is not in the legacy system at all.
    const danyal = user({
      id: "danyal",
      roleName: "ORDER_PORTAL",
      username: "16476-op",
      email: "daniyal.siddiqui@ke.com.pk",
      fullName: "Danyal Ahmed Siddiqui",
    })
    expect(isSamePerson(malaika, danyal)).toBe(false)

    const plan = planUsers([malaika], pins, [danyal])
    expect(plan.alreadyPresent).toBe(0)
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({
      employeeCode: "16476",
      heldByEmail: "daniyal.siddiqui@ke.com.pk",
      assignedIdentity: "ke148",
    })
    // Created under a derived identity, with the real legacy email.
    expect(plan.people).toHaveLength(1)
    expect(plan.people[0].email).toBe("malaika.khan@ke.com.pk")
    expect(plan.people[0].employeeCode).toBe("ke148")
    expect(plan.people[0].accounts.map((a) => a.username)).toEqual(["ke148-ba", "ke148-op"])
  })

  it("leaves the sitting account alone", () => {
    const danyal = user({
      id: "danyal",
      roleName: "ORDER_PORTAL",
      username: "16476-op",
      email: "daniyal.siddiqui@ke.com.pk",
      fullName: "Danyal Ahmed Siddiqui",
    })
    const plan = planUsers([malaika], pins, [danyal])
    expect(plan.backfill.some((b) => b.username.startsWith("16476"))).toBe(false)
    expect(plan.stamps.map((s) => s.externalId)).toEqual(["16476"])
  })

  it("is idempotent once the contested person has been created", () => {
    const created = [
      user({ id: "d", roleName: "ORDER_PORTAL", username: "16476-op", email: "daniyal.siddiqui@ke.com.pk", fullName: "Danyal Ahmed Siddiqui" }),
      user({ id: "m1", roleName: "BRANCH_ADMIN", username: "ke148-ba", email: "malaika.khan@ke.com.pk", fullName: "Malaika Fayyaz Khan", externalSource: KE_SYNC_SOURCE, externalId: "ke148" }),
      user({ id: "m2", roleName: "ORDER_PORTAL", username: "ke148-op", email: "malaika.khan@ke.com.pk", fullName: "Malaika Fayyaz Khan", externalSource: KE_SYNC_SOURCE, externalId: "ke148" }),
    ]
    const plan = planUsers([malaika], pins, created)
    expect(plan.people).toHaveLength(0)
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(1)
    expect(plan.backfill).toHaveLength(0)
  })

  it("still matches the ordinary case where the code holder is the same person", () => {
    const self = user({
      id: "self",
      roleName: "ORDER_PORTAL",
      username: "16476-op",
      email: "malaika.khan@ke.com.pk",
      fullName: "Malaika Khan",
    })
    expect(isSamePerson(malaika, self)).toBe(true)
    const plan = planUsers([malaika], pins, [self])
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(1)
    expect(plan.backfill.map((b) => b.username)).toEqual(["16476-ba"])
  })

  it("treats a person whose email drifted domains as the same person", () => {
    // Legacy carries ramsha.javaid@ke.com; OneFlowe has ramsha.javaid@ke.com.pk.
    const legacy = subUser({ ID: 115, Passcode: "16291", FirstName: "Ramsha Javaid", LastName: "", Email: "ramsha.javaid@ke.com" })
    const account = user({
      id: "r", roleName: "ORDER_PORTAL", username: "16291-op",
      email: "ramsha.javaid@ke.com.pk", fullName: "Ramsha Javaid",
    })
    expect(isSamePerson(legacy, account)).toBe(true)
    const plan = planUsers([legacy], pins, [account])
    expect(plan.conflicts).toHaveLength(0)
    expect(plan.people).toHaveLength(0)
    expect(plan.alreadyPresent).toBe(1)
  })

  it("still calls it a clash when the name and the address both disagree", () => {
    const legacy = subUser({ ID: 148, Passcode: "16476", FirstName: "Malaika Fayyaz Khan", LastName: "-", Email: "malaika.khan@ke.com.pk" })
    const account = user({
      id: "d", roleName: "ORDER_PORTAL", username: "16476-op",
      email: "daniyal.siddiqui@ke.com.pk", fullName: "Danyal Ahmed Siddiqui",
    })
    expect(isSamePerson(legacy, account)).toBe(false)
  })

  it("names the derived identity after the legacy record, not the position", () => {
    expect(contestedIdentityFor(148)).toBe("ke148")
    expect(fallbackEmail({ ID: 9, FirstName: "A B", LastName: "C" })).toBe("a.b.c@ke-legacy.invalid")
  })
})

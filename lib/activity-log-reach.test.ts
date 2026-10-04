import { describe, expect, it } from "vitest"

import type { ActivityActor, ActivityReach } from "@/lib/activity-log"
import {
  OUTSIDE_ACTOR_LABEL,
  PLATFORM_ACTOR_LABEL,
  WITHHELD,
  classifyActivityActor,
  isActorIdentityKey,
  redactActorMetadata,
  redactedActor,
  visibleEntityId,
  type ActorEvidence,
} from "@/lib/activity-log-reach"

/**
 * What a Head Office reader may learn about the people in its own trail.
 * `plans/OF-AUDIT-head-office-activity-log.md`.
 */

const PLATFORM: ActivityReach = { kind: "platform" }
const OWN: ActivityReach = { kind: "organization", organizationId: 10 }

function evidence(overrides: Partial<ActorEvidence> = {}): ActorEvidence {
  return {
    actorId: "7a0c1c1e-0000-4000-8000-000000000001",
    actorEmail: null,
    rowRole: null,
    account: null,
    ...overrides,
  }
}

describe("classifyActivityActor", () => {
  it("shows everyone to the whole-platform reader", () => {
    expect(
      classifyActivityActor(evidence({ account: { organizationId: null, role: "SUPER_ADMIN" } }), PLATFORM),
    ).toBe("visible")
    expect(classifyActivityActor(evidence(), PLATFORM)).toBe("visible")
  })

  it("shows an account of the reader's own organization", () => {
    expect(
      classifyActivityActor(evidence({ account: { organizationId: 10, role: "BRANCH_ADMIN" } }), OWN),
    ).toBe("visible")
  })

  it("hides a Super Admin, by the account's role", () => {
    expect(
      classifyActivityActor(evidence({ account: { organizationId: null, role: "SUPER_ADMIN" } }), OWN),
    ).toBe("outside")
  })

  it("hides a Super Admin, by the role the row recorded, even with the account gone", () => {
    expect(classifyActivityActor(evidence({ rowRole: "SUPER_ADMIN" }), OWN)).toBe("outside")
  })

  it("hides someone who is Apricart staff now, whatever the row recorded then", () => {
    expect(
      classifyActivityActor(
        evidence({ rowRole: "HEAD_OFFICE", account: { organizationId: 10, role: "SUPER_ADMIN" } }),
        OWN,
      ),
    ).toBe("outside")
  })

  it("hides an account of another organization", () => {
    expect(
      classifyActivityActor(evidence({ account: { organizationId: 2, role: "HEAD_OFFICE" } }), OWN),
    ).toBe("outside")
  })

  it("hides an account with no organization that is not staff", () => {
    expect(
      classifyActivityActor(evidence({ account: { organizationId: null, role: "HEAD_OFFICE" } }), OWN),
    ).toBe("outside")
  })

  it("shows an employee principal whose row records a tenant role", () => {
    expect(
      classifyActivityActor(
        evidence({ actorId: "emp_42", rowRole: "ORDER_PORTAL", actorEmail: "e@tenant.test" }),
        OWN,
      ),
    ).toBe("visible")
  })

  it("fails closed on an unknown actor with no role", () => {
    expect(classifyActivityActor(evidence(), OWN)).toBe("outside")
    expect(classifyActivityActor(evidence({ actorId: null, actorEmail: "who@x.test" }), OWN)).toBe("outside")
  })

  it("recognises a row with nobody behind it", () => {
    expect(classifyActivityActor(evidence({ actorId: null, actorEmail: null }), OWN)).toBe("nobody")
  })
})

describe("redactedActor", () => {
  const known: ActivityActor = {
    id: "7a0c1c1e-0000-4000-8000-000000000001",
    email: "staff@apricart.test",
    name: "Staff Member",
    role: "SUPER_ADMIN",
    redacted: false,
  }

  it("keeps no identity, and says it was Apricart", () => {
    expect(redactedActor(known)).toEqual({
      id: null,
      email: null,
      name: PLATFORM_ACTOR_LABEL,
      role: "SUPER_ADMIN",
      redacted: true,
    })
  })

  it("drops the role of an outside actor who is not staff, since it would name their tenant's shape", () => {
    expect(redactedActor({ ...known, role: "HEAD_OFFICE" })).toEqual({
      id: null,
      email: null,
      name: OUTSIDE_ACTOR_LABEL,
      role: null,
      redacted: true,
    })
  })
})

describe("visibleEntityId", () => {
  it("withholds the typed identifier of an outside actor's sign-in", () => {
    expect(visibleEntityId("auth", "staff.username", "outside")).toBeNull()
    expect(visibleEntityId("user", "7a0c1c1e", "outside")).toBeNull()
  })

  it("keeps it for the tenant's own people and for every other record", () => {
    expect(visibleEntityId("auth", "branch.user", "visible")).toBe("branch.user")
    expect(visibleEntityId("category", "4242", "outside")).toBe("4242")
    expect(visibleEntityId(null, "4242", "outside")).toBe("4242")
  })
})

describe("isActorIdentityKey", () => {
  it.each([
    "ip",
    "IP",
    "ipAddress",
    "ip_address",
    "userAgent",
    "user_agent",
    "actorEmail",
    "actorRole",
    "actorUserId",
    "actorOrganizationId",
    "performedByUserId",
    "performedByRole",
    "approvedByUserId",
    "reviewedByName",
    "requestedByEmail",
    "byEmail",
    "userEmail",
    "adminEmail",
  ])("withholds %s", (key) => {
    expect(isActorIdentityKey(key)).toBe(true)
  })

  it.each(["before", "after", "price", "priceCents", "name", "status", "mode", "productId", "zip", "ship"])(
    "keeps %s",
    (key) => {
      expect(isActorIdentityKey(key)).toBe(false)
    },
  )
})

describe("redactActorMetadata", () => {
  it("withholds identity keys at every depth and keeps what changed", () => {
    const out = redactActorMetadata({
      ip: "198.51.100.10",
      userAgent: "Mozilla",
      actorEmail: "staff@apricart.test",
      before: { priceCents: 100, reviewedByName: "Staff Member" },
      after: { priceCents: 120 },
      rows: [{ id: 1, approvedByUserId: "u-1" }],
    })
    expect(out).toEqual({
      ip: WITHHELD,
      userAgent: WITHHELD,
      actorEmail: WITHHELD,
      before: { priceCents: 100, reviewedByName: WITHHELD },
      after: { priceCents: 120 },
      rows: [{ id: 1, approvedByUserId: WITHHELD }],
    })
  })

  it("passes scalars and null through", () => {
    expect(redactActorMetadata(null)).toBeNull()
    expect(redactActorMetadata("text")).toBe("text")
    expect(redactActorMetadata(3)).toBe(3)
  })

  it("is bounded in depth", () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < 20; level += 1) deep = { next: deep }
    expect(JSON.stringify(redactActorMetadata(deep))).toContain(WITHHELD)
  })
})

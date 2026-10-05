import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as decideRoute from "@/app/api/v1/delivery-addresses/[id]/route"
import * as listRoute from "@/app/api/v1/delivery-addresses/route"
import { auditLogs, branchDeliveryAddresses } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { loadApprovedDeliveryAddress } from "@/lib/server/delivery-addresses"

import {
  NO_DATABASE_REASON,
  createDeliveryAddressFixtures,
  destroyDeliveryAddressFixtures,
  hasTestDatabase,
  type DeliveryAddressFixtures,
} from "./helpers/delivery-address-fixtures"

const mocks = vi.hoisted(() => ({
  withRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetIn: 60 })),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limiter")>()
  return {
    ...actual,
    // No Redis here. That both mutating routes consult a limiter at all is a
    // structural fact, asserted by the route-shape test rather than here.
    withRateLimit: mocks.withRateLimit,
    checkRateLimit: mocks.checkRateLimit,
    getClientIdentifier: async () => "ip:127.0.0.1",
  }
})

const { getServerSession } = mockedNextAuth
const { GET: list, POST: request } = listRoute
const { PATCH: decide } = decideRoute

type Actor = { id: string; email: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function jsonRequest(path: string, method: string, payload?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
}

function getRequest(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`)
}

describe.skipIf(!hasTestDatabase)("delivery addresses, end to end", () => {
  let fixtures: DeliveryAddressFixtures

  const actor = (
    kind: "head" | "foreignHead" | "branchAdmin" | "orderPortal" | "groupRequester" | "superAdmin",
  ): Actor => {
    const email = (label: string) => `it-addr-${label}-${fixtures.suffix}@example.test`
    return {
      head: {
        id: fixtures.headOfficeId,
        email: email("head-office"),
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
      },
      foreignHead: {
        id: fixtures.foreignHeadOfficeId,
        email: email("foreign-head"),
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      },
      branchAdmin: {
        id: fixtures.branchAdminId,
        email: email("branch-admin"),
        role: "BRANCH_ADMIN",
        organizationId: fixtures.organizationId,
      },
      orderPortal: {
        id: fixtures.orderPortalId,
        email: email("order-portal"),
        role: "ORDER_PORTAL",
        organizationId: fixtures.organizationId,
      },
      groupRequester: {
        id: fixtures.groupRequesterId,
        email: email("group-requester"),
        role: "GROUP_ORDER_PORTAL",
        organizationId: fixtures.organizationId,
      },
      superAdmin: {
        id: fixtures.superAdminId,
        email: email("super-admin"),
        role: "SUPER_ADMIN",
        organizationId: null,
      },
    }[kind]
  }

  /** Raise a request as the given actor and return the parsed response. */
  async function raise(
    kind: Parameters<typeof actor>[0],
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    signIn(actor(kind))
    const response = await request(jsonRequest("/api/v1/delivery-addresses", "POST", payload))
    return { status: response.status, body: await response.json() }
  }

  async function decideAs(
    kind: Parameters<typeof actor>[0],
    id: number,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: any }> {
    signIn(actor(kind))
    const response = await decide(
      jsonRequest(`/api/v1/delivery-addresses/${id}`, "PATCH", payload),
      { params: Promise.resolve({ id: String(id) }) },
    )
    return { status: response.status, body: await response.json() }
  }

  async function listAs(
    kind: Parameters<typeof actor>[0],
    query = "",
  ): Promise<{ status: number; body: any }> {
    signIn(actor(kind))
    const response = await list(getRequest(`/api/v1/delivery-addresses${query}`))
    return { status: response.status, body: await response.json() }
  }

  const validAddress = (label: string, branchId: number) => ({
    branchId,
    label,
    address: "Plot 14, Sector 23, Korangi Industrial Area",
    city: "Karachi",
    province: "Sindh",
    contactPerson: "Site Supervisor",
    contactPhone: "+92 300 0000000",
    reason: "Bulk consignments cannot reach the main gate.",
  })

  beforeAll(async () => {
    fixtures = await createDeliveryAddressFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyDeliveryAddressFixtures(fixtures)
    await closePool()
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.withRateLimit.mockResolvedValue(null as never)
    await db
      .delete(branchDeliveryAddresses)
      .where(eq(branchDeliveryAddresses.organizationId, fixtures.organizationId))
    await db
      .delete(branchDeliveryAddresses)
      .where(eq(branchDeliveryAddresses.organizationId, fixtures.foreignOrganizationId))
  })

  describe("the lifecycle", () => {
    it("is raised pending, and nothing about the request can make it anything else", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))

      expect(created.status).toBe(201)
      expect(created.body.address.status).toBe("pending")

      const [stored] = await db
        .select()
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.id, created.body.address.id))

      expect(stored.status).toBe("pending")
      expect(stored.decidedAt).toBeNull()
      expect(stored.decidedByUserId).toBeNull()
      expect(stored.requestedByUserId).toBe(fixtures.orderPortalId)
      expect(stored.organizationId).toBe(fixtures.organizationId)
      // Normalized on the way in, so the duplicate index and the selector agree
      // on what this address is called.
      expect(stored.label).toBe("Gate 2")
      expect(stored.labelKey).toBe("gate 2")
    })

    it("is not usable until Head Office approves it, and then it is", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      const id = created.body.address.id

      const beforeDecision = await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        addressId: id,
      })
      expect(beforeDecision).toBeNull()

      const approved = await decideAs("head", id, { decision: "approve" })
      expect(approved.status).toBe(200)
      expect(approved.body.status).toBe("approved")

      const afterDecision = await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        addressId: id,
      })
      expect(afterDecision).not.toBeNull()
      expect(afterDecision?.label).toBe("Gate 2")
    })

    it("stays unusable forever once rejected", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      const id = created.body.address.id

      const rejected = await decideAs("head", id, { decision: "reject", reason: "Use the main gate." })
      expect(rejected.status).toBe(200)
      expect(rejected.body.status).toBe("rejected")

      expect(await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        addressId: id,
      })).toBeNull()
    })

    it("records the decider and the decision on the row", async () => {
      const created = await raise("branchAdmin", validAddress("Gate 2", fixtures.northBranchId))
      await decideAs("head", created.body.address.id, {
        decision: "approve",
        reason: "Checked with logistics.",
      })

      const [stored] = await db
        .select()
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.id, created.body.address.id))

      expect(stored.decidedByUserId).toBe(fixtures.headOfficeId)
      expect(stored.decidedAt).toBeInstanceOf(Date)
      expect(stored.decisionReason).toBe("Checked with logistics.")
    })

    it("writes an audit row naming both parties", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      await decideAs("head", created.body.address.id, { decision: "approve" })

      // Pinned to this address: audit rows are append-only, so earlier tests'
      // approvals are still in the table and an unordered `find` could pick one.
      const trail = await db
        .select()
        .from(auditLogs)
        .where(and(
          eq(auditLogs.organizationId, fixtures.organizationId),
          eq(auditLogs.entity, "branch_delivery_address"),
          eq(auditLogs.entityId, String(created.body.address.id)),
        ))

      const actions = trail.map((row) => row.action)
      expect(actions).toContain("REQUEST_BRANCH_DELIVERY_ADDRESS")
      expect(actions).toContain("APPROVE_BRANCH_DELIVERY_ADDRESS")

      const approval = trail.find((row) => row.action === "APPROVE_BRANCH_DELIVERY_ADDRESS")
      expect(approval?.userId).toBe(fixtures.headOfficeId)
      expect((approval?.metadata as any)?.requestedByUserId).toBe(fixtures.orderPortalId)
    })
  })

  describe("who may raise one", () => {
    it.each([
      ["orderPortal", "ORDER_PORTAL"],
      ["branchAdmin", "BRANCH_ADMIN"],
      ["groupRequester", "GROUP_ORDER_PORTAL"],
    ] as const)("admits %s for a branch it is assigned to", async (kind, roleName) => {
      // Pinned, so a fixture that quietly changed role would fail here rather
      // than pass this test about a role it is no longer exercising.
      expect(actor(kind).role).toBe(roleName)

      const created = await raise(kind, validAddress(`Gate ${kind}`, fixtures.northBranchId))
      expect(created.status).toBe(201)
    })

    it("refuses Head Office, which decides rather than requests", async () => {
      const refused = await raise("head", validAddress("Gate 2", fixtures.northBranchId))
      expect(refused.status).toBe(403)
    })

    it("refuses Super Admin, which acts for no branch", async () => {
      const refused = await raise("superAdmin", validAddress("Gate 2", fixtures.northBranchId))
      expect(refused.status).toBe(403)
    })

    it("refuses an unauthenticated caller", async () => {
      signIn(null)
      const response = await request(jsonRequest(
        "/api/v1/delivery-addresses",
        "POST",
        validAddress("Gate 2", fixtures.northBranchId),
      ))
      expect(response.status).toBe(401)
    })
  })

  describe("the branch fence", () => {
    it("refuses a branch in the caller's own tenant that it is not assigned to", async () => {
      const refused = await raise("branchAdmin", validAddress("Gate 2", fixtures.southBranchId))
      expect(refused.status).toBe(403)
    })

    it("refuses a group requester a branch outside its group", async () => {
      const refused = await raise("groupRequester", validAddress("Gate 2", fixtures.southBranchId))
      expect(refused.status).toBe(403)
    })

    it("refuses another tenant's branch", async () => {
      const refused = await raise("orderPortal", validAddress("Gate 2", fixtures.foreignBranchId))
      expect(refused.status).toBe(403)
    })

    it("writes nothing when the branch is refused", async () => {
      await raise("branchAdmin", validAddress("Gate 2", fixtures.southBranchId))
      const rows = await db
        .select()
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.branchId, fixtures.southBranchId))
      expect(rows).toHaveLength(0)
    })
  })

  describe("who may decide one", () => {
    let pendingId = 0

    beforeEach(async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      pendingId = created.body.address.id
    })

    it.each([
      ["orderPortal", "ORDER_PORTAL"],
      ["branchAdmin", "BRANCH_ADMIN"],
      ["groupRequester", "GROUP_ORDER_PORTAL"],
      ["superAdmin", "SUPER_ADMIN"],
    ] as const)("refuses %s", async (kind, roleName) => {
      expect(actor(kind).role).toBe(roleName)

      const refused = await decideAs(kind, pendingId, { decision: "approve" })
      expect(refused.status).toBe(403)
    })

    it("refuses an unauthenticated caller", async () => {
      signIn(null)
      const response = await decide(
        jsonRequest(`/api/v1/delivery-addresses/${pendingId}`, "PATCH", { decision: "approve" }),
        { params: Promise.resolve({ id: String(pendingId) }) },
      )
      expect(response.status).toBe(401)
    })

    it("leaves the row pending when the decision is refused", async () => {
      await decideAs("orderPortal", pendingId, { decision: "approve" })
      const [stored] = await db
        .select({ status: branchDeliveryAddresses.status })
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.id, pendingId))
      expect(stored.status).toBe("pending")
    })

    /**
     * Another tenant's Head Office gets *not found*, not *forbidden* — the same
     * answer as an id that does not exist, so the id space cannot be walked.
     */
    it("tells another tenant's Head Office the address does not exist", async () => {
      const refused = await decideAs("foreignHead", pendingId, { decision: "approve" })
      expect(refused.status).toBe(404)

      const [stored] = await db
        .select({ status: branchDeliveryAddresses.status })
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.id, pendingId))
      expect(stored.status).toBe("pending")
    })

    it("answers 404 for an address that has never existed, in the same words", async () => {
      const missing = await decideAs("head", 2_146_000_000, { decision: "approve" })
      expect(missing.status).toBe(404)

      const foreign = await decideAs("foreignHead", pendingId, { decision: "approve" })
      expect(foreign.body.error).toBe(missing.body.error)
    })

    it.each([["1abc"], ["1.5"], ["-1"], ["0"], [" 1"]])(
      "refuses %s as an id rather than reading some other row",
      async (raw) => {
        signIn(actor("head"))
        const response = await decide(
          jsonRequest(`/api/v1/delivery-addresses/${raw}`, "PATCH", { decision: "approve" }),
          { params: Promise.resolve({ id: raw }) },
        )
        expect(response.status).toBe(400)

        const [stored] = await db
          .select({ status: branchDeliveryAddresses.status })
          .from(branchDeliveryAddresses)
          .where(eq(branchDeliveryAddresses.id, pendingId))
        expect(stored.status).toBe("pending")
      },
    )
  })

  describe("replay and duplicates", () => {
    it("refuses a second decision on a decided address", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      const id = created.body.address.id

      expect((await decideAs("head", id, { decision: "approve" })).status).toBe(200)

      const replay = await decideAs("head", id, { decision: "reject" })
      expect(replay.status).toBe(409)

      const [stored] = await db
        .select({ status: branchDeliveryAddresses.status })
        .from(branchDeliveryAddresses)
        .where(eq(branchDeliveryAddresses.id, id))
      // The first decision stands; the replay did not overwrite it.
      expect(stored.status).toBe("approved")
    })

    it("refuses a second live request for the same label at the same branch", async () => {
      expect((await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))).status).toBe(201)

      const duplicate = await raise("branchAdmin", validAddress("Gate 2", fixtures.northBranchId))
      expect(duplicate.status).toBe(409)
    })

    it("treats a differently-spelled label as the same one", async () => {
      await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))

      const duplicate = await raise("orderPortal", validAddress("  gate   2 ", fixtures.northBranchId))
      expect(duplicate.status).toBe(409)
    })

    it("refuses a label that is already approved", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      await decideAs("head", created.body.address.id, { decision: "approve" })

      const duplicate = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      expect(duplicate.status).toBe(409)
    })

    it("lets a rejected label be asked for again", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      await decideAs("head", created.body.address.id, { decision: "reject", reason: "Not yet." })

      const retry = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      expect(retry.status).toBe(201)
    })

    it("lets two branches use the same label", async () => {
      expect((await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))).status).toBe(201)
      // Head Office does not raise requests, so the South branch's row is
      // written directly — the point here is the index, not the endpoint.
      const [southRow] = await db
        .insert(branchDeliveryAddresses)
        .values({
          organizationId: fixtures.organizationId,
          branchId: fixtures.southBranchId,
          label: "Gate 2",
          labelKey: "gate 2",
          address: "Another plot",
          status: "pending",
          requestedByUserId: fixtures.headOfficeId,
        })
        .returning({ id: branchDeliveryAddresses.id })
      expect(southRow.id).toBeGreaterThan(0)
    })
  })

  describe("validation", () => {
    it.each([
      ["an empty label", { label: "" }],
      ["a whitespace-only label", { label: "   " }],
      ["an empty address", { address: "" }],
      ["a label past the column width", { label: "x".repeat(121) }],
    ])("refuses %s", async (_label, override) => {
      const refused = await raise("orderPortal", {
        ...validAddress("Gate 2", fixtures.northBranchId),
        ...override,
      })
      expect(refused.status).toBe(400)
    })

    /** Mass assignment: none of these are fields a requester may set. */
    it.each([
      ["status", { status: "approved" }],
      ["decidedByUserId", { decidedByUserId: "00000000-0000-0000-0000-000000000000" }],
      ["organizationId", { organizationId: 1 }],
      ["requestedByUserId", { requestedByUserId: "00000000-0000-0000-0000-000000000000" }],
    ])("rejects a body carrying %s rather than applying it", async (_label, override) => {
      const refused = await raise("orderPortal", {
        ...validAddress("Gate 2", fixtures.northBranchId),
        ...override,
      })
      expect(refused.status).toBe(400)
      expect(refused.body.error).toContain("Unknown field")
    })

    it("refuses a decision that is neither approve nor reject", async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      const refused = await decideAs("head", created.body.address.id, { decision: "archive" })
      expect(refused.status).toBe(400)
    })
  })

  describe("the list", () => {
    beforeEach(async () => {
      await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      await db.insert(branchDeliveryAddresses).values([
        {
          organizationId: fixtures.organizationId,
          branchId: fixtures.southBranchId,
          label: "South Yard",
          labelKey: "south yard",
          address: "South plot",
          status: "approved",
          requestedByUserId: fixtures.headOfficeId,
          decidedByUserId: fixtures.headOfficeId,
          decidedAt: new Date(),
        },
        {
          organizationId: fixtures.foreignOrganizationId,
          branchId: fixtures.foreignBranchId,
          label: "Foreign Yard",
          labelKey: "foreign yard",
          address: "Foreign plot",
          status: "approved",
          requestedByUserId: fixtures.foreignHeadOfficeId,
          decidedByUserId: fixtures.foreignHeadOfficeId,
          decidedAt: new Date(),
        },
      ])
    })

    it("shows a requester only its own branches", async () => {
      const response = await listAs("branchAdmin")
      expect(response.status).toBe(200)
      const branchIds = response.body.items.map((item: any) => item.branchId)
      expect(new Set(branchIds)).toEqual(new Set([fixtures.northBranchId]))
    })

    it("shows Head Office its whole tenant and nothing beyond it", async () => {
      const response = await listAs("head")
      expect(response.status).toBe(200)
      const branchIds = new Set(response.body.items.map((item: any) => item.branchId))
      expect(branchIds).toEqual(new Set([fixtures.northBranchId, fixtures.southBranchId]))
      expect(branchIds.has(fixtures.foreignBranchId)).toBe(false)
    })

    it("never lets another tenant's row through a branchId parameter", async () => {
      const response = await listAs("head", `?branchId=${fixtures.foreignBranchId}`)
      expect(response.status).toBe(200)
      expect(response.body.items).toHaveLength(0)
    })

    it("narrows a requester to nothing rather than widening it", async () => {
      const response = await listAs("branchAdmin", `?branchId=${fixtures.southBranchId}`)
      expect(response.status).toBe(200)
      expect(response.body.items).toHaveLength(0)
    })

    it("offers a requester only the branches it may raise a request for", async () => {
      const response = await listAs("groupRequester")
      const ids = response.body.requestableBranches.map((branch: any) => branch.id)
      expect(ids).toEqual([fixtures.northBranchId])
    })

    it("offers Head Office no branch to raise a request for", async () => {
      const response = await listAs("head")
      expect(response.body.requestableBranches).toEqual([])
      expect(response.body.canDecide).toBe(true)
    })

    it("tells a requester it cannot decide", async () => {
      const response = await listAs("orderPortal")
      expect(response.body.canDecide).toBe(false)
    })

    it("refuses an unknown status filter rather than passing it to SQL", async () => {
      const response = await listAs("head", "?status=archived")
      expect(response.status).toBe(400)
    })

    it("refuses a non-numeric branchId", async () => {
      const response = await listAs("head", "?branchId=1;DROP")
      expect(response.status).toBe(400)
    })

    it("refuses Super Admin, which is not admitted to the tenant's queue", async () => {
      const response = await listAs("superAdmin")
      expect(response.status).toBe(403)
    })
  })

  describe("the guard order creation trusts", () => {
    let approvedId = 0

    beforeEach(async () => {
      const created = await raise("orderPortal", validAddress("Gate 2", fixtures.northBranchId))
      approvedId = created.body.address.id
      await decideAs("head", approvedId, { decision: "approve" })
    })

    it("finds an approved address of the right branch in the right tenant", async () => {
      expect(await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        addressId: approvedId,
      })).not.toBeNull()
    })

    it("refuses it for a different branch in the same tenant", async () => {
      expect(await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.southBranchId,
        addressId: approvedId,
      })).toBeNull()
    })

    it("refuses it for a different tenant", async () => {
      expect(await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.foreignOrganizationId,
        branchId: fixtures.northBranchId,
        addressId: approvedId,
      })).toBeNull()
    })

    it("refuses an id that does not exist", async () => {
      expect(await loadApprovedDeliveryAddress(db, {
        organizationId: fixtures.organizationId,
        branchId: fixtures.northBranchId,
        addressId: 2_146_000_000,
      })).toBeNull()
    })
  })
})

describe.skipIf(hasTestDatabase)("delivery addresses", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})

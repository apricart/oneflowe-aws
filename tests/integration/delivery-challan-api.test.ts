import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"
import sharp from "sharp"

import * as uploadRoute from "@/app/api/v1/upload/image/route"
import * as progressRoute from "@/app/api/v1/orders/[id]/fulfillment-status/route"
import * as challanRoute from "@/app/api/v1/orders/[id]/delivery-challan/route"
import * as challanFileRoute from "@/app/api/v1/orders/[id]/delivery-challan/[challanId]/file/route"
import {
  auditLogs,
  branches,
  groups,
  orderDeliveryChallans,
  orders,
  organizations,
  roles,
  systemLogs,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The delivery challan, end to end, against Postgres.
 * See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
 *
 * Identity, request headers, the rate limiter, the cache and the S3 bucket are
 * faked (the bucket by an in-memory map); every route is the real handler, and
 * the database constraints are the real ones.
 *
 * ```text
 * Tenant A                                          Tenant B
 *   group G ── branch A1   order X (approved, out for delivery, raised by OP A1)
 *              branch A2                              branch B1  order Z
 *   order P at A1 is still pending
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})
const bucket = vi.hoisted(() => new Map<string, { body: Buffer; contentType: string }>())
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return {
    ...actual,
    isImageStorageConfigured: () => true,
    putImage: vi.fn(async (input: { key: string; body: Buffer; contentType: string }) => {
      bucket.set(input.key, { body: input.body, contentType: input.contentType })
    }),
    getImage: vi.fn(async (key: string) => {
      const object = bucket.get(key)
      if (!object) return null
      return {
        body: { transformToWebStream: () => new Blob([new Uint8Array(object.body)]).stream() },
        contentType: object.contentType,
        contentLength: object.body.length,
      }
    }),
  }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor ? ({ user: { ...actor, mustChangePassword: false } } as any) : null,
  )
}

const json = (url: string, method: string, body?: unknown) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by delivery challan tests" })
    .returning({ id: roles.id })
  return created.id
}

function minimalPdf(extra = ""): Buffer {
  return Buffer.from([
    "%PDF-1.7",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
    "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj",
    extra,
    "trailer\n<< /Root 1 0 R >>\n%%EOF\n",
  ].join("\n"), "latin1")
}

describe.skipIf(!hasTestDatabase)("the delivery challan through the API", () => {
  const suffix = randomUUID().slice(0, 8)
  const actors: Record<string, Actor> = {}
  let orgA: number
  let orgB: number
  let branchA1: number
  let branchA2: number
  let branchB1: number
  let groupG: number
  let orderX: number
  let orderP: number
  let orderZ: number
  let png: Buffer
  let pdfChallanId: number
  let replacementId: number

  const upload = async (actor: Actor | null, fields: { orderId?: string | number; file: File; purpose?: string | null }) => {
    signIn(actor)
    const form = new FormData()
    form.append("image", fields.file)
    if (fields.purpose !== null) form.append("purpose", fields.purpose ?? "delivery-challan")
    if (fields.orderId !== undefined) form.append("orderId", String(fields.orderId))
    return read(await uploadRoute.POST(new NextRequest("http://localhost/api/v1/upload/image", { method: "POST", body: form })))
  }

  const progress = async (actor: Actor | null, orderId: number, body: unknown) => {
    signIn(actor)
    return read(await progressRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/fulfillment-status`, "POST", body),
      { params: Promise.resolve({ id: String(orderId) }) },
    ))
  }

  const list = async (actor: Actor | null, orderId: number) => {
    signIn(actor)
    return read(await challanRoute.GET(
      json(`http://localhost/api/v1/orders/${orderId}/delivery-challan`, "GET"),
      { params: Promise.resolve({ id: String(orderId) }) },
    ))
  }

  const replace = async (actor: Actor | null, orderId: number, body: unknown) => {
    signIn(actor)
    return read(await challanRoute.POST(
      json(`http://localhost/api/v1/orders/${orderId}/delivery-challan`, "POST", body),
      { params: Promise.resolve({ id: String(orderId) }) },
    ))
  }

  const file = async (actor: Actor | null, orderId: number, challanId: number) => {
    signIn(actor)
    return challanFileRoute.GET(
      json(`http://localhost/api/v1/orders/${orderId}/delivery-challan/${challanId}/file`, "GET"),
      { params: Promise.resolve({ id: String(orderId), challanId: String(challanId) }) },
    )
  }

  const pngFile = (name = "challan.png") => new File([new Uint8Array(png)], name, { type: "image/png" })
  const pdfFile = (body = minimalPdf(), name = "challan.pdf") => new File([new Uint8Array(body)], name, { type: "application/pdf" })

  const stored = async (orderId: number) => {
    const [row] = await db.select({ fulfillmentStatus: orders.fulfillmentStatus, deliveredAt: orders.deliveredAt })
      .from(orders).where(eq(orders.id, orderId)).limit(1)
    return row
  }

  beforeAll(async () => {
    png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 240, g: 240, b: 240 } } }).png().toBuffer()

    const roleIds = Object.fromEntries(await Promise.all([
      "SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL", "VIEWER", "ORDER_DESK",
    ].map(async (name) => [name, await resolveRoleId(name)] as const)))

    const [a] = await db.insert(organizations).values({ name: `IT DC A ${suffix}`, code: `ITDCA_${suffix}` }).returning({ id: organizations.id })
    const [b] = await db.insert(organizations).values({ name: `IT DC B ${suffix}`, code: `ITDCB_${suffix}` }).returning({ id: organizations.id })
    orgA = a.id
    orgB = b.id

    const person = async (label: string, role: string, organizationId: number | null, branchId: number | null) => {
      const email = `it-dc-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-dc-${label}-${suffix}`, passwordHash: "x", roleId: roleIds[role], organizationId, branchId, fullName: `${label} ${suffix}`,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }

    await person("superAdmin", "SUPER_ADMIN", null, null)
    await person("otherSuperAdmin", "SUPER_ADMIN", null, null)
    await person("headOffice", "HEAD_OFFICE", orgA, null)
    await person("headOfficeB", "HEAD_OFFICE", orgB, null)

    const [g] = await db.insert(groups).values({ organizationId: orgA, name: `IT DC G ${suffix}`, createdByUserId: actors.headOffice.id })
      .returning({ id: groups.id })
    groupG = g.id
    const [a1, a2, b1] = await db.insert(branches).values([
      { organizationId: orgA, groupId: groupG, name: `IT DC A1 ${suffix}`, status: "active" },
      { organizationId: orgA, name: `IT DC A2 ${suffix}`, status: "active" },
      { organizationId: orgB, name: `IT DC B1 ${suffix}`, status: "active" },
    ]).returning({ id: branches.id })
    branchA1 = a1.id
    branchA2 = a2.id
    branchB1 = b1.id

    await person("branchAdminA1", "BRANCH_ADMIN", orgA, branchA1)
    await person("branchAdminA2", "BRANCH_ADMIN", orgA, branchA2)
    await person("groupUser", "GROUP_USER", orgA, null)
    await person("groupOrderPortal", "GROUP_ORDER_PORTAL", orgA, null)
    await person("raiser", "ORDER_PORTAL", orgA, branchA1)
    await person("colleague", "ORDER_PORTAL", orgA, branchA1)
    await person("orderPortalA2", "ORDER_PORTAL", orgA, branchA2)
    await person("viewer", "VIEWER", orgA, null)
    await person("orderDesk", "ORDER_DESK", null, null)

    await db.insert(userGroupAssignments).values([
      { userId: actors.groupUser.id, groupId: groupG, organizationId: orgA, createdByUserId: actors.headOffice.id },
      { userId: actors.groupOrderPortal.id, groupId: groupG, organizationId: orgA, createdByUserId: actors.headOffice.id },
    ])

    const place = async (key: string, values: { organizationId: number; branchId: number; status: string; fulfillmentStatus?: string }) => {
      const [row] = await db.insert(orders).values({
        tid: `DC${suffix}${key}`.slice(0, 26),
        createdByUserId: actors.raiser.id,
        createdByRole: "ORDER_PORTAL",
        approvedAt: values.status === "APPROVED" ? new Date() : null,
        ...values,
      }).returning({ id: orders.id })
      return row.id
    }
    orderX = await place("X", { organizationId: orgA, branchId: branchA1, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
    orderP = await place("P", { organizationId: orgA, branchId: branchA1, status: "PENDING" })
    orderZ = await place("Z", { organizationId: orgB, branchId: branchB1, status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
  })

  afterAll(async () => {
    if (!orgA) return
    const organizationIds = [orgA, orgB]
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, actorIds)))
    await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.userId, actorIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(groups).where(eq(groups.id, groupG))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
  })

  describe("uploading", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await upload(null, { orderId: orderX, file: pngFile() })).status).toBe(401)
    })

    it.each(["headOffice", "orderDesk", "raiser", "branchAdminA1", "viewer"])("lets only Super Admin upload one, not %s", async (key) => {
      const before = bucket.size
      expect((await upload(actors[key], { orderId: orderX, file: pngFile() })).status).toBe(403)
      expect(bucket.size).toBe(before)
    })

    it("needs a real order that has been approved", async () => {
      expect((await upload(actors.superAdmin, { file: pngFile() })).status).toBe(400)
      expect((await upload(actors.superAdmin, { orderId: "1 OR 1=1", file: pngFile() })).status).toBe(400)
      expect((await upload(actors.superAdmin, { orderId: 2_000_000_000, file: pngFile() })).status).toBe(404)
      expect((await upload(actors.superAdmin, { orderId: orderP, file: pngFile() })).status).toBe(409)
    })

    it("decides the type by content, and refuses anything else", async () => {
      const text = new File(["just some text"], "challan.png", { type: "image/png" })
      expect((await upload(actors.superAdmin, { orderId: orderX, file: text })).status).toBe(400)
      const html = new File(["<html><script>alert(1)</script></html>"], "challan.pdf", { type: "application/pdf" })
      expect((await upload(actors.superAdmin, { orderId: orderX, file: html })).status).toBe(400)
    })

    it("refuses a PDF that carries script", async () => {
      const active = minimalPdf("3 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj")
      const { status } = await upload(actors.superAdmin, { orderId: orderX, file: pdfFile(active) })
      expect(status).toBe(400)
      expect(await db.select({ id: orderDeliveryChallans.id }).from(orderDeliveryChallans).where(eq(orderDeliveryChallans.orderId, orderX)))
        .toHaveLength(0)
    })

    it("stores an accepted file privately, unattached, under a server-made name, and audits it", async () => {
      const { status, body } = await upload(actors.superAdmin, { orderId: orderX, file: pdfFile(minimalPdf(), "../../DC 77.PDF") })
      expect(status).toBe(201)
      expect(body.deliveryChallan).toMatchObject({ fileName: "DC 77.pdf", contentType: "application/pdf" })
      pdfChallanId = body.deliveryChallan.id

      const [row] = await db.select().from(orderDeliveryChallans).where(eq(orderDeliveryChallans.id, pdfChallanId))
      expect(row).toMatchObject({ orderId: orderX, organizationId: orgA, branchId: branchA1, uploadedByUserId: actors.superAdmin.id, attachedAt: null })
      expect(row.storageKey).toMatch(/^delivery-challan\/[0-9a-f-]{36}\.pdf$/)
      expect(bucket.has(row.storageKey)).toBe(true)
      expect(JSON.stringify(body)).not.toContain(row.storageKey)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "UPLOAD_DELIVERY_CHALLAN"), eq(auditLogs.entityId, String(orderX))))
      expect(audit?.userId).toBe(actors.superAdmin.id)
    })
  })

  describe("marking delivered", () => {
    it("refuses a delivery without a challan", async () => {
      expect((await progress(actors.superAdmin, orderX, { fulfillmentStatus: "DELIVERED" })).status).toBe(400)
      expect((await stored(orderX)).fulfillmentStatus).toBe("OUT_FOR_DELIVERY")
    })

    it("refuses another order's challan, and leaves the order as it was", async () => {
      const foreign = await upload(actors.superAdmin, { orderId: orderZ, file: pngFile() })
      expect(foreign.status).toBe(201)
      const { status } = await progress(actors.superAdmin, orderX, { fulfillmentStatus: "DELIVERED", deliveryChallanId: foreign.body.deliveryChallan.id })
      expect(status).toBe(400)
      expect(await stored(orderX)).toMatchObject({ fulfillmentStatus: "OUT_FOR_DELIVERY", deliveredAt: null })
    })

    it("refuses a challan another Super Admin uploaded", async () => {
      const theirs = await upload(actors.otherSuperAdmin, { orderId: orderX, file: pngFile() })
      expect(theirs.status).toBe(201)
      const { status } = await progress(actors.superAdmin, orderX, { fulfillmentStatus: "DELIVERED", deliveryChallanId: theirs.body.deliveryChallan.id })
      expect(status).toBe(400)
      expect((await stored(orderX)).fulfillmentStatus).toBe("OUT_FOR_DELIVERY")
    })

    it("refuses a challan at any other stage", async () => {
      expect((await progress(actors.superAdmin, orderZ, { fulfillmentStatus: "IN_PROCESS", deliveryChallanId: pdfChallanId })).status).toBe(400)
    })

    it("delivers with the uploader's own challan for this order, attaching it in the same step", async () => {
      const { status, body } = await progress(actors.superAdmin, orderX, { fulfillmentStatus: "DELIVERED", deliveryChallanId: pdfChallanId })
      expect(status).toBe(200)
      expect(body.item.fulfillmentStatus).toBe("DELIVERED")

      const [row] = await db.select({ attachedAt: orderDeliveryChallans.attachedAt }).from(orderDeliveryChallans)
        .where(eq(orderDeliveryChallans.id, pdfChallanId))
      expect(row.attachedAt).toBeInstanceOf(Date)

      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.action, "ORDER_FULFILLMENT_STATUS_UPDATE"), eq(auditLogs.entityId, String(orderX))))
      expect(audit.metadata).toMatchObject({ to: "DELIVERED", deliveryChallanId: pdfChallanId })
    })

    it("cannot use the same challan twice", async () => {
      expect((await replace(actors.superAdmin, orderX, { deliveryChallanId: pdfChallanId })).status).toBe(400)
    })
  })

  describe("reading", () => {
    it("refuses an unauthenticated caller", async () => {
      expect((await list(null, orderX)).status).toBe(401)
      expect((await file(null, orderX, pdfChallanId)).status).toBe(401)
    })

    it.each(["superAdmin", "headOffice", "branchAdminA1", "groupUser", "groupOrderPortal", "raiser"])(
      "lets %s, who can read the order, read its challan",
      async (key) => {
        const { status, body } = await list(actors[key], orderX)
        expect(status).toBe(200)
        expect(body.items).toEqual([expect.objectContaining({ id: pdfChallanId, current: true, fileName: "DC 77.pdf" })])
        expect(JSON.stringify(body)).not.toMatch(/delivery-challan\/|storageKey|@example\.test/)

        const response = await file(actors[key], orderX, pdfChallanId)
        expect(response.status).toBe(200)
        expect(Buffer.from(await response.arrayBuffer()).toString("latin1")).toContain("%PDF-1.7")
      },
    )

    it.each(["branchAdminA2", "colleague", "orderPortalA2", "headOfficeB"])("hides it from %s, who cannot read the order", async (key) => {
      expect((await list(actors[key], orderX)).status).toBe(404)
      expect((await file(actors[key], orderX, pdfChallanId)).status).toBe(404)
    })

    it.each(["viewer", "orderDesk"])("refuses %s outright", async (key) => {
      expect((await list(actors[key], orderX)).status).toBe(403)
      expect((await file(actors[key], orderX, pdfChallanId)).status).toBe(403)
    })

    it("never serves a challan through another order's id", async () => {
      expect((await file(actors.superAdmin, orderZ, pdfChallanId)).status).toBe(404)
      expect((await file(actors.superAdmin, orderX, 2_000_000_000)).status).toBe(404)
      expect((await file(actors.superAdmin, orderX, Number.NaN)).status).toBe(404)
    })

    it("serves a PDF as a private, unsniffed, sandboxed download", async () => {
      const response = await file(actors.headOffice, orderX, pdfChallanId)
      expect(response.headers.get("Content-Type")).toBe("application/pdf")
      expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="DC 77\.pdf"/)
      expect(response.headers.get("Cache-Control")).toContain("no-store")
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
      expect(response.headers.get("Content-Security-Policy")).toContain("sandbox")
    })
  })

  describe("replacing", () => {
    it("is Super Admin's alone", async () => {
      expect((await replace(null, orderX, { deliveryChallanId: pdfChallanId })).status).toBe(401)
      for (const key of ["headOffice", "branchAdminA1", "raiser"]) {
        expect((await replace(actors[key], orderX, { deliveryChallanId: pdfChallanId })).status, key).toBe(403)
      }
    })

    it("refuses an order that has not been delivered", async () => {
      const upcoming = await upload(actors.superAdmin, { orderId: orderZ, file: pngFile() })
      expect((await replace(actors.superAdmin, orderZ, { deliveryChallanId: upcoming.body.deliveryChallan.id })).status).toBe(409)
    })

    it("refuses a malformed body", async () => {
      expect((await replace(actors.superAdmin, orderX, { deliveryChallanId: "1" })).status).toBe(400)
      expect((await replace(actors.superAdmin, orderX, { deliveryChallanId: 1, extra: true })).status).toBe(400)
    })

    it("swaps in a new challan and keeps the old one for Super Admin only", async () => {
      const fresh = await upload(actors.superAdmin, { orderId: orderX, file: pngFile("retake.png") })
      expect(fresh.status).toBe(201)
      replacementId = fresh.body.deliveryChallan.id
      const { status } = await replace(actors.superAdmin, orderX, { deliveryChallanId: replacementId })
      expect(status).toBe(200)

      const forAdmin = await list(actors.superAdmin, orderX)
      expect(forAdmin.body.items.map((item: { id: number; current: boolean }) => [item.id, item.current]))
        .toEqual(expect.arrayContaining([[pdfChallanId, false], [replacementId, true]]))

      const forHeadOffice = await list(actors.headOffice, orderX)
      expect(forHeadOffice.body.items).toEqual([expect.objectContaining({ id: replacementId, current: true })])

      expect((await file(actors.headOffice, orderX, pdfChallanId)).status).toBe(404)
      expect((await file(actors.superAdmin, orderX, pdfChallanId)).status).toBe(200)

      const image = await file(actors.raiser, orderX, replacementId)
      expect(image.status).toBe(200)
      expect(image.headers.get("Content-Type")).toBe("image/png")
      expect(image.headers.get("Content-Disposition")).toMatch(/^inline; filename="retake\.png"/)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "REPLACE_DELIVERY_CHALLAN"), eq(auditLogs.entityId, String(orderX))))
      expect(audit?.userId).toBe(actors.superAdmin.id)
    })
  })

  describe("the database", () => {
    it("allows only one current challan per order", async () => {
      await expect(db.insert(orderDeliveryChallans).values({
        orderId: orderX, organizationId: orgA, branchId: branchA1,
        storageKey: `delivery-challan/${randomUUID()}.png`, fileName: "x.png", contentType: "image/png", sizeBytes: 10,
        uploadedByUserId: actors.superAdmin.id, attachedAt: new Date(),
      })).rejects.toThrow()
    })

    it("refuses a key, type or size outside the rules", async () => {
      const base = {
        orderId: orderZ, organizationId: orgB, branchId: branchB1, fileName: "x", sizeBytes: 10, uploadedByUserId: actors.superAdmin.id,
      }
      await expect(db.insert(orderDeliveryChallans).values({ ...base, storageKey: "products/../x.pdf", contentType: "application/pdf" })).rejects.toThrow()
      await expect(db.insert(orderDeliveryChallans).values({ ...base, storageKey: `delivery-challan/${randomUUID()}.html`, contentType: "text/html" })).rejects.toThrow()
      await expect(db.insert(orderDeliveryChallans).values({
        ...base, storageKey: `delivery-challan/${randomUUID()}.pdf`, contentType: "application/pdf", sizeBytes: 4_194_305,
      })).rejects.toThrow()
    })
  })
})

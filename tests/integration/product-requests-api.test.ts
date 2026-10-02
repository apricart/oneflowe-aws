import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import sharp from "sharp"

import * as requestRoute from "@/app/api/v1/product-requests/[id]/route"
import * as requestsRoute from "@/app/api/v1/product-requests/route"
import * as uploadRoute from "@/app/api/v1/upload/image/route"
import { auditLogs, productRequests } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { PRODUCT_REQUEST_PAGE_SIZE_MAX } from "@/lib/product-request"
import { putImage } from "@/lib/server/image-storage"

import {
  createProductRequestFixtures,
  destroyProductRequestFixtures,
  hasTestDatabase,
  type ProductRequestFixtures,
} from "./helpers/product-request-fixtures"

/**
 * New-product requests, end to end: the three handlers driven with HTTP-shaped
 * requests against real rows, plus the image upload route Head Office now
 * shares.
 *
 * Only identity, rate limiting and the S3 write are faked. The role rule, the
 * tenant read from the user row, the SQL visibility predicate, the category
 * checks, the row-locked review, the check constraints and the audit rows all
 * run for real.
 *
 * The blocks build on each other in file order: the create block raises the
 * requests the visibility and review blocks read.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limiter itself is unit-tested elsewhere.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
// Key generation and path validation stay real; only the S3 write is replaced.
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return { ...actual, putImage: vi.fn(async () => undefined) }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  })
}

/** JSON where the route sent it; the raw text otherwise. */
function parseBody(text: string): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function read(response: Response): Promise<{ status: number; body: any; headers: Headers }> {
  const text = await response.text()
  return { status: response.status, body: parseBody(text), headers: response.headers }
}

const list = (params: Record<string, string | number> = {}) => {
  const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
  const suffix = search.toString()
  return requestsRoute.GET(new NextRequest(`http://localhost/api/v1/product-requests${suffix ? `?${suffix}` : ""}`)).then(read)
}
const create = (body: unknown) =>
  requestsRoute.POST(jsonRequest("/api/v1/product-requests", "POST", body)).then(read)
const review = (id: string | number, body: unknown) =>
  requestRoute
    .PATCH(jsonRequest(`/api/v1/product-requests/${id}`, "PATCH", body), { params: Promise.resolve({ id: String(id) }) })
    .then(read)

async function upload(file: File) {
  const form = new FormData()
  form.append("image", file)
  return uploadRoute.POST(new NextRequest("http://localhost/api/v1/upload/image", { method: "POST", body: form })).then(read)
}

async function requestRow(id: number) {
  const [row] = await db.select().from(productRequests).where(eq(productRequests.id, id)).limit(1)
  return row
}

async function requestCount(organizationIds: number[]) {
  const rows = await db
    .select({ id: productRequests.id })
    .from(productRequests)
    .where(inArray(productRequests.organizationId, organizationIds))
  return rows.length
}

async function auditFor(requestId: number, action: string) {
  return db
    .select({ userId: auditLogs.userId, organizationId: auditLogs.organizationId, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.entity, "product_request"), eq(auditLogs.entityId, String(requestId)), eq(auditLogs.action, action)))
}

const STORED_IMAGE = "/api/v1/images/products/0b6f3c52-8f6e-4d1a-9a57-3c2b1d4e5f60.png"

describe.skipIf(!hasTestDatabase)("Product requests — routes against a real database", () => {
  let f: ProductRequestFixtures
  let apricart: Actor
  let headOffice: Actor
  let secondHeadOffice: Actor
  let neighbourHeadOffice: Actor
  let strayHeadOffice: Actor
  let refusedRoles: Array<[string, Actor]>
  let pngBytes: Buffer

  // Requests raised by the create block and read by the later ones.
  let fullRequestId: number
  let neighbourRequestId: number

  beforeAll(async () => {
    f = await createProductRequestFixtures()
    apricart = { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null }
    headOffice = { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId, branchId: null }
    secondHeadOffice = { id: f.secondHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.organizationId, branchId: null }
    neighbourHeadOffice = { id: f.neighbourHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.neighbourOrganizationId, branchId: null }
    strayHeadOffice = { id: f.strayHeadOfficeId, role: "HEAD_OFFICE", organizationId: null, branchId: null }
    refusedRoles = [
      ["BRANCH_ADMIN", { id: f.branchAdminId, role: "BRANCH_ADMIN", organizationId: f.organizationId, branchId: f.branchId }],
      ["ORDER_PORTAL", { id: f.orderPortalId, role: "ORDER_PORTAL", organizationId: f.organizationId, branchId: f.branchId }],
      ["GROUP_USER", { id: f.groupUserId, role: "GROUP_USER", organizationId: f.organizationId, branchId: null }],
      ["GROUP_ORDER_PORTAL", { id: f.groupOrderPortalId, role: "GROUP_ORDER_PORTAL", organizationId: f.organizationId, branchId: null }],
      ["VIEWER", { id: f.viewerId, role: "VIEWER", organizationId: f.organizationId, branchId: null }],
    ]
    pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00aa00" } }).png().toBuffer()
  })

  afterAll(async () => {
    if (f) await destroyProductRequestFixtures(f)
    await closePool()
  })

  describe("authentication", () => {
    it("refuses every handler without a session", async () => {
      signIn(null)
      expect((await list()).status).toBe(401)
      expect((await create({ productName: "Soap" })).status).toBe(401)
      expect((await review(1, { status: "APPROVED" })).status).toBe(401)
      expect((await upload(new File([new Uint8Array(pngBytes)], "p.png", { type: "image/png" }))).status).toBe(401)
    })
  })

  describe("role gates", () => {
    it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL", "VIEWER"])(
      "refuses %s on every handler, and writes nothing",
      async (roleName) => {
        const actor = refusedRoles.find(([name]) => name === roleName)![1]
        signIn(actor)
        const before = await requestCount([f.organizationId])

        expect((await list()).status).toBe(403)
        expect((await create({ productName: "Soap" })).status).toBe(403)
        expect((await review(1, { status: "APPROVED" })).status).toBe(403)
        expect(await requestCount([f.organizationId])).toBe(before)
      },
    )

    it("does not let Super Admin raise a request — it adds products directly", async () => {
      signIn(apricart)
      expect((await create({ productName: "Soap" })).status).toBe(403)
    })

    it("does not let Head Office decide a request", async () => {
      signIn(headOffice)
      expect((await review(1, { status: "APPROVED" })).status).toBe(403)
    })

    it("refuses a Head Office user with no organization rather than widening it", async () => {
      signIn(strayHeadOffice)
      const listed = await list()
      expect(listed.status).toBe(403)
      expect(listed.body.error).toBe("Organization context required")
      expect((await create({ productName: "Soap" })).status).toBe(403)
    })
  })

  describe("raising a request", () => {
    it("records a full request against the raiser's own tenant, with an audit row", async () => {
      signIn(headOffice)
      const response = await create({
        productName: "Hand sanitiser",
        brand: "Dettol",
        description: "Alcohol based gel",
        categoryId: f.cleaningCategoryId,
        subcategoryId: f.handCareSubcategoryId,
        unit: "bottle",
        packSize: "500 ml, carton of 12",
        barcode: "8961014001234",
        expectedPriceCents: 45_000,
        estimatedMonthlyQuantity: 120,
        preferredSupplier: "Reckitt",
        referenceUrl: "https://example.com/sanitiser",
        notes: "Every branch asks for this",
        imageUrl: STORED_IMAGE,
      })

      expect(response.status).toBe(201)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      fullRequestId = response.body.id

      const row = await requestRow(fullRequestId)
      expect(row).toMatchObject({
        organizationId: f.organizationId,
        requestedByUserId: f.headOfficeId,
        status: "PENDING",
        productName: "Hand sanitiser",
        categoryId: f.cleaningCategoryId,
        subcategoryId: f.handCareSubcategoryId,
        expectedPriceCents: 45_000,
        estimatedMonthlyQuantity: 120,
        referenceUrl: "https://example.com/sanitiser",
        imageUrl: STORED_IMAGE,
        reviewedByUserId: null,
        reviewedAt: null,
      })

      const audit = await auditFor(fullRequestId, "CREATE_PRODUCT_REQUEST")
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ userId: f.headOfficeId, organizationId: f.organizationId })
    })

    it("accepts a request carrying a single field", async () => {
      signIn(secondHeadOffice)
      const response = await create({ notes: "A cheaper photocopy paper, please" })
      expect(response.status).toBe(201)
      expect(await requestRow(response.body.id)).toMatchObject({
        organizationId: f.organizationId,
        requestedByUserId: f.secondHeadOfficeId,
        productName: null,
        notes: "A cheaper photocopy paper, please",
      })
    })

    it("takes the tenant from the user row, not from what the session claims", async () => {
      // A session whose organization claim names the neighbour must still file
      // the request under the organization the user row actually belongs to.
      signIn({ ...headOffice, organizationId: f.neighbourOrganizationId })
      const response = await create({ productName: "Stapler" })
      expect(response.status).toBe(201)
      expect((await requestRow(response.body.id)).organizationId).toBe(f.organizationId)
    })

    it("fills in the category from a subcategory given alone", async () => {
      signIn(headOffice)
      const response = await create({ productName: "A4 ream", subcategoryId: f.paperSubcategoryId })
      expect(response.status).toBe(201)
      expect(await requestRow(response.body.id)).toMatchObject({
        categoryId: f.stationeryCategoryId,
        subcategoryId: f.paperSubcategoryId,
      })
    })

    it("lets the neighbour's Head Office raise its own", async () => {
      signIn(neighbourHeadOffice)
      const response = await create({ productName: "Neighbour's floor cleaner" })
      expect(response.status).toBe(201)
      neighbourRequestId = response.body.id
      expect((await requestRow(neighbourRequestId)).organizationId).toBe(f.neighbourOrganizationId)
    })

    describe("refuses, and writes nothing for,", () => {
      const cases: Array<[string, () => unknown, string | RegExp]> = [
        ["an empty object", () => ({}), "Fill in at least one field — the product name is the most useful"],
        ["only blank strings", () => ({ productName: "  ", notes: "" }), "Fill in at least one field — the product name is the most useful"],
        ["malformed JSON", () => "{not json", "Request body must be a JSON object"],
        ["an array", () => [{ productName: "Soap" }], "Request body must be a JSON object"],
        ["an organizationId", () => ({ productName: "Soap", organizationId: 1 }), "Unknown field: organizationId"],
        ["a status", () => ({ productName: "Soap", status: "APPROVED" }), "Unknown field: status"],
        ["a requester", () => ({ productName: "Soap", requestedByUserId: "x" }), "Unknown field: requestedByUserId"],
        ["a price in rupees rather than cents", () => ({ productName: "Soap", expectedPriceCents: 12.5 }), "Expected price must be a whole number of cents"],
        ["a javascript: reference link", () => ({ productName: "Soap", referenceUrl: "javascript:alert(1)" }), "Reference link must be a full http:// or https:// address"],
        ["a data: image", () => ({ productName: "Soap", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }), /Image storage is not available/],
        ["an external image", () => ({ productName: "Soap", imageUrl: "https://evil.example/pixel.png" }), /must be uploaded through the form/],
        ["a traversal image path", () => ({ productName: "Soap", imageUrl: "/api/v1/images/products/../support/x.png" }), /must be uploaded through the form/],
        ["an unknown category", () => ({ productName: "Soap", categoryId: 2_000_000_000 }), "The selected category does not exist"],
        ["a subcategory named as a category", () => ({ productName: "Soap", categoryId: f.handCareSubcategoryId }), "The selected category does not exist"],
        ["a category named as a subcategory", () => ({ productName: "Soap", subcategoryId: f.cleaningCategoryId }), "The selected subcategory does not exist"],
        [
          "a subcategory under a different category",
          () => ({ productName: "Soap", categoryId: f.cleaningCategoryId, subcategoryId: f.paperSubcategoryId }),
          "The selected subcategory does not belong to the selected category",
        ],
      ]

      it.each(cases)("%s", async (_label, body, message) => {
        signIn(headOffice)
        const before = await requestCount([f.organizationId])
        const response = await create(body())
        expect(response.status).toBe(400)
        if (typeof message === "string") expect(response.body.error).toBe(message)
        else expect(response.body.error).toMatch(message)
        expect(await requestCount([f.organizationId])).toBe(before)
      })
    })
  })

  describe("who sees which requests", () => {
    it("shows Head Office every request in its organization, with who raised each", async () => {
      signIn(secondHeadOffice)
      const response = await list()
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")

      const ids = response.body.items.map((item: any) => item.id)
      expect(ids).toContain(fullRequestId)
      expect(ids).not.toContain(neighbourRequestId)
      expect(response.body.items.every((item: any) => item.organization.id === f.organizationId)).toBe(true)
      // The Super Admin organization filter is not offered to Head Office.
      expect(response.body.organizations).toEqual([])

      const full = response.body.items.find((item: any) => item.id === fullRequestId)
      expect(full).toMatchObject({
        productName: "Hand sanitiser",
        category: { id: f.cleaningCategoryId },
        subcategory: { id: f.handCareSubcategoryId },
        requestedBy: {
          id: f.headOfficeId,
          fullName: `Head Office A1 ${f.suffix}`,
          email: `it-product-request-ho-a1-${f.suffix}@example.test`,
          role: "HEAD_OFFICE",
        },
        organization: { id: f.organizationId, name: f.organizationName },
      })
    })

    it("never shows one tenant's requests to another's Head Office", async () => {
      signIn(neighbourHeadOffice)
      const response = await list()
      expect(response.status).toBe(200)
      expect(response.body.items.map((item: any) => item.id)).toEqual([neighbourRequestId])
      expect(response.body.total).toBe(1)
    })

    it("ignores an organization filter from Head Office instead of honouring it", async () => {
      signIn(neighbourHeadOffice)
      const response = await list({ organizationId: f.organizationId })
      expect(response.status).toBe(200)
      expect(response.body.items.map((item: any) => item.id)).toEqual([neighbourRequestId])
    })

    it("shows Super Admin every tenant's requests and lets it narrow to one", async () => {
      signIn(apricart)
      const everything = await list({ pageSize: PRODUCT_REQUEST_PAGE_SIZE_MAX })
      expect(everything.status).toBe(200)
      const organizationIds = everything.body.organizations.map((organization: any) => organization.id)
      expect(organizationIds).toEqual(expect.arrayContaining([f.organizationId, f.neighbourOrganizationId]))

      const narrowed = await list({ organizationId: f.organizationId })
      const narrowedIds = narrowed.body.items.map((item: any) => item.id)
      expect(narrowedIds).toContain(fullRequestId)
      expect(narrowedIds).not.toContain(neighbourRequestId)
      expect(narrowed.body.counts.PENDING).toBe(narrowed.body.total)

      const neighbour = await list({ organizationId: f.neighbourOrganizationId })
      expect(neighbour.body.items.map((item: any) => item.id)).toEqual([neighbourRequestId])
    })

    it("filters by status and caps the page size", async () => {
      signIn(apricart)
      const approved = await list({ organizationId: f.organizationId, status: "APPROVED" })
      expect(approved.body.items).toEqual([])

      const capped = await list({ pageSize: 10_000 })
      expect(capped.status).toBe(200)
      expect(capped.body.pageSize).toBe(PRODUCT_REQUEST_PAGE_SIZE_MAX)
    })

    it.each([
      ["an unknown status", { status: "DONE" }],
      ["a malformed organization", { organizationId: "abc" }],
      ["a negative page", { page: -1 }],
    ])("refuses %s in the query", async (_label, params) => {
      signIn(apricart)
      expect((await list(params)).status).toBe(400)
    })
  })

  describe("deciding a request", () => {
    it("records Super Admin's approval, its note, who and when, with an audit row", async () => {
      signIn(apricart)
      const response = await review(fullRequestId, { status: "APPROVED", reviewNote: " Added as KE-9001 " })
      expect(response.status).toBe(200)
      expect(response.body).toEqual({ id: fullRequestId, status: "APPROVED" })

      const row = await requestRow(fullRequestId)
      expect(row.status).toBe("APPROVED")
      expect(row.reviewNote).toBe("Added as KE-9001")
      expect(row.reviewedByUserId).toBe(f.superAdminId)
      expect(row.reviewedAt).toBeInstanceOf(Date)

      const audit = await auditFor(fullRequestId, "REVIEW_PRODUCT_REQUEST")
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ userId: f.superAdminId, organizationId: f.organizationId })
    })

    it("shows Head Office the outcome and the note", async () => {
      signIn(headOffice)
      const response = await list({ status: "APPROVED" })
      const decided = response.body.items.find((item: any) => item.id === fullRequestId)
      expect(decided).toMatchObject({
        status: "APPROVED",
        reviewNote: "Added as KE-9001",
        reviewedBy: { id: f.superAdminId, fullName: `Apricart ${f.suffix}` },
      })
      expect(response.body.counts.APPROVED).toBeGreaterThanOrEqual(1)
    })

    it("refuses a second decision on the same request", async () => {
      signIn(apricart)
      const response = await review(fullRequestId, { status: "REJECTED" })
      expect(response.status).toBe(409)
      expect(response.body.error).toBe("This request has already been approved")
      expect((await requestRow(fullRequestId)).status).toBe("APPROVED")
    })

    it("lets exactly one of two simultaneous decisions through", async () => {
      signIn(headOffice)
      const raised = await create({ productName: "Race condition soap" })
      expect(raised.status).toBe(201)

      signIn(apricart)
      const outcomes = await Promise.all([
        review(raised.body.id, { status: "APPROVED" }),
        review(raised.body.id, { status: "REJECTED" }),
      ])
      expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 409])
      expect(await auditFor(raised.body.id, "REVIEW_PRODUCT_REQUEST")).toHaveLength(1)
    })

    it("rejects another tenant's request too — Super Admin decides across tenants", async () => {
      signIn(apricart)
      const response = await review(neighbourRequestId, { status: "REJECTED", reviewNote: "Already stocked as Floor Clean" })
      expect(response.status).toBe(200)
      expect(await requestRow(neighbourRequestId)).toMatchObject({ status: "REJECTED", reviewNote: "Already stocked as Floor Clean" })
    })

    it.each([
      ["an unknown id", 2_000_000_000, { status: "APPROVED" }, 404],
      ["a non-numeric id", "abc", { status: "APPROVED" }, 404],
      ["a zero id", 0, { status: "APPROVED" }, 404],
      ["a move back to pending", 1, { status: "PENDING" }, 400],
      ["an unknown field", 1, { status: "APPROVED", reviewedByUserId: "x" }, 400],
      ["no body", 1, undefined, 400],
    ])("answers %s", async (_label, id, body, status) => {
      signIn(apricart)
      expect((await review(id, body)).status).toBe(status)
    })
  })

  describe("what the table itself holds", () => {
    it("refuses a data: URL written past the route", async () => {
      await expect(
        db.insert(productRequests).values({
          organizationId: f.organizationId,
          requestedByUserId: f.headOfficeId,
          imageUrl: "data:image/png;base64,AAAA",
        }),
      ).rejects.toThrow()
    })

    it("refuses a decision with no reviewer", async () => {
      await expect(
        db.insert(productRequests).values({
          organizationId: f.organizationId,
          requestedByUserId: f.headOfficeId,
          status: "APPROVED",
        }),
      ).rejects.toThrow()
    })

    it("refuses a status outside the three", async () => {
      await expect(
        db.insert(productRequests).values({
          organizationId: f.organizationId,
          requestedByUserId: f.headOfficeId,
          status: "DONE",
        }),
      ).rejects.toThrow()
    })

    it("refuses a negative expected price", async () => {
      await expect(
        db.insert(productRequests).values({
          organizationId: f.organizationId,
          requestedByUserId: f.headOfficeId,
          expectedPriceCents: -1,
        }),
      ).rejects.toThrow()
    })
  })

  describe("the image upload Head Office now shares", () => {
    const pngFile = () => new File([new Uint8Array(pngBytes)], "sanitiser.png", { type: "image/png" })

    afterEach(() => {
      delete process.env.S3_UPLOADS_BUCKET
      delete process.env.S3_UPLOADS_REGION
    })

    it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL", "VIEWER"])(
      "still refuses %s",
      async (roleName) => {
        signIn(refusedRoles.find(([name]) => name === roleName)![1])
        expect((await upload(pngFile())).status).toBe(403)
      },
    )

    it("stores Head Office's picture and the request accepts the path it returns", async () => {
      process.env.S3_UPLOADS_BUCKET = "it-product-requests"
      process.env.S3_UPLOADS_REGION = "ap-south-1"
      vi.mocked(putImage).mockClear()

      signIn(headOffice)
      const uploaded = await upload(pngFile())
      expect(uploaded.status).toBe(200)
      expect(uploaded.body.url).toMatch(/^\/api\/v1\/images\/products\/[0-9a-f-]{36}\.png$/)
      expect(vi.mocked(putImage)).toHaveBeenCalledTimes(1)

      const raised = await create({ productName: "Pictured soap", imageUrl: uploaded.body.url })
      expect(raised.status).toBe(201)
      expect((await requestRow(raised.body.id)).imageUrl).toBe(uploaded.body.url)
    })

    it("refuses to file the local-development data: URL on a request", async () => {
      // No bucket configured: the upload route answers with an inline data URL,
      // which must never reach a column.
      signIn(headOffice)
      const uploaded = await upload(pngFile())
      expect(uploaded.status).toBe(200)
      expect(uploaded.body.url.startsWith("data:")).toBe(true)

      const raised = await create({ productName: "Unpictured soap", imageUrl: uploaded.body.url })
      expect(raised.status).toBe(400)
      expect(raised.body.error).toMatch(/Image storage is not available/)
    })

    it("still admits Super Admin", async () => {
      signIn(apricart)
      expect((await upload(pngFile())).status).toBe(200)
    })
  })
})

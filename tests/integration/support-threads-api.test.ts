import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import sharp from "sharp"

import * as attachmentRoute from "@/app/api/v1/support/attachments/[id]/route"
import * as attachmentsRoute from "@/app/api/v1/support/attachments/route"
import * as filtersRoute from "@/app/api/v1/support/filters/route"
import * as productsRoute from "@/app/api/v1/support/products/route"
import * as statsRoute from "@/app/api/v1/support/stats/route"
import * as messagesRoute from "@/app/api/v1/support/threads/[id]/messages/route"
import * as threadRoute from "@/app/api/v1/support/threads/[id]/route"
import * as threadsRoute from "@/app/api/v1/support/threads/route"
import { branches, emailOutbox, groups, notifications, supportAttachments, supportThreads } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import {
  buildSupportAttachmentKey,
  getImage,
  isValidSupportAttachmentKey,
  putImage,
} from "@/lib/server/image-storage"
import { ATTACHMENT_CLAIM_WINDOW_MS } from "@/lib/server/support-threads"
import { SUPPORT_ORDER_SEARCH_MAX_LENGTH, supportThreadReference } from "@/lib/support-thread"

import {
  createSupportFixtures,
  destroySupportFixtures,
  hasTestDatabase,
  type SupportFixtures,
} from "./helpers/support-fixtures"

/**
 * The support feature, end to end: the seven routes driven with HTTP-shaped
 * requests against real rows.
 *
 * Only identity, rate limiting, the S3 client and outbound mail are faked. The
 * visibility rule as SQL, the order and product reference checks, the
 * row-locked status transitions, the attachment claim window, the read-marker
 * upserts and the notification rows all run for real — those are the parts the
 * unit tests cannot reach and the parts that decide what one tenant sees of
 * another.
 *
 * The blocks build on each other in file order. The visibility block runs
 * first, while the only threads in these two tenants are the seven seeded in
 * `beforeAll`, so its lists can be asserted exactly; later blocks raise their
 * own threads and never rely on an exact count.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
// Rate limiting needs Redis; the limit itself is unit-tested elsewhere.
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
// Queueing is real (it writes rows); delivery would contact a mail provider.
vi.mock("@/lib/server/order-notifications", () => ({
  attemptImmediateEmailDelivery: vi.fn(async () => undefined),
}))
// Key generation, validation and the configured check stay real; only the two
// calls that would reach S3 are replaced.
vi.mock("@/lib/server/image-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/image-storage")>()
  return { ...actual, putImage: vi.fn(async () => undefined), getImage: vi.fn() }
})

const { getServerSession } = mockedNextAuth

type Actor = { id: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor === null ? null : ({ user: actor } as any))
}

type Json = Record<string, unknown>

function jsonRequest(path: string, method: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function query(path: string, params: Record<string, string | number | undefined>): NextRequest {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value))
  }
  const suffix = search.toString()
  return new NextRequest(`http://localhost${path}${suffix ? `?${suffix}` : ""}`)
}

const params = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) })

/** JSON where the route sent it; the raw text otherwise (a streamed image, an empty body). */
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

const listThreads = (filters: Record<string, string | number | undefined> = {}) =>
  threadsRoute.GET(query("/api/v1/support/threads", filters)).then(read)
const createThread = (body: unknown) =>
  threadsRoute.POST(jsonRequest("/api/v1/support/threads", "POST", body)).then(read)
const getThread = (id: string | number) =>
  threadRoute.GET(jsonRequest(`/api/v1/support/threads/${id}`, "GET"), params(id)).then(read)
const patchThread = (id: string | number, body: unknown) =>
  threadRoute.PATCH(jsonRequest(`/api/v1/support/threads/${id}`, "PATCH", body), params(id)).then(read)
const postMessage = (id: string | number, body: unknown) =>
  messagesRoute.POST(jsonRequest(`/api/v1/support/threads/${id}/messages`, "POST", body), params(id)).then(read)
const getStats = () => statsRoute.GET().then(read)
const getFilterOptions = () => filtersRoute.GET().then(read)
const searchProducts = (q?: string) =>
  productsRoute.GET(query("/api/v1/support/products", { q })).then(read)
const readAttachment = (id: string | number) =>
  attachmentRoute.GET(jsonRequest(`/api/v1/support/attachments/${id}`, "GET"), params(id)).then(read)

async function uploadAttachment(file: File | null, threadId?: number | string) {
  const form = new FormData()
  if (file) form.append("file", file)
  if (threadId !== undefined) form.append("threadId", String(threadId))
  const request = new NextRequest("http://localhost/api/v1/support/attachments", { method: "POST", body: form })
  return attachmentsRoute.POST(request).then(read)
}

/** A well-formed query with nothing optional, under the one category that needs no product. */
const plainQuery = (subject: string, message = "Something has gone wrong.") => ({
  subject,
  category: "OTHER",
  message,
})

const ids = (body: any): number[] => body.items.map((item: any) => item.id)
const sorted = (values: number[]) => [...values].sort((a, b) => a - b)

async function threadRow(id: number) {
  const [row] = await db.select().from(supportThreads).where(eq(supportThreads.id, id)).limit(1)
  return row
}

async function notificationsFor(threadId: number, userId: string) {
  return db
    .select({ type: notifications.type, eventKey: notifications.eventKey })
    .from(notifications)
    .where(and(eq(notifications.supportThreadId, threadId), eq(notifications.userId, userId)))
}

async function outboxFor(threadId: number, userId: string) {
  return db
    .select({ template: emailOutbox.template, status: emailOutbox.status })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.supportThreadId, threadId), eq(emailOutbox.recipientUserId, userId)))
}

async function insertUnclaimedAttachment(input: {
  uploaderId: string
  organizationId: number
  createdAt?: Date
}): Promise<number> {
  const [row] = await db
    .insert(supportAttachments)
    .values({
      threadId: null,
      messageId: null,
      organizationId: input.organizationId,
      uploadedByUserId: input.uploaderId,
      storageKey: buildSupportAttachmentKey("png"),
      fileName: "shot.png",
      contentType: "image/png",
      sizeBytes: 1234,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning({ id: supportAttachments.id })
  return row.id
}

async function attachmentRow(id: number) {
  const [row] = await db
    .select({ threadId: supportAttachments.threadId, messageId: supportAttachments.messageId })
    .from(supportAttachments)
    .where(eq(supportAttachments.id, id))
    .limit(1)
  return row
}

/** A `BlobPart` from a Buffer — the DOM typing refuses Node's Buffer, which may be backed by a SharedArrayBuffer. */
const blobPart = (bytes: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(bytes)

describe.skipIf(!hasTestDatabase)("Support threads — routes against a real database", () => {
  let f: SupportFixtures
  let apricart: Actor
  let headOfficeA: Actor
  let headOfficeB: Actor
  let branchAdminNorth: Actor
  let branchAdminSouth: Actor
  let ahmed: Actor
  let bilal: Actor
  let sana: Actor
  let groupRequester: Actor
  let foreignUser: Actor
  /** A signed-in person whose role is not a party to a support conversation. */
  let outsider: Actor

  /** The seven threads the visibility block reads. */
  const seeded = {} as Record<"ahmed" | "sana" | "bilal" | "group" | "baNorth" | "foreign" | "ho", number>

  async function raise(actor: Actor, subject: string, extra: Json = {}): Promise<number> {
    signIn(actor)
    const { status, body } = await createThread({ ...plainQuery(subject), ...extra })
    expect(status, `${actor.role} raising "${subject}": ${JSON.stringify(body)}`).toBe(201)
    return body.id
  }

  beforeAll(async () => {
    f = await createSupportFixtures()
    const A = f.organizationId
    const B = f.neighbourOrganizationId
    apricart = { id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null, branchId: null }
    headOfficeA = { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: A, branchId: null }
    headOfficeB = { id: f.neighbourHeadOfficeId, role: "HEAD_OFFICE", organizationId: B, branchId: null }
    branchAdminNorth = { id: f.branchAdminNorthId, role: "BRANCH_ADMIN", organizationId: A, branchId: f.northBranchId }
    branchAdminSouth = { id: f.branchAdminSouthId, role: "BRANCH_ADMIN", organizationId: A, branchId: f.southBranchId }
    ahmed = { id: f.ahmedId, role: "ORDER_PORTAL", organizationId: A, branchId: f.northBranchId }
    bilal = { id: f.bilalId, role: "ORDER_PORTAL", organizationId: A, branchId: f.northBranchId }
    sana = { id: f.sanaId, role: "ORDER_PORTAL", organizationId: A, branchId: f.southBranchId }
    groupRequester = { id: f.groupRequesterId, role: "GROUP_ORDER_PORTAL", organizationId: A, branchId: null }
    foreignUser = { id: f.foreignUserId, role: "ORDER_PORTAL", organizationId: B, branchId: f.foreignBranchId }
    outsider = { ...headOfficeA, role: "AUDITOR" }

    // Storage is "configured" for the attachment routes; the client is mocked.
    process.env.S3_UPLOADS_BUCKET = "integration-test-bucket"
    process.env.AWS_REGION = "ap-southeast-1"

    seeded.ahmed = await raise(ahmed, "Ahmed's invoice is wrong")
    seeded.sana = await raise(sana, "Sana's delivery is late")
    seeded.bilal = await raise(bilal, "Bilal's order is short")
    seeded.group = await raise(groupRequester, "Group requester's query")
    seeded.baNorth = await raise(branchAdminNorth, "North branch admin's query")
    seeded.foreign = await raise(foreignUser, "Foreign tenant's query")
    seeded.ho = await raise(headOfficeA, "Head Office A's query")
  })

  beforeEach(() => {
    vi.clearAllMocks()
    signIn(headOfficeA)
  })

  afterAll(async () => {
    if (f) await destroySupportFixtures(f)
    await closePool()
  })

  // ── Access control ─────────────────────────────────────────────────────

  describe("every route is a closed door", () => {
    const routes = [
      ["GET threads", () => listThreads()],
      ["POST threads", () => createThread(plainQuery("x"))],
      ["GET thread", () => getThread(seeded.ahmed)],
      ["PATCH thread", () => patchThread(seeded.ahmed, { status: "RESOLVED" })],
      ["POST message", () => postMessage(seeded.ahmed, { message: "hello" })],
      ["GET stats", () => getStats()],
      ["GET filters", () => getFilterOptions()],
      ["GET products", () => searchProducts()],
      ["GET attachment", () => readAttachment(1)],
    ] as const

    it.each(routes)("%s refuses a caller with no session", async (_name, run) => {
      signIn(null)
      expect((await run()).status).toBe(401)
    })

    it.each(routes)("%s refuses a role that is not a party to a support conversation", async (_name, run) => {
      signIn(outsider)
      expect((await run()).status).toBe(403)
    })

    it("refuses an upload from nobody and from a non-participant", async () => {
      signIn(null)
      expect((await uploadAttachment(null)).status).toBe(401)
      expect((await uploadAttachment(null, seeded.ahmed)).status).toBe(401)
      signIn(outsider)
      expect((await uploadAttachment(null)).status).toBe(403)
      expect((await uploadAttachment(null, seeded.ahmed)).status).toBe(403)
    })

    it("lets Apricart answer but never raise — it has no tenant to raise against", async () => {
      signIn(apricart)
      expect((await createThread(plainQuery("Apricart raising"))).status).toBe(403)
      expect((await listThreads()).status).toBe(200)
    })
  })

  // ── Visibility ─────────────────────────────────────────────────────────

  describe("the visibility table, as SQL", () => {
    const A = () => [seeded.ahmed, seeded.sana, seeded.bilal, seeded.group, seeded.baNorth, seeded.ho]

    it("gives Apricart every tenant, and lets it narrow to one", async () => {
      signIn(apricart)
      const all = await listThreads({ pageSize: 50 })
      expect(all.status).toBe(200)
      for (const id of [...A(), seeded.foreign]) expect(ids(all.body)).toContain(id)

      const tenantA = await listThreads({ organizationId: f.organizationId })
      expect(sorted(ids(tenantA.body))).toEqual(sorted(A()))
      expect(tenantA.body.total).toBe(6)

      const tenantB = await listThreads({ organizationId: f.neighbourOrganizationId })
      expect(ids(tenantB.body)).toEqual([seeded.foreign])
    })

    it("gives Head Office its whole organization and nothing of the neighbour's", async () => {
      signIn(headOfficeA)
      const { body } = await listThreads()
      expect(sorted(ids(body))).toEqual(sorted(A()))
      expect(body.total).toBe(6)

      signIn(headOfficeB)
      const neighbour = await listThreads()
      expect(ids(neighbour.body)).toEqual([seeded.foreign])
    })

    it("ignores an organizationId a Head Office sends for another tenant", async () => {
      signIn(headOfficeA)
      const { body } = await listThreads({ organizationId: f.neighbourOrganizationId })
      expect(sorted(ids(body))).toEqual(sorted(A()))
    })

    it("gives a branch administrator its branch plus its own, not the head office's or a group requester's", async () => {
      signIn(branchAdminNorth)
      const north = await listThreads()
      expect(sorted(ids(north.body))).toEqual(sorted([seeded.ahmed, seeded.bilal, seeded.baNorth]))

      signIn(branchAdminSouth)
      const south = await listThreads()
      expect(ids(south.body)).toEqual([seeded.sana])
    })

    it("confines every requester role to what it raised — colleagues on the same branch included", async () => {
      for (const [actor, expected] of [
        [ahmed, seeded.ahmed],
        [bilal, seeded.bilal],
        [sana, seeded.sana],
        [groupRequester, seeded.group],
        [foreignUser, seeded.foreign],
      ] as const) {
        signIn(actor)
        const { body } = await listThreads()
        expect(ids(body), actor.role).toEqual([expected])
        expect(body.total).toBe(1)
      }
    })

    it("answers 404, never 403, for a thread outside the caller's scope", async () => {
      const denied: Array<[Actor, number, string]> = [
        [ahmed, seeded.bilal, "a colleague on the same branch"],
        [ahmed, seeded.sana, "a colleague on another branch"],
        [ahmed, seeded.foreign, "another tenant"],
        [branchAdminNorth, seeded.sana, "another branch"],
        [branchAdminNorth, seeded.group, "a group requester with no branch"],
        [branchAdminNorth, seeded.ho, "the head office"],
        [headOfficeB, seeded.ahmed, "another tenant, as head office"],
        [groupRequester, seeded.ahmed, "a branch it covers — the group roles are not widened"],
      ]
      for (const [actor, threadId, why] of denied) {
        signIn(actor)
        expect((await getThread(threadId)).status, why).toBe(404)
      }
    })

    it("opens a thread for everyone the table says may read it", async () => {
      const allowed: Array<[Actor, number]> = [
        [ahmed, seeded.ahmed],
        [branchAdminNorth, seeded.ahmed],
        [branchAdminNorth, seeded.bilal],
        [headOfficeA, seeded.group],
        [headOfficeA, seeded.ho],
        [apricart, seeded.foreign],
        [foreignUser, seeded.foreign],
      ]
      for (const [actor, threadId] of allowed) {
        signIn(actor)
        const { status, body } = await getThread(threadId)
        expect(status, `${actor.role} on ${threadId}`).toBe(200)
        expect(body.thread.id).toBe(threadId)
        expect(body.thread.messages).toHaveLength(1)
        expect(body.viewer.userId).toBe(actor.id)
        expect(body.viewer.canManage).toBe(actor.role === "SUPER_ADMIN")
        expect(body.viewer.side).toBe(actor.role === "SUPER_ADMIN" ? "APRICART" : "CUSTOMER")
      }
    })

    it("answers 404 for an id that is not one, and for one that does not exist", async () => {
      signIn(apricart)
      expect((await getThread("abc")).status).toBe(404)
      expect((await getThread(0)).status).toBe(404)
      expect((await getThread(2_000_000_000)).status).toBe(404)
    })

    it("looks up a reference only inside the caller's scope", async () => {
      const reference = supportThreadReference(seeded.ahmed)
      signIn(headOfficeA)
      expect(ids((await listThreads({ reference })).body)).toEqual([seeded.ahmed])
      signIn(headOfficeB)
      expect(ids((await listThreads({ reference })).body)).toEqual([])
    })

    it("bounds the page size at the maximum rather than honouring what was asked", async () => {
      signIn(apricart)
      const { body } = await listThreads({ pageSize: 500 })
      expect(body.pageSize).toBe(50)
      const one = await listThreads({ organizationId: f.organizationId, pageSize: 1, page: 2 })
      expect(one.body.items).toHaveLength(1)
      expect(one.body.page).toBe(2)
      expect(one.body.total).toBe(6)
    })
  })

  // ── Stats and read tracking ────────────────────────────────────────────

  describe("the KPI row counts exactly the viewer's scope", () => {
    it("is private, never shared-cacheable", async () => {
      const { headers } = await getStats()
      expect(headers.get("cache-control")).toContain("private")
      expect(headers.get("cache-control")).toContain("no-store")
    })

    it("gives each role the same total its list has", async () => {
      const expected: Array<[Actor, number]> = [
        [headOfficeA, 6],
        [headOfficeB, 1],
        [branchAdminNorth, 3],
        [branchAdminSouth, 1],
        [ahmed, 1],
        [groupRequester, 1],
      ]
      for (const [actor, total] of expected) {
        signIn(actor)
        const { status, body } = await getStats()
        expect(status).toBe(200)
        expect(body.total, actor.role).toBe(total)
        expect(body.open, actor.role).toBe(total)
        expect(body.unanswered, actor.role).toBe(total)
        expect(body.avgFirstResponseMinutes, actor.role).toBeNull()
      }
    })

    it("counts a thread a colleague raises as unread until it is opened, and never the viewer's own", async () => {
      signIn(branchAdminNorth)
      const before = (await getStats()).body.unread
      expect((await listThreads()).body.unreadCount).toBe(before)

      const fromAhmed = await raise(ahmed, "Something new from Ahmed")
      signIn(branchAdminNorth)
      expect((await getStats()).body.unread).toBe(before + 1)
      const unread = await listThreads()
      expect(unread.body.unreadCount).toBe(before + 1)
      expect(unread.body.items.find((item: any) => item.id === fromAhmed).unread).toBe(true)

      await getThread(fromAhmed)

      expect((await getStats()).body.unread).toBe(before)
      const read = await listThreads()
      expect(read.body.unreadCount).toBe(before)
      expect(read.body.items.find((item: any) => item.id === fromAhmed).unread).toBe(false)

      // Raising one's own thread never leaves it unread for its author.
      const own = await raise(branchAdminNorth, "Raised by the administrator")
      expect((await getStats()).body.unread).toBe(before)
      expect((await listThreads()).body.items.find((item: any) => item.id === own).unread).toBe(false)
    })
  })

  // ── Raising ────────────────────────────────────────────────────────────

  describe("raising a query", () => {
    beforeEach(() => signIn(ahmed))

    it("records the thread, its first message, the author's read marker and Apricart's notification together", async () => {
      const { status, body } = await createThread({ ...plainQuery("Everything at once", "The first message."), priority: "HIGH" })
      expect(status).toBe(201)
      expect(body.reference).toBe(supportThreadReference(body.id))

      const row = await threadRow(body.id)
      expect(row.organizationId).toBe(f.organizationId)
      expect(row.branchId).toBe(f.northBranchId)
      expect(row.createdByUserId).toBe(f.ahmedId)
      expect(row.status).toBe("OPEN")
      expect(row.priority).toBe("HIGH")
      expect(row.messageCount).toBe(1)
      expect(row.lastMessageSide).toBe("CUSTOMER")
      expect(row.firstResponseAt).toBeNull()

      const detail = await getThread(body.id)
      expect(detail.body.thread.messages).toEqual([
        expect.objectContaining({ authorUserId: f.ahmedId, authorSide: "CUSTOMER", authorRole: "ORDER_PORTAL", body: "The first message.", attachments: [] }),
      ])
      expect(detail.body.thread.unread).toBe(false)

      // Apricart is told; the author is not told about their own message.
      expect(await notificationsFor(body.id, f.superAdminId)).toEqual([
        expect.objectContaining({ type: "SUPPORT_THREAD_OPENED" }),
      ])
      expect(await outboxFor(body.id, f.superAdminId)).toEqual([
        expect.objectContaining({ template: "SUPPORT_THREAD_OPENED", status: "PENDING" }),
      ])
      expect(await notificationsFor(body.id, f.ahmedId)).toEqual([])
    })

    it("refuses a malformed request with a field-level message and writes nothing", async () => {
      const before = (await listThreads()).body.total
      // The fragment is the schema's own message where it defines one; a bare
      // type or enum failure carries Zod's wording, so only the status is checked.
      const cases: Array<[Json, string | null]> = [
        [{ category: "OTHER", message: "no subject" }, null],
        [{ subject: " ", category: "OTHER", message: "blank subject" }, "subject is required"],
        [{ subject: "x", category: "OTHER", message: "   " }, "message is required"],
        [{ ...plainQuery("retired"), category: "BILLING" }, null],
        [{ subject: "x", category: "INVOICE", message: "no product named" }, "name the product"],
        [{ ...plainQuery("extra"), organizationId: f.neighbourOrganizationId }, "Unknown field: organizationId"],
        [{ ...plainQuery("role"), createdByUserId: f.superAdminId }, "Unknown field: createdByUserId"],
        [{ ...plainQuery("too many"), attachmentIds: [1, 2, 3, 4, 5, 6] }, "at most"],
        [{ ...plainQuery("dupes"), attachmentIds: [7, 7] }, "only be used once"],
      ]
      for (const [body, expectedFragment] of cases) {
        const { status, body: response } = await createThread(body)
        expect(status, JSON.stringify(body)).toBe(400)
        expect(typeof response.error).toBe("string")
        if (expectedFragment) {
          expect(String(response.error).toLowerCase()).toContain(expectedFragment.toLowerCase())
        }
      }
      expect((await createThread("not json")).status).toBe(400)
      expect((await listThreads()).body.total).toBe(before)
    })

    it("lets a query cite a product the tenant carries, named as the tenant names it", async () => {
      const { status, body } = await createThread({ subject: "About a product", category: "PRODUCT", message: "It arrived damaged.", productId: f.carriedProductId })
      expect(status).toBe(201)
      const detail = await getThread(body.id)
      expect(detail.body.thread.productId).toBe(f.carriedProductId)
      expect(detail.body.thread.productName).toBe(`Our Carried ${f.suffix}`)
      expect(detail.body.thread.productCode).toBe(`ITS-CARRIED-${f.suffix}`)
    })

    it("refuses a product the tenant does not carry, with one answer for every reason", async () => {
      for (const [productId, why] of [
        [f.foreignProductId, "another tenant's catalogue"],
        [f.withdrawnProductId, "withdrawn from this tenant"],
        [f.orphanProductId, "assigned to nobody"],
        [999_999_999, "does not exist"],
      ] as const) {
        const { status, body } = await createThread({ subject: "x", category: "PRODUCT", message: "y", productId })
        expect(status, why).toBe(400)
        expect(body.error).toBe("That product could not be found.")
      }
    })

    it("lets each role cite exactly the orders the rule allows", async () => {
      const allowed: Array<[Actor, number, string]> = [
        [ahmed, f.ahmedOrderId, "own order"],
        [branchAdminNorth, f.ahmedOrderId, "an order on its branch"],
        [headOfficeA, f.sanaOrderId, "any order in its organization"],
        [groupRequester, f.ahmedOrderId, "an order on a branch it is assigned to"],
      ]
      for (const [actor, orderId, why] of allowed) {
        signIn(actor)
        const { status, body } = await createThread({ ...plainQuery(`cites ${why}`), orderId })
        expect(status, `${actor.role}: ${why}`).toBe(201)
        expect((await getThread(body.id)).body.thread.orderId).toBe(orderId)
      }

      const denied: Array<[Actor, number, string]> = [
        [ahmed, f.sanaOrderId, "a colleague's order on another branch"],
        [ahmed, f.foreignOrderId, "another tenant's order"],
        [bilal, f.ahmedOrderId, "a colleague's order on the same branch"],
        [branchAdminNorth, f.sanaOrderId, "an order on another branch"],
        [headOfficeA, f.foreignOrderId, "another tenant's order, as head office"],
        [groupRequester, f.sanaOrderId, "an order on a branch it is not assigned to"],
        [sana, 999_999_999, "an order that does not exist"],
      ]
      for (const [actor, orderId, why] of denied) {
        signIn(actor)
        const { status, body } = await createThread({ ...plainQuery("x"), orderId })
        expect(status, `${actor.role}: ${why}`).toBe(400)
        expect(body.error).toBe("That order could not be found.")
      }
    })

    it("searches by the cited order without letting the search widen a scope", async () => {
      signIn(headOfficeA)
      const { body } = await listThreads({ orderSearch: f.ahmedOrderTid.slice(-6) })
      expect(body.items.length).toBeGreaterThan(0)
      for (const item of body.items) expect(item.orderTid).toBe(f.ahmedOrderTid)

      // A bare number matches the internal id *and* any reference containing
      // those digits as text, so this finds everything the text search found,
      // and can legitimately find more when a random fixture reference happens
      // to contain the digits — never anything that cites no such order.
      const digits = String(f.ahmedOrderId)
      const byId = await listThreads({ orderSearch: digits })
      expect(ids(byId.body)).toEqual(expect.arrayContaining(ids(body)))
      for (const item of byId.body.items) {
        expect(item.orderId === f.ahmedOrderId || String(item.orderTid).includes(digits), item.orderTid).toBe(true)
      }

      signIn(headOfficeB)
      expect((await listThreads({ orderSearch: f.ahmedOrderTid })).body.items).toEqual([])
      expect((await listThreads({ orderSearch: digits })).body.items).toEqual([])

      signIn(headOfficeA)
      expect((await listThreads({ orderSearch: "%" })).body.items).toEqual([])
      expect((await listThreads({ orderSearch: "x".repeat(SUPPORT_ORDER_SEARCH_MAX_LENGTH + 1) })).status).toBe(400)
    })
  })

  // ── Attachments ────────────────────────────────────────────────────────

  describe("attachments", () => {
    let pngBytes: Buffer

    beforeAll(async () => {
      pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ff0000" } }).png().toBuffer()
    })

    beforeEach(() => signIn(ahmed))

    it("sanitises an upload through sharp and records it unclaimed under the uploader's tenant", async () => {
      const { status, body } = await uploadAttachment(new File([blobPart(pngBytes)], "..\\evil\\shot.png", { type: "image/png" }))
      expect(status, JSON.stringify(body)).toBe(201)
      expect(body.contentType).toBe("image/png")
      expect(body.fileName).toBe("shot.png")

      const [row] = await db.select().from(supportAttachments).where(eq(supportAttachments.id, body.id))
      expect(row.uploadedByUserId).toBe(f.ahmedId)
      expect(row.organizationId).toBe(f.organizationId)
      expect(row.threadId).toBeNull()
      expect(row.messageId).toBeNull()
      expect(isValidSupportAttachmentKey(row.storageKey)).toBe(true)
      expect(vi.mocked(putImage)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(putImage).mock.calls[0][0].key).toBe(row.storageKey)
    })

    it("refuses an upload for a new query from Apricart, which has no tenant to file it under", async () => {
      signIn(apricart)
      const { status, body } = await uploadAttachment(new File([blobPart(pngBytes)], "a.png", { type: "image/png" }))
      expect(status).toBe(403)
      expect(body.error).toBe("Forbidden")
      expect(vi.mocked(putImage)).not.toHaveBeenCalled()
    })

    it("files a reply's upload under the thread's tenant for everyone who may read the thread — Apricart included", async () => {
      const readers: Array<[Actor, number]> = [
        [apricart, seeded.foreign],
        [apricart, seeded.ahmed],
        [headOfficeA, seeded.sana],
        [branchAdminNorth, seeded.bilal],
        [ahmed, seeded.ahmed],
        [groupRequester, seeded.group],
        [foreignUser, seeded.foreign],
      ]
      for (const [actor, threadId] of readers) {
        signIn(actor)
        const { status, body } = await uploadAttachment(new File([blobPart(pngBytes)], "reply.png", { type: "image/png" }), threadId)
        expect(status, `${actor.role} uploading to ${threadId}: ${JSON.stringify(body)}`).toBe(201)

        const [row] = await db.select().from(supportAttachments).where(eq(supportAttachments.id, body.id))
        const thread = await threadRow(threadId)
        expect(row.uploadedByUserId).toBe(actor.id)
        expect(row.organizationId).toBe(thread.organizationId)
        expect(row.threadId).toBeNull()
        expect(row.messageId).toBeNull()
      }
    })

    it("answers 404 for a reply upload to a thread the caller cannot read, and stores nothing", async () => {
      const denied: Array<[Actor, number | string, string]> = [
        [ahmed, seeded.bilal, "a colleague's thread on the same branch"],
        [ahmed, seeded.sana, "another branch"],
        [ahmed, seeded.foreign, "another tenant"],
        [branchAdminNorth, seeded.sana, "another branch, as its administrator"],
        [headOfficeB, seeded.ahmed, "another tenant, as head office"],
        [groupRequester, seeded.ahmed, "a branch it covers but did not raise on"],
        [apricart, 2_000_000_000, "a thread that does not exist"],
        [apricart, "abc", "an id that is not one"],
        [apricart, 0, "a zero id"],
      ]
      for (const [actor, threadId, why] of denied) {
        signIn(actor)
        const { status, body } = await uploadAttachment(new File([blobPart(pngBytes)], "reply.png", { type: "image/png" }), threadId)
        expect(status, `${actor.role}: ${why}`).toBe(404)
        expect(body.error).toBe("Support request not found")
      }
      expect(vi.mocked(putImage)).not.toHaveBeenCalled()
    })

    it("lets Apricart attach a screenshot to its answer, which the raiser can then read", async () => {
      vi.mocked(getImage).mockImplementation(async () => ({
        body: { transformToWebStream: () => new Blob([blobPart(pngBytes)]).stream() } as any,
        contentType: "image/png",
        contentLength: pngBytes.length,
      }))

      signIn(apricart)
      const upload = await uploadAttachment(new File([blobPart(pngBytes)], "answer.png", { type: "image/png" }), seeded.sana)
      expect(upload.status).toBe(201)

      // Unclaimed, it is Apricart's alone — not even the thread's raiser sees it yet.
      signIn(sana)
      expect((await readAttachment(upload.body.id)).status).toBe(404)

      signIn(apricart)
      const reply = await postMessage(seeded.sana, { message: "See the attached.", attachmentIds: [upload.body.id] })
      expect(reply.status).toBe(201)
      expect(reply.body.status).toBe("AWAITING_CUSTOMER")

      const detail = await getThread(seeded.sana)
      const last = detail.body.thread.messages.at(-1)
      expect(last.authorSide).toBe("APRICART")
      expect(last.attachments).toEqual([expect.objectContaining({ id: upload.body.id, fileName: "answer.png" })])
      expect(await attachmentRow(upload.body.id)).toEqual({ threadId: seeded.sana, messageId: last.id })

      for (const actor of [sana, branchAdminSouth, headOfficeA, apricart]) {
        signIn(actor)
        expect((await readAttachment(upload.body.id)).status, `${actor.role} reading Apricart's screenshot`).toBe(200)
      }
      for (const actor of [ahmed, branchAdminNorth, headOfficeB, foreignUser]) {
        signIn(actor)
        expect((await readAttachment(upload.body.id)).status, `${actor.role} reading Apricart's screenshot`).toBe(404)
      }
    })

    it("refuses what is not an image, what lies about its type, and nothing at all", async () => {
      expect((await uploadAttachment(null)).status).toBe(400)

      const notImage = await uploadAttachment(new File([blobPart(Buffer.from("hello"))], "a.png", { type: "image/png" }))
      expect(notImage.status).toBe(400)

      const mismatch = await uploadAttachment(new File([blobPart(pngBytes)], "a.jpg", { type: "image/jpeg" }))
      expect(mismatch.status).toBe(400)
      expect(mismatch.body.error).toMatch(/does not match/)

      expect(vi.mocked(putImage)).not.toHaveBeenCalled()
    })

    it("treats an unconfigured bucket as an outage on both routes", async () => {
      const bucket = process.env.S3_UPLOADS_BUCKET
      delete process.env.S3_UPLOADS_BUCKET
      try {
        expect((await uploadAttachment(new File([blobPart(pngBytes)], "a.png", { type: "image/png" }))).status).toBe(503)
        expect((await readAttachment(1)).status).toBe(503)
      } finally {
        process.env.S3_UPLOADS_BUCKET = bucket
      }
    })

    it("claims only the author's own, unclaimed, recent uploads when a query is raised", async () => {
      const own = await insertUnclaimedAttachment({ uploaderId: f.ahmedId, organizationId: f.organizationId })
      const colleagues = await insertUnclaimedAttachment({ uploaderId: f.sanaId, organizationId: f.organizationId })
      const stale = await insertUnclaimedAttachment({
        uploaderId: f.ahmedId,
        organizationId: f.organizationId,
        createdAt: new Date(Date.now() - ATTACHMENT_CLAIM_WINDOW_MS - 60_000),
      })
      const foreign = await insertUnclaimedAttachment({ uploaderId: f.foreignUserId, organizationId: f.neighbourOrganizationId })

      const { status, body } = await createThread({ ...plainQuery("With screenshots"), attachmentIds: [own, colleagues, stale, foreign] })
      expect(status).toBe(201)

      const detail = await getThread(body.id)
      expect(detail.body.thread.messages[0].attachments).toEqual([
        expect.objectContaining({ id: own, fileName: "shot.png", contentType: "image/png", sizeBytes: 1234 }),
      ])
      expect(await attachmentRow(own)).toEqual({ threadId: body.id, messageId: detail.body.thread.messages[0].id })
      for (const untouched of [colleagues, stale, foreign]) {
        expect(await attachmentRow(untouched), String(untouched)).toEqual({ threadId: null, messageId: null })
      }

      // Once claimed, an id cannot be stapled to a second message.
      const reply = await postMessage(body.id, { message: "Again", attachmentIds: [own] })
      expect(reply.status).toBe(201)
      const after = await getThread(body.id)
      expect(after.body.thread.messages[1].attachments).toEqual([])
      expect(await attachmentRow(own)).toEqual({ threadId: body.id, messageId: detail.body.thread.messages[0].id })
    })

    it("serves an attachment through its thread's rule, and an unclaimed one only to its uploader", async () => {
      vi.mocked(getImage).mockImplementation(async () => ({
        body: { transformToWebStream: () => new Blob([blobPart(pngBytes)]).stream() } as any,
        contentType: "image/png",
        contentLength: pngBytes.length,
      }))

      const unclaimed = await insertUnclaimedAttachment({ uploaderId: f.ahmedId, organizationId: f.organizationId })
      signIn(ahmed)
      const mine = await readAttachment(unclaimed)
      expect(mine.status).toBe(200)
      expect(mine.headers.get("cache-control")).toBe("private, no-store, max-age=0")
      expect(mine.headers.get("content-disposition")).toBe('attachment; filename="shot.png"')
      expect(mine.headers.get("content-type")).toBe("image/png")
      expect(mine.headers.get("x-content-type-options")).toBe("nosniff")

      for (const actor of [bilal, branchAdminNorth, headOfficeA, apricart]) {
        signIn(actor)
        expect((await readAttachment(unclaimed)).status, `${actor.role} reading an unclaimed upload`).toBe(404)
      }

      // Claimed onto Ahmed's thread, it follows the thread.
      signIn(ahmed)
      expect((await postMessage(seeded.ahmed, { message: "Here is a picture", attachmentIds: [unclaimed] })).status).toBe(201)

      for (const actor of [ahmed, branchAdminNorth, headOfficeA, apricart]) {
        signIn(actor)
        expect((await readAttachment(unclaimed)).status, `${actor.role} reading a claimed attachment`).toBe(200)
      }
      for (const actor of [bilal, sana, branchAdminSouth, headOfficeB, foreignUser]) {
        signIn(actor)
        expect((await readAttachment(unclaimed)).status, `${actor.role} reading a claimed attachment`).toBe(404)
      }

      signIn(apricart)
      expect((await readAttachment("abc")).status).toBe(404)
      expect((await readAttachment(2_000_000_000)).status).toBe(404)
    })
  })

  // ── Replying ───────────────────────────────────────────────────────────

  describe("posting a reply", () => {
    let threadId: number

    beforeAll(async () => {
      threadId = await raise(sana, "A conversation")
    })

    it("only reaches readers of the thread, and answers 404 to everyone else", async () => {
      for (const actor of [ahmed, bilal, branchAdminNorth, groupRequester, headOfficeB, foreignUser]) {
        signIn(actor)
        expect((await postMessage(threadId, { message: "Let me in" })).status, actor.role).toBe(404)
      }
      signIn(apricart)
      expect((await postMessage(2_000_000_000, { message: "x" })).status).toBe(404)
    })

    it("refuses a malformed reply", async () => {
      signIn(sana)
      expect((await postMessage(threadId, { message: "" })).status).toBe(400)
      expect((await postMessage(threadId, { message: "x", threadId: 1 })).status).toBe(400)
      expect((await postMessage(threadId, { message: "x", attachmentIds: ["a"] })).status).toBe(400)
    })

    it("moves the thread with each side's message and records Apricart's first response once", async () => {
      signIn(sana)
      const own = await postMessage(threadId, { message: "Any news?" })
      expect(own.status).toBe(201)
      expect(own.body.status).toBe("OPEN")
      // A customer writing tells Apricart, never the customer.
      expect(await notificationsFor(threadId, f.sanaId)).toEqual([])
      const apricartTold = (await notificationsFor(threadId, f.superAdminId)).map((n) => n.type)
      expect(apricartTold).toEqual(["SUPPORT_THREAD_OPENED", "SUPPORT_MESSAGE_RECEIVED"])

      signIn(apricart)
      const answer = await postMessage(threadId, { message: "Looking into it." })
      expect(answer.status).toBe(201)
      expect(answer.body.status).toBe("AWAITING_CUSTOMER")
      const answered = await threadRow(threadId)
      expect(answered.firstResponseAt).not.toBeNull()
      expect(answered.messageCount).toBe(3)
      expect(answered.lastMessageSide).toBe("APRICART")
      // The raiser hears about Apricart's reply; Apricart is not told about its own.
      expect(await notificationsFor(threadId, f.sanaId)).toEqual([
        expect.objectContaining({ type: "SUPPORT_MESSAGE_RECEIVED" }),
      ])
      expect(await outboxFor(threadId, f.sanaId)).toEqual([
        expect.objectContaining({ template: "SUPPORT_MESSAGE_RECEIVED", status: "PENDING" }),
      ])
      expect((await notificationsFor(threadId, f.superAdminId)).map((n) => n.type)).toEqual(apricartTold)

      signIn(sana)
      const again = await postMessage(threadId, { message: "Thanks." })
      expect(again.body.status).toBe("OPEN")
      expect((await threadRow(threadId)).firstResponseAt).toEqual(answered.firstResponseAt)

      // A second Apricart reply does not move the first-response stamp.
      signIn(apricart)
      await postMessage(threadId, { message: "Fixed." })
      expect((await threadRow(threadId)).firstResponseAt).toEqual(answered.firstResponseAt)

      signIn(branchAdminSouth)
      const { body } = await getStats()
      expect(body.avgFirstResponseMinutes).not.toBeNull()
      expect(body.avgFirstResponseMinutes).toBeGreaterThanOrEqual(0)
    })

    it("tells the raiser when a colleague who may read the thread replies for them", async () => {
      signIn(branchAdminSouth)
      const reply = await postMessage(threadId, { message: "I'll chase this from the branch." })
      expect(reply.status).toBe(201)
      expect(reply.body.status).toBe("OPEN")
      const toSana = await notificationsFor(threadId, f.sanaId)
      expect(toSana.filter((n) => n.type === "SUPPORT_MESSAGE_RECEIVED").length).toBeGreaterThanOrEqual(2)
      expect(await notificationsFor(threadId, f.branchAdminSouthId)).toEqual([])
    })

    it("reopens a resolved thread and clears its settlement stamps", async () => {
      signIn(sana)
      expect((await patchThread(threadId, { status: "RESOLVED" })).status).toBe(200)
      const resolved = await threadRow(threadId)
      expect(resolved.resolvedAt).not.toBeNull()
      expect(resolved.resolvedByUserId).toBe(f.sanaId)

      signIn(apricart)
      const reply = await postMessage(threadId, { message: "One more thing." })
      expect(reply.body.status).toBe("AWAITING_CUSTOMER")
      const reopened = await threadRow(threadId)
      expect(reopened.resolvedAt).toBeNull()
      expect(reopened.resolvedByUserId).toBeNull()
    })

    it("refuses every reply to a closed thread, Apricart's included, with 409", async () => {
      signIn(apricart)
      expect((await patchThread(threadId, { status: "CLOSED" })).status).toBe(200)
      const countBefore = (await threadRow(threadId)).messageCount

      for (const actor of [sana, branchAdminSouth, headOfficeA, apricart]) {
        signIn(actor)
        const { status, body } = await postMessage(threadId, { message: "Still here" })
        expect(status, actor.role).toBe(409)
        expect(body.error).toMatch(/closed/i)
      }
      expect((await threadRow(threadId)).messageCount).toBe(countBefore)
    })
  })

  // ── Status changes and triage ──────────────────────────────────────────

  describe("changing a thread by hand", () => {
    let threadId: number

    beforeAll(async () => {
      threadId = await raise(bilal, "Needs triage")
    })

    it("refuses an empty change and an unknown field", async () => {
      signIn(bilal)
      expect((await patchThread(threadId, {})).status).toBe(400)
      expect((await patchThread(threadId, { subject: "renamed" })).status).toBe(400)
      expect((await patchThread(threadId, { status: "DONE" })).status).toBe(400)
    })

    it("answers 404 for a thread the caller cannot read, before arguing about status", async () => {
      for (const actor of [ahmed, sana, branchAdminSouth, headOfficeB, foreignUser]) {
        signIn(actor)
        expect((await patchThread(threadId, { status: "RESOLVED" })).status, actor.role).toBe(404)
      }
    })

    it("keeps triage with Apricart alone, even for a reader of the thread", async () => {
      for (const actor of [bilal, branchAdminNorth, headOfficeA]) {
        signIn(actor)
        expect((await patchThread(threadId, { priority: "URGENT" })).status, actor.role).toBe(403)
        expect((await patchThread(threadId, { assignedToUserId: f.superAdminId })).status, actor.role).toBe(403)
      }
      expect((await threadRow(threadId)).priority).toBe("NORMAL")
    })

    it("lets Apricart reprioritise and assign — but only to an Apricart administrator", async () => {
      signIn(apricart)
      expect((await patchThread(threadId, { priority: "URGENT", assignedToUserId: f.superAdminId })).status).toBe(200)
      let row = await threadRow(threadId)
      expect(row.priority).toBe("URGENT")
      expect(row.assignedToUserId).toBe(f.superAdminId)

      // A client user is not an assignee; the thread ends up unassigned rather
      // than assigned to somebody who cannot triage it.
      expect((await patchThread(threadId, { assignedToUserId: f.headOfficeId })).status).toBe(200)
      row = await threadRow(threadId)
      expect(row.assignedToUserId).toBeNull()

      signIn(branchAdminNorth)
      const { body } = await getStats()
      expect(body.urgent).toBeGreaterThanOrEqual(1)
    })

    it("walks the customer-side transitions: resolve, reopen, but never close", async () => {
      signIn(bilal)
      expect((await patchThread(threadId, { status: "CLOSED" })).status).toBe(409)
      expect((await patchThread(threadId, { status: "AWAITING_CUSTOMER" })).status).toBe(409)

      // Asking for the status it already has is a replay, not a violation.
      const replay = await patchThread(threadId, { status: "OPEN" })
      expect(replay.status).toBe(200)
      expect(replay.body.status).toBe("OPEN")

      // Once Apricart has answered, "open" is set by writing, not by hand.
      signIn(apricart)
      expect((await postMessage(threadId, { message: "Checking." })).body.status).toBe("AWAITING_CUSTOMER")
      signIn(bilal)
      const byHand = await patchThread(threadId, { status: "OPEN" })
      expect(byHand.status).toBe(409)
      expect(byHand.body.error).toMatch(/posting a message/)

      const resolve = await patchThread(threadId, { status: "RESOLVED" })
      expect(resolve.status).toBe(200)
      expect(resolve.body.status).toBe("RESOLVED")
      const resolved = await threadRow(threadId)
      expect(resolved.resolvedByUserId).toBe(f.bilalId)
      expect(await notificationsFor(threadId, f.superAdminId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "SUPPORT_THREAD_RESOLVED" }),
      ]))

      // A retried resolve changes nothing — same stamp, no second notification.
      const notified = (await notificationsFor(threadId, f.superAdminId)).length
      expect((await patchThread(threadId, { status: "RESOLVED" })).status).toBe(200)
      expect((await threadRow(threadId)).resolvedAt).toEqual(resolved.resolvedAt)
      expect(await notificationsFor(threadId, f.superAdminId)).toHaveLength(notified)

      const reopen = await patchThread(threadId, { status: "OPEN" })
      expect(reopen.status).toBe(200)
      expect(reopen.body.status).toBe("OPEN")
      const row = await threadRow(threadId)
      expect(row.resolvedAt).toBeNull()
      expect(row.resolvedByUserId).toBeNull()
    })

    it("lets a head office resolve a thread it did not raise", async () => {
      signIn(headOfficeA)
      expect((await patchThread(threadId, { status: "RESOLVED" })).status).toBe(200)
      expect((await threadRow(threadId)).resolvedByUserId).toBe(f.headOfficeId)
      signIn(bilal)
      expect((await patchThread(threadId, { status: "OPEN" })).status).toBe(200)
    })

    it("walks the Apricart-side transitions: close, and reopen what is closed", async () => {
      signIn(apricart)
      const close = await patchThread(threadId, { status: "CLOSED" })
      expect(close.status).toBe(200)
      let row = await threadRow(threadId)
      expect(row.closedAt).not.toBeNull()
      expect(row.closedByUserId).toBe(f.superAdminId)
      expect(row.resolvedAt).toBeNull()
      expect(await notificationsFor(threadId, f.bilalId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "SUPPORT_THREAD_CLOSED" }),
      ]))

      expect((await patchThread(threadId, { status: "RESOLVED" })).status).toBe(409)

      signIn(bilal)
      expect((await patchThread(threadId, { status: "OPEN" })).status).toBe(409)

      signIn(apricart)
      expect((await patchThread(threadId, { status: "OPEN" })).status).toBe(200)
      row = await threadRow(threadId)
      expect(row.status).toBe("OPEN")
      expect(row.closedAt).toBeNull()
      expect(row.closedByUserId).toBeNull()
    })

    it("filters the list by status and category within scope", async () => {
      signIn(apricart)
      expect((await patchThread(threadId, { status: "CLOSED" })).status).toBe(200)

      signIn(headOfficeA)
      const closed = await listThreads({ status: "CLOSED" })
      expect(ids(closed.body)).toContain(threadId)
      for (const item of closed.body.items) expect(item.status).toBe("CLOSED")

      const products = await listThreads({ category: "PRODUCT" })
      for (const item of products.body.items) expect(item.category).toBe("PRODUCT")
      expect(ids(products.body)).not.toContain(threadId)

      signIn(headOfficeB)
      expect(ids((await listThreads({ status: "CLOSED" })).body)).not.toContain(threadId)
    })
  })

  // ── Products ───────────────────────────────────────────────────────────

  describe("the product picker", () => {
    it("offers a requester only what its own organization carries, and no price", async () => {
      signIn(ahmed)
      const { status, body, headers } = await searchProducts()
      expect(status).toBe(200)
      expect(headers.get("cache-control")).toBe("private, no-store")
      const ours = body.items.filter((item: any) => item.productCode.endsWith(f.suffix))
      expect(ours).toEqual([
        { id: f.carriedProductId, productCode: `ITS-CARRIED-${f.suffix}`, name: `Our Carried ${f.suffix}` },
      ])
      for (const item of body.items) {
        expect(Object.keys(item).sort()).toEqual(["id", "name", "productCode"])
      }
    })

    it("searches the code and both names with the wildcards escaped", async () => {
      signIn(headOfficeA)
      expect(ids((await searchProducts(`carried-${f.suffix}`)).body)).toEqual([f.carriedProductId])
      expect(ids((await searchProducts(`Our Carried ${f.suffix}`)).body)).toEqual([f.carriedProductId])
      expect(ids((await searchProducts(`Foreign Product ${f.suffix}`)).body)).toEqual([])
      expect(ids((await searchProducts(`Withdrawn ${f.suffix}`)).body)).toEqual([])
      expect(ids((await searchProducts(`%${f.suffix}`)).body)).toEqual([])
    })

    it("gives the neighbour its own catalogue and Apricart nothing to pick from", async () => {
      signIn(headOfficeB)
      const theirs = (await searchProducts(f.suffix)).body.items.map((item: any) => item.id)
      expect(theirs).toEqual([f.foreignProductId])

      signIn(apricart)
      expect((await searchProducts()).body).toEqual({ items: [] })
    })
  })

  // ── The Apricart Support agent ─────────────────────────────────────────

  describe("the Apricart Support agent works the queue as Super Admin does", () => {
    // plans/OF-SUPPORT-apricart-support-role.md. No organization, no branch;
    // the Apricart side of every conversation.
    let agent: Actor
    let pngBytes: Buffer

    beforeAll(async () => {
      agent = { id: f.supportAgentId, role: "APRICART_SUPPORT", organizationId: null, branchId: null }
      pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00ff00" } }).png().toBuffer()
    })

    it("reads every tenant's queue, and narrows it to one", async () => {
      signIn(agent)
      const all = await listThreads({ pageSize: 50 })
      expect(all.status).toBe(200)
      for (const id of [seeded.ahmed, seeded.ho, seeded.foreign]) expect(ids(all.body)).toContain(id)

      const tenantB = await listThreads({ organizationId: f.neighbourOrganizationId, pageSize: 50 })
      expect(ids(tenantB.body)).toContain(seeded.foreign)
      expect(ids(tenantB.body)).not.toContain(seeded.ahmed)

      expect((await getStats()).status).toBe(200)
    })

    it("opens a thread in any tenant on the Apricart side, with triage rights", async () => {
      signIn(agent)
      const { status, body } = await getThread(seeded.foreign)
      expect(status).toBe(200)
      expect(body.viewer).toEqual(expect.objectContaining({ side: "APRICART", canManage: true, userId: f.supportAgentId }))
    })

    it("raises nothing — like Super Admin, it has no tenant to raise against", async () => {
      signIn(agent)
      expect((await createThread(plainQuery("Agent raising"))).status).toBe(403)
    })

    it("is mailed when a customer raises a query, and given no bell row it could never read", async () => {
      const threadId = await raise(sana, "Sana asks the agent")
      expect(await outboxFor(threadId, f.supportAgentId)).toEqual([
        expect.objectContaining({ template: "SUPPORT_THREAD_OPENED", status: "PENDING" }),
      ])
      expect(await notificationsFor(threadId, f.supportAgentId)).toEqual([])
      // Super Admin keeps both, exactly as before.
      expect(await notificationsFor(threadId, f.superAdminId)).toEqual([
        expect.objectContaining({ type: "SUPPORT_THREAD_OPENED" }),
      ])
    })

    it("answers as Apricart, with a screenshot, and the raiser is told", async () => {
      vi.mocked(getImage).mockImplementation(async () => ({
        body: { transformToWebStream: () => new Blob([blobPart(pngBytes)]).stream() } as any,
        contentType: "image/png",
        contentLength: pngBytes.length,
      }))
      const threadId = await raise(sana, "Sana needs an answer")

      signIn(agent)
      const upload = await uploadAttachment(new File([blobPart(pngBytes)], "agent.png", { type: "image/png" }), threadId)
      expect(upload.status, JSON.stringify(upload.body)).toBe(201)

      const reply = await postMessage(threadId, { message: "Looking into it.", attachmentIds: [upload.body.id] })
      expect(reply.status).toBe(201)
      expect(reply.body.status).toBe("AWAITING_CUSTOMER")
      expect((await threadRow(threadId)).firstResponseAt).not.toBeNull()

      const last = (await getThread(threadId)).body.thread.messages.at(-1)
      expect(last).toEqual(expect.objectContaining({
        authorUserId: f.supportAgentId,
        authorSide: "APRICART",
        authorRole: "APRICART_SUPPORT",
      }))
      expect(await notificationsFor(threadId, f.sanaId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "SUPPORT_MESSAGE_RECEIVED" }),
      ]))

      signIn(sana)
      expect((await readAttachment(upload.body.id)).status).toBe(200)
      signIn(foreignUser)
      expect((await readAttachment(upload.body.id)).status).toBe(404)
    })

    it("triages: reprioritises, takes the thread, closes and reopens it", async () => {
      const threadId = await raise(ahmed, "Ahmed's urgent query")

      signIn(agent)
      expect((await patchThread(threadId, { priority: "URGENT", assignedToUserId: f.supportAgentId })).status).toBe(200)
      let row = await threadRow(threadId)
      expect(row.priority).toBe("URGENT")
      expect(row.assignedToUserId).toBe(f.supportAgentId)

      expect((await patchThread(threadId, { status: "CLOSED" })).status).toBe(200)
      row = await threadRow(threadId)
      expect(row.closedByUserId).toBe(f.supportAgentId)
      expect(await notificationsFor(threadId, f.ahmedId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "SUPPORT_THREAD_CLOSED" }),
      ]))

      // Closed is closed for the customer; Apricart reopens it.
      signIn(ahmed)
      expect((await patchThread(threadId, { status: "OPEN" })).status).toBe(409)
      signIn(agent)
      expect((await patchThread(threadId, { status: "OPEN" })).status).toBe(200)
      expect((await threadRow(threadId)).closedAt).toBeNull()
    })

    it("may be assigned a thread by Super Admin, and an agent may hand one to Super Admin", async () => {
      const threadId = await raise(bilal, "Bilal's query for the agent")

      signIn(apricart)
      expect((await patchThread(threadId, { assignedToUserId: f.supportAgentId })).status).toBe(200)
      expect((await threadRow(threadId)).assignedToUserId).toBe(f.supportAgentId)

      signIn(agent)
      expect((await patchThread(threadId, { assignedToUserId: f.superAdminId })).status).toBe(200)
      expect((await threadRow(threadId)).assignedToUserId).toBe(f.superAdminId)

      // A client user is still not an assignee.
      expect((await patchThread(threadId, { assignedToUserId: f.headOfficeId })).status).toBe(200)
      expect((await threadRow(threadId)).assignedToUserId).toBeNull()
    })
  })

  // ── Narrowing by place ─────────────────────────────────────────────────

  describe("narrowing the queue by organization, branch and group", () => {
    let northGroupId: number
    /** A Head Office query, so raised at no branch, citing an order at South. */
    let headOfficeCitesSouth: number

    beforeAll(async () => {
      const [group] = await db
        .insert(groups)
        .values({ organizationId: f.organizationId, name: `Northern ${f.suffix}`, createdByUserId: f.headOfficeId })
        .returning({ id: groups.id })
      northGroupId = group.id
      await db.update(branches).set({ groupId: northGroupId }).where(eq(branches.id, f.northBranchId))
      headOfficeCitesSouth = await raise(headOfficeA, "Head Office asks about Sana's order", { orderId: f.sanaOrderId })
    })

    afterAll(async () => {
      await db.update(branches).set({ groupId: null }).where(eq(branches.id, f.northBranchId))
      if (northGroupId) await db.delete(groups).where(eq(groups.id, northGroupId))
    })

    const northThreads = () => [seeded.ahmed, seeded.bilal, seeded.baNorth]

    it("finds a branch's threads by where they were raised and by the order they cite", async () => {
      signIn(apricart)
      const north = ids((await listThreads({ branchId: f.northBranchId, pageSize: 50 })).body)
      for (const id of northThreads()) expect(north).toContain(id)
      for (const id of [seeded.sana, seeded.group, seeded.ho, seeded.foreign, headOfficeCitesSouth]) {
        expect(north).not.toContain(id)
      }

      const south = ids((await listThreads({ branchId: f.southBranchId, pageSize: 50 })).body)
      expect(south).toContain(seeded.sana)
      expect(south, "a branchless thread is found through the order it cites").toContain(headOfficeCitesSouth)
      expect(south).not.toContain(seeded.ahmed)
    })

    it("finds a group's threads through its branches", async () => {
      signIn(headOfficeA)
      const { status, body } = await listThreads({ groupId: northGroupId, pageSize: 50 })
      expect(status).toBe(200)
      for (const id of northThreads()) expect(ids(body)).toContain(id)
      for (const id of [seeded.sana, seeded.group, seeded.ho, headOfficeCitesSouth]) expect(ids(body)).not.toContain(id)
    })

    it("combines the filters, and ignores a malformed one rather than matching nothing", async () => {
      signIn(apricart)
      const both = await listThreads({ organizationId: f.organizationId, groupId: northGroupId, branchId: f.northBranchId, pageSize: 50 })
      expect(sorted(ids(both.body)).filter((id) => Object.values(seeded).includes(id))).toEqual(sorted(northThreads()))

      signIn(headOfficeA)
      const ignored = await listThreads({ branchId: "north", groupId: "-1" })
      expect(ignored.status).toBe(200)
      expect(ignored.body.total).toBe((await listThreads()).body.total)
    })

    it("never widens a caller past its own scope", async () => {
      // Another tenant's branch or group, or a branch outside the caller's own.
      const narrowed: Array<[Actor, Record<string, number>]> = [
        [headOfficeB, { branchId: f.northBranchId }],
        [headOfficeB, { groupId: northGroupId }],
        [headOfficeA, { branchId: f.foreignBranchId }],
        [branchAdminSouth, { branchId: f.northBranchId }],
        [ahmed, { branchId: f.southBranchId }],
      ]
      for (const [actor, filter] of narrowed) {
        signIn(actor)
        const { status, body } = await listThreads(filter)
        expect(status).toBe(200)
        expect(body.items, `${actor.role} ${JSON.stringify(filter)}`).toEqual([])
        expect(body.total).toBe(0)
      }
    })

    it("offers only the places the caller has a thread at, and tenants only to Apricart", async () => {
      signIn(apricart)
      const all = await getFilterOptions()
      expect(all.status).toBe(200)
      expect(all.headers.get("cache-control")).toContain("private")
      const orgIds = all.body.organizations.map((row: any) => row.id)
      expect(orgIds).toEqual(expect.arrayContaining([f.organizationId, f.neighbourOrganizationId]))
      const branchIds = all.body.branches.map((row: any) => row.id)
      expect(branchIds).toEqual(expect.arrayContaining([f.northBranchId, f.southBranchId, f.foreignBranchId]))
      expect(all.body.branches.find((row: any) => row.id === f.northBranchId)).toMatchObject({
        organizationId: f.organizationId,
        groupId: northGroupId,
      })
      expect(all.body.groups.map((row: any) => row.id)).toContain(northGroupId)

      signIn(headOfficeA)
      const tenantA = (await getFilterOptions()).body
      expect(tenantA.organizations).toEqual([])
      expect(sorted(tenantA.branches.map((row: any) => row.id))).toEqual(sorted([f.northBranchId, f.southBranchId]))
      expect(tenantA.groups.map((row: any) => row.id)).toEqual([northGroupId])

      signIn(headOfficeB)
      const tenantB = (await getFilterOptions()).body
      expect(tenantB.branches.map((row: any) => row.id)).toEqual([f.foreignBranchId])
      expect(tenantB.groups).toEqual([])

      // A requester reads only what it raised, so only its own branch is offered.
      signIn(sana)
      const own = (await getFilterOptions()).body
      expect(own.branches.map((row: any) => row.id)).toEqual([f.southBranchId])
      expect(own.groups).toEqual([])
    })
  })
})

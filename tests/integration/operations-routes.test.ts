import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as clearInventoryRoute from "@/app/api/v1/admin/clear-branch-inventory/route"
import * as refundDecisionRoute from "@/app/api/v1/admin/refunds/[id]/route"
import * as repairBudgetsRoute from "@/app/api/v1/admin/repair-budgets/route"
import * as branchExportRoute from "@/app/api/v1/branches/[id]/export/route"
import * as employeeCredentialsRoute from "@/app/api/v1/employee-credentials/route"
import * as inventoryImportRoute from "@/app/api/v1/inventory/import/route"
import * as autoFulfillRoute from "@/app/api/v1/orders/cron/auto-fulfill/route"
import * as processSchedulesRoute from "@/app/api/v1/reports/process-schedules/route"
import * as scheduleRoute from "@/app/api/v1/reports/schedule/route"
import {
  auditLogs,
  branches,
  employeeCredentials,
  orders,
  organizations,
  refunds,
  roles,
  scheduledReports,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The operational endpoints: scheduled reports, the two cron entry points,
 * employee credentials, refund-request cancellation, and the Super Admin
 * maintenance tools. Each is checked against its gate — a role allowlist or
 * the cron secret — and run through its main path once.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>()
  return { ...actual, sendReportEmail: vi.fn(async () => true), sendWelcomeEmail: vi.fn(async () => true) }
})
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    coalesceInFlight: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    invalidateByPrefix: vi.fn(async () => {}),
  }
})

const { getServerSession } = mockedNextAuth
const CRON = "integration-tests-cron-secret-value"

type Fixtures = Awaited<ReturnType<typeof createFixtures>>
type Actor = { id: string; role: string; organizationId: number | null; branchId?: number | null }

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "ops it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [org] = await db.insert(organizations).values({ name: `IT Ops ${suffix}`, code: `ITO-${suffix}` }).returning({ id: organizations.id })
  const [branch] = await db.insert(branches).values({ organizationId: org.id, name: `Ops Branch ${suffix}`, status: "active" }).returning({ id: branches.id })
  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null = null) => {
    const [row] = await db.insert(users).values({
      email: `it-ops-${label}-${suffix}@example.test`,
      username: `it-ops-${label}-${suffix}`,
      passwordHash: "x",
      roleId: await roleId(role),
      organizationId,
      branchId,
    }).returning({ id: users.id })
    return row.id
  }
  const superAdminId = await person("sa", "SUPER_ADMIN", null)
  const headOfficeId = await person("ho", "HEAD_OFFICE", org.id)
  const otherHeadOfficeId = await person("ho2", "HEAD_OFFICE", org.id)
  const branchAdminId = await person("ba", "BRANCH_ADMIN", org.id, branch.id)

  const [order] = await db.insert(orders).values({
    tid: `ITO-${suffix}`,
    organizationId: org.id,
    branchId: branch.id,
    createdByUserId: branchAdminId,
    status: "FULFILLED",
    fulfillmentStatus: "DELIVERED",
    subtotalCents: 1_000,
    taxCents: 0,
    totalCents: 1_000,
  }).returning({ id: orders.id })
  const [refund] = await db.insert(refunds).values({
    organizationId: org.id,
    orderId: order.id,
    amountCents: 500,
    reason: "test",
    status: "PENDING",
    requestedByUserId: branchAdminId,
  }).returning({ id: refunds.id })

  return { suffix, org: org.id, branch: branch.id, superAdminId, headOfficeId, otherHeadOfficeId, branchAdminId, orderId: order.id, refundId: refund.id }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const people = [f.superAdminId, f.headOfficeId, f.otherHeadOfficeId, f.branchAdminId]
  await db.delete(scheduledReports).where(inArray(scheduledReports.userId, people))
  await db.delete(employeeCredentials).where(eq(employeeCredentials.organizationId, f.org))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, people))
  await db.delete(auditLogs).where(eq(auditLogs.organizationId, f.org))
  await db.delete(systemLogs).where(inArray(systemLogs.userId, people))
  await db.delete(refunds).where(eq(refunds.organizationId, f.org))
  await db.delete(orders).where(eq(orders.organizationId, f.org))
  await db.delete(branches).where(eq(branches.organizationId, f.org))
  await db.delete(users).where(inArray(users.id, people))
  await db.delete(organizations).where(eq(organizations.id, f.org))
}

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

function req(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json(response: Response) {
  const text = await response.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    // CSV or other text bodies stay as text
  }
  return { status: response.status, body }
}

describe.skipIf(!hasTestDatabase)("operations routes", () => {
  let f: Fixtures
  const sa = (): Actor => ({ id: f.superAdminId, role: "SUPER_ADMIN", organizationId: null })
  const ho = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.org })
  const ho2 = (): Actor => ({ id: f.otherHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.org })
  const ba = (): Actor => ({ id: f.branchAdminId, role: "BRANCH_ADMIN", organizationId: f.org, branchId: f.branch })

  beforeAll(async () => {
    f = await createFixtures()
  })
  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  describe("scheduled reports", () => {
    it("creates, edits and deletes a schedule for its owner only", async () => {
      signIn(ho())
      const created = await json(await scheduleRoute.POST(req("/x", "POST", {
        reportName: "Sales", frequency: "weekly", format: "csv", emails: ["ops@example.test"],
      })))
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
      const [row] = await db.select().from(scheduledReports).where(eq(scheduledReports.userId, f.headOfficeId))
      expect(row.frequency).toBe("weekly")

      expect((await scheduleRoute.POST(req("/x", "POST", { reportName: "x", frequency: "hourly", format: "csv", emails: ["a@example.test"] }))).status).toBe(400)
      expect((await scheduleRoute.POST(req("/x", "POST", { reportName: "x", frequency: "daily", format: "csv", emails: [] }))).status).toBe(400)

      signIn(ho2())
      expect(JSON.stringify((await json(await scheduleRoute.GET(req("/x")))).body)).not.toContain("ops@example.test")
      expect((await scheduleRoute.POST(req("/x", "POST", { id: row.id, reportName: "Hijacked", frequency: "daily", format: "pdf", emails: ["evil@example.test"] }))).status).toBe(404)
      // Deleting someone else's schedule answers success (the delete is idempotent) and removes nothing.
      expect((await scheduleRoute.DELETE(req(`/x?id=${row.id}`, "DELETE"))).status).toBe(200)
      expect(await db.select().from(scheduledReports).where(eq(scheduledReports.id, row.id))).toHaveLength(1)

      signIn(ho())
      expect((await scheduleRoute.POST(req("/x", "POST", { id: row.id, reportName: "Sales v2", frequency: "monthly", format: "pdf", emails: ["ops@example.test"] }))).status).toBeLessThan(300)
      const [edited] = await db.select().from(scheduledReports).where(eq(scheduledReports.id, row.id))
      // The report name is the schedule's identity (it selects the data and the
      // modal finds its schedule by it), so an edit changes the delivery only.
      expect(edited.reportName).toBe("Sales")
      expect(edited.frequency).toBe("monthly")
      expect(edited.format).toBe("pdf")
      expect((await scheduleRoute.DELETE(req("/x", "DELETE"))).status).toBe(400)
      expect((await scheduleRoute.DELETE(req(`/x?id=${row.id}`, "DELETE"))).status).toBeLessThan(300)

      signIn({ id: f.branchAdminId, role: "ORDER_PORTAL", organizationId: f.org })
      expect((await scheduleRoute.GET(req("/x"))).status).toBe(403)
    })
  })

  describe("cron entry points", () => {
    it("refuse a request without the cron secret", async () => {
      signIn(null)
      expect((await autoFulfillRoute.POST(req("/x", "POST"))).status).toBe(401)
      expect((await autoFulfillRoute.POST(req("/x", "POST", undefined, { authorization: "Bearer wrong" }))).status).toBe(401)
      const processing = await processSchedulesRoute.POST(req("/x", "POST", {}, { authorization: "Bearer wrong" }))
      expect([401, 403]).toContain(processing.status)
    })

    it("run with the cron secret", async () => {
      const fulfilled = await json(await autoFulfillRoute.POST(req("/x", "POST", undefined, { authorization: `Bearer ${CRON}` })))
      expect(fulfilled.status, JSON.stringify(fulfilled.body)).toBe(200)
      const processed = await json(await processSchedulesRoute.POST(req("/x", "POST", {}, { authorization: `Bearer ${CRON}` })))
      expect(processed.status, JSON.stringify(processed.body)).toBeLessThan(500)
    })
  })

  describe("employee credentials", () => {
    it("are created by a Branch Admin for its own branch and listed back without the password", async () => {
      signIn(ho())
      expect((await employeeCredentialsRoute.GET(req("/x"))).status).toBe(403)

      signIn(ba())
      const created = await json(await employeeCredentialsRoute.POST(req("/x", "POST", {
        email: `emp-${f.suffix}@example.test`, password: "Employee-Pass-2026!", firstName: "Emp", lastName: "One",
      })))
      expect(created.status, JSON.stringify(created.body)).toBeLessThan(300)
      const [row] = await db.select().from(employeeCredentials).where(eq(employeeCredentials.organizationId, f.org))
      expect(row.branchId).toBe(f.branch)
      expect(row.passwordHash).not.toContain("Employee-Pass-2026!")

      const listed = await json(await employeeCredentialsRoute.GET(req("/x")))
      expect(JSON.stringify(listed.body)).toContain(`emp-${f.suffix}@example.test`)
      expect(JSON.stringify(listed.body)).not.toContain("passwordHash")

      expect((await employeeCredentialsRoute.POST(req("/x", "POST", { email: "bad", password: "x" }))).status).toBe(400)
    })
  })

  describe("refund request cancellation", () => {
    it("is Super Admin's, cancels a pending request once, and refuses a settled one", async () => {
      signIn(ho())
      expect((await refundDecisionRoute.PATCH(req("/x", "PATCH", { action: "cancel" }), { params: Promise.resolve({ id: String(f.refundId) }) })).status).toBe(403)

      signIn(sa())
      expect((await refundDecisionRoute.PATCH(req("/x", "PATCH", { action: "cancel" }), { params: Promise.resolve({ id: "abc" }) })).status).toBe(400)
      expect((await refundDecisionRoute.PATCH(req("/x", "PATCH", { action: "cancel" }), { params: Promise.resolve({ id: "2147483000" }) })).status).toBe(404)
      const cancelled = await refundDecisionRoute.PATCH(req("/x", "PATCH", { action: "cancel" }), { params: Promise.resolve({ id: String(f.refundId) }) })
      expect(cancelled.status).toBe(200)
      const [row] = await db.select().from(refunds).where(eq(refunds.id, f.refundId))
      expect(row.status).not.toBe("PENDING")
      expect((await refundDecisionRoute.PATCH(req("/x", "PATCH", { action: "cancel" }), { params: Promise.resolve({ id: String(f.refundId) }) })).status).toBe(400)
    })
  })

  describe("Super Admin maintenance tools", () => {
    it("are refused to Head Office", async () => {
      signIn(ho())
      expect((await repairBudgetsRoute.POST(req("/x", "POST", { branchId: f.branch }))).status).toBe(403)
      expect((await clearInventoryRoute.POST(req("/x", "POST", { branchId: f.branch }))).status).toBe(403)
      expect((await clearInventoryRoute.GET(req(`/x?branchId=${f.branch}`))).status).toBe(403)
      expect((await branchExportRoute.GET(req("/x"), { params: Promise.resolve({ id: String(f.branch) }) })).status).toBe(403)
      // The import history lists the caller's own batches only: nothing here.
      expect((await json(await inventoryImportRoute.GET(req("/x")))).body).toEqual({ batches: [] })
    })

    it("repair budgets, export a branch and preview a clear for Super Admin", async () => {
      signIn(sa())
      expect((await repairBudgetsRoute.POST(req("/x", "POST", {}))).status).toBe(400)
      const repaired = await json(await repairBudgetsRoute.POST(req("/x", "POST", { branchId: f.branch })))
      expect(repaired.status, JSON.stringify(repaired.body)).toBeLessThan(500)

      const exported = await json(await branchExportRoute.GET(req("/x"), { params: Promise.resolve({ id: String(f.branch) }) }))
      expect(exported.status).toBeLessThan(500)

      const preview = await json(await clearInventoryRoute.GET(req(`/x?branchId=${f.branch}`)))
      expect(preview.status).toBeLessThan(500)
    })
  })
})

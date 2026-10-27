import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, eq, inArray, or } from "drizzle-orm"

import * as organizationsRoute from "@/app/api/v1/organizations/route"
import * as organizationRoute from "@/app/api/v1/organizations/[id]/route"
import * as alertsRoute from "@/app/api/v1/price-contracts/alerts/route"
import * as cronRoute from "@/app/api/v1/organizations/cron/price-contract-reminders/route"
import {
  apricartExecutiveAssignments,
  auditLogs,
  emailOutbox,
  notifications,
  organizationApprovalLevels,
  organizationSettings,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import {
  PRICE_CONTRACT_EXPIRING_TEMPLATE,
  PRICE_CONTRACT_VALIDITY_AUDIT_ACTION,
  karachiCalendarDay,
} from "@/lib/price-contract-validity"
import {
  deliverClaimedPriceContractEmail,
  queueDuePriceContractReminders,
} from "@/lib/server/price-contract-reminders"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Organization price contract validity, end to end, against Postgres
 * (plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
 *
 * Identity, the rate limiter, the cache, `after()` and SES are faked; every
 * route and every query is real.
 *
 * ```text
 * Expiring  valid until today + 3   active    executive A assigned
 * Expired   valid until today − 2   active
 * Later     valid until today + 30  active    executive A assigned
 * Dormant   valid until today + 3   inactive
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
// `after()` needs a request scope; the tests run its callbacks themselves.
const deferred: (() => Promise<void>)[] = []
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (callback: () => Promise<void>) => { deferred.push(callback) } }
})
vi.mock("@/lib/server/order-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/order-notifications")>()
  return { ...actual, attemptImmediateEmailDelivery: vi.fn(async () => undefined) }
})
const sendPriceContractReminderEmail = vi.fn(async () => "ses-message-1")
vi.mock("@/lib/email/price-contract", () => ({
  sendPriceContractReminderEmail: (...args: unknown[]) => sendPriceContractReminderEmail(...(args as [])),
}))

const { getServerSession } = mockedNextAuth

type Actor = { id: string; email: string; role: string; organizationId: number | null; branchId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(actor ? { user: { ...actor, mustChangePassword: false } } as any : null)
}

const json = (url: string, method: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(url, {
  method,
  headers: { "Content-Type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

async function read(response: Response) {
  return { status: response.status, body: await response.json() }
}

function dayFromToday(offset: number): string {
  const [year, month, date] = karachiCalendarDay(new Date()).split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10)
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by price contract integration tests" })
    .returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("organization price contract validity", () => {
  const suffix = randomUUID().slice(0, 8).toUpperCase()
  const organizationIds: number[] = []
  const actors: Record<string, Actor> = {}
  const org = { expiring: 0, expired: 0, later: 0, dormant: 0 }

  const outboxFor = async (organizationId: number) => db
    .select({ id: emailOutbox.id, recipientUserId: emailOutbox.recipientUserId, eventKey: emailOutbox.eventKey, status: emailOutbox.status })
    .from(emailOutbox)
    .where(and(eq(emailOutbox.organizationId, organizationId), eq(emailOutbox.template, PRICE_CONTRACT_EXPIRING_TEMPLATE)))

  const bellFor = async (organizationId: number) => db
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(and(eq(notifications.organizationId, organizationId), eq(notifications.type, PRICE_CONTRACT_EXPIRING_TEMPLATE)))

  // Claimed as the outbox runtime claims a row before handing it to a deliverer.
  const claimed = async (outboxId: number) => {
    const [row] = await db.update(emailOutbox)
      .set({ status: "PROCESSING", processingStartedAt: new Date(), attempts: 1 })
      .where(eq(emailOutbox.id, outboxId))
      .returning()
    return row
  }

  const statusOf = async (outboxId: number) => {
    const [row] = await db.select({ status: emailOutbox.status }).from(emailOutbox).where(eq(emailOutbox.id, outboxId))
    return row.status
  }

  beforeAll(async () => {
    const roleIds = {
      superAdmin: await resolveRoleId("SUPER_ADMIN"),
      headOffice: await resolveRoleId("HEAD_OFFICE"),
      executive: await resolveRoleId("APRICART_EXECUTIVE"),
    }

    const insertOrg = async (label: string, validUntil: string, status = "active") => {
      const [row] = await db.insert(organizations)
        .values({ name: `IT PC ${label} ${suffix}`, code: `ITPC_${label.toUpperCase()}_${suffix}`, status, priceContractValidUntil: validUntil })
        .returning({ id: organizations.id })
      organizationIds.push(row.id)
      return row.id
    }
    org.expiring = await insertOrg("Expiring", dayFromToday(3))
    org.expired = await insertOrg("Expired", dayFromToday(-2))
    org.later = await insertOrg("Later", dayFromToday(30))
    org.dormant = await insertOrg("Dormant", dayFromToday(3), "inactive")

    const person = async (label: string, role: string, roleId: number, organizationId: number | null) => {
      const email = `it-pc-${label}-${suffix.toLowerCase()}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-pc-${label}-${suffix.toLowerCase()}`, passwordHash: "x", roleId, organizationId, fullName: label,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId: null }
    }
    await person("sa", "SUPER_ADMIN", roleIds.superAdmin, null)
    // Left pending by the delivery tests, so the re-arm test owns a stale reminder
    // whatever other Super Admins the database happens to hold.
    await person("sa2", "SUPER_ADMIN", roleIds.superAdmin, null)
    await person("ho", "HEAD_OFFICE", roleIds.headOffice, org.expiring)
    await person("execA", "APRICART_EXECUTIVE", roleIds.executive, null)
    await person("execB", "APRICART_EXECUTIVE", roleIds.executive, null)

    await db.insert(apricartExecutiveAssignments).values([
      { userId: actors.execA.id, organizationId: org.expiring },
      { userId: actors.execA.id, organizationId: org.later },
    ])
  })

  afterAll(async () => {
    if (organizationIds.length === 0) return
    const actorIds = Object.values(actors).map((actor) => actor.id)
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, actorIds)))
    await db.delete(apricartExecutiveAssignments).where(inArray(apricartExecutiveAssignments.organizationId, organizationIds))
    await db.delete(users).where(inArray(users.id, actorIds))
    await db.delete(organizationApprovalLevels).where(inArray(organizationApprovalLevels.organizationId, organizationIds))
    await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(() => {
    vi.mocked(getServerSession).mockReset()
    sendPriceContractReminderEmail.mockClear()
    deferred.length = 0
  })

  describe("Create and Edit Company", () => {
    let createdId: number

    it("Super Admin creates an organization with a contract date, on the trail", async () => {
      signIn(actors.sa)
      const created = await read(await organizationsRoute.POST(json("http://localhost/api/v1/organizations", "POST", {
        name: `IT PC Created ${suffix}`, code: `ITPC_NEW_${suffix}`, priceContractValidUntil: "2027-06-30",
      })))
      expect(created.status).toBe(201)
      createdId = created.body.item.id
      organizationIds.push(createdId)
      expect(created.body.item.priceContractValidUntil).toBe("2027-06-30")

      const [audit] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.organizationId, createdId), eq(auditLogs.action, "CREATE_ORGANIZATION")))
      expect(audit.metadata).toMatchObject({ priceContractValidUntil: "2027-06-30" })
    })

    it("creates without one when the field is blank", async () => {
      signIn(actors.sa)
      const created = await read(await organizationsRoute.POST(json("http://localhost/api/v1/organizations", "POST", {
        name: `IT PC Blank ${suffix}`, code: `ITPC_BLANK_${suffix}`, priceContractValidUntil: "",
      })))
      expect(created.status).toBe(201)
      organizationIds.push(created.body.item.id)
      expect(created.body.item.priceContractValidUntil).toBeNull()
    })

    it.each([["2026-02-31"], ["31/12/2026"], ["1999-12-31"], ["2101-01-01"]])("refuses %s", async (day) => {
      signIn(actors.sa)
      const refused = await organizationRoute.PATCH(
        json(`http://localhost/api/v1/organizations/${createdId}`, "PATCH", { priceContractValidUntil: day }),
        params(createdId),
      )
      expect(refused.status).toBe(400)
    })

    it("lets only Super Admin change it", async () => {
      signIn(actors.ho)
      const refused = await organizationRoute.PATCH(
        json(`http://localhost/api/v1/organizations/${org.expiring}`, "PATCH", { priceContractValidUntil: "2030-01-01" }),
        params(org.expiring),
      )
      expect(refused.status).toBe(403)
      signIn(null)
      const anonymous = await organizationRoute.PATCH(
        json(`http://localhost/api/v1/organizations/${org.expiring}`, "PATCH", { priceContractValidUntil: "2030-01-01" }),
        params(org.expiring),
      )
      expect(anonymous.status).toBe(401)
      const [row] = await db.select({ validUntil: organizations.priceContractValidUntil }).from(organizations)
        .where(eq(organizations.id, org.expiring))
      expect(row.validUntil).toBe(dayFromToday(3))
    })

    it("audits a change with what it replaced, not a re-save, and clears on null", async () => {
      const patch = async (body: unknown) => {
        signIn(actors.sa)
        return read(await organizationRoute.PATCH(
          json(`http://localhost/api/v1/organizations/${createdId}`, "PATCH", body),
          params(createdId),
        ))
      }
      const audits = async () => db.select({ metadata: auditLogs.metadata }).from(auditLogs)
        .where(and(eq(auditLogs.organizationId, createdId), eq(auditLogs.action, PRICE_CONTRACT_VALIDITY_AUDIT_ACTION)))

      expect((await patch({ priceContractValidUntil: "2027-12-31" })).body.item.priceContractValidUntil).toBe("2027-12-31")
      expect(await audits()).toEqual([
        { metadata: { previousPriceContractValidUntil: "2027-06-30", priceContractValidUntil: "2027-12-31" } },
      ])

      await patch({ priceContractValidUntil: "2027-12-31" })
      expect(await audits()).toHaveLength(1)

      expect((await patch({ priceContractValidUntil: null })).body.item.priceContractValidUntil).toBeNull()
      expect(await audits()).toHaveLength(2)
    })

    it("shows the date to Super Admin and withholds it from Head Office", async () => {
      signIn(actors.sa)
      const asSuperAdmin = await read(await organizationRoute.GET(json(`http://localhost/api/v1/organizations/${org.expiring}`, "GET"), params(org.expiring)))
      expect(asSuperAdmin.body.item.priceContractValidUntil).toBe(dayFromToday(3))

      signIn(actors.ho)
      const asHeadOffice = await read(await organizationRoute.GET(json(`http://localhost/api/v1/organizations/${org.expiring}`, "GET"), params(org.expiring)))
      expect(asHeadOffice.status).toBe(200)
      expect(asHeadOffice.body.item).not.toHaveProperty("priceContractValidUntil")

      const list = await read(await organizationsRoute.GET())
      expect(list.body.items.map((item: { id: number }) => item.id)).toEqual([org.expiring])
      expect(list.body.items[0]).not.toHaveProperty("priceContractValidUntil")
    })
  })

  describe("the dashboard alert", () => {
    const ours = (items: { organizationId: number }[]) =>
      items.filter((item) => organizationIds.includes(item.organizationId))

    it("shows Super Admin every expiring and expired active contract, expired first", async () => {
      signIn(actors.sa)
      const response = await read(await alertsRoute.GET())
      expect(response.status).toBe(200)
      expect(response.body.reminderDays).toBe(7)
      expect(ours(response.body.items)).toEqual([
        { organizationId: org.expired, name: `IT PC Expired ${suffix}`, code: `ITPC_EXPIRED_${suffix}`, validUntil: dayFromToday(-2), daysLeft: -2, status: "expired" },
        { organizationId: org.expiring, name: `IT PC Expiring ${suffix}`, code: `ITPC_EXPIRING_${suffix}`, validUntil: dayFromToday(3), daysLeft: 3, status: "expiring" },
      ])
    })

    it("shows an executive only its assigned organizations", async () => {
      signIn(actors.execA)
      const assigned = await read(await alertsRoute.GET())
      expect(assigned.body.items.map((item: { organizationId: number }) => item.organizationId)).toEqual([org.expiring])

      signIn(actors.execB)
      const unassigned = await read(await alertsRoute.GET())
      expect(unassigned.status).toBe(200)
      expect(unassigned.body.items).toEqual([])
    })

    it("refuses every other role and an anonymous caller", async () => {
      signIn(actors.ho)
      expect((await alertsRoute.GET()).status).toBe(403)
      signIn(null)
      expect((await alertsRoute.GET()).status).toBe(401)
    })

    it("queues the due reminders after answering", async () => {
      signIn(actors.sa)
      await alertsRoute.GET()
      expect(deferred).toHaveLength(1)
      await deferred[0]()
      expect((await outboxFor(org.expiring)).length).toBeGreaterThan(0)
    })
  })

  describe("the reminder", () => {
    it("reminds every Super Admin and only the assigned executive, once, for contracts in their last week", async () => {
      await queueDuePriceContractReminders(db, new Date())

      const mail = await outboxFor(org.expiring)
      const mailed = mail.map((row) => row.recipientUserId)
      expect(mailed).toContain(actors.sa.id)
      expect(mailed).toContain(actors.execA.id)
      expect(mailed).not.toContain(actors.execB.id)
      expect(mailed).not.toContain(actors.ho.id)

      const bell = (await bellFor(org.expiring)).map((row) => row.userId)
      expect(bell).toContain(actors.sa.id)
      expect(bell).not.toContain(actors.execA.id)

      for (const quiet of [org.expired, org.later, org.dormant]) {
        expect(await outboxFor(quiet)).toEqual([])
        expect(await bellFor(quiet)).toEqual([])
      }

      const again = await queueDuePriceContractReminders(db, new Date())
      expect(again.eventKeys.filter((key) => key.includes(`:${org.expiring}:`))).toEqual([])
      expect(await outboxFor(org.expiring)).toHaveLength(mail.length)
    })

    it("sends a reminder that still applies", async () => {
      const [row] = (await outboxFor(org.expiring)).filter((entry) => entry.recipientUserId === actors.sa.id)
      expect(await deliverClaimedPriceContractEmail(await claimed(row.id))).toBe("sent")
      expect(sendPriceContractReminderEmail).toHaveBeenCalledWith(expect.objectContaining({ to: actors.sa.email, daysLeft: 3 }))
      expect(await statusOf(row.id)).toBe("SENT")
    })

    it("skips an executive no longer assigned", async () => {
      const [row] = (await outboxFor(org.expiring)).filter((entry) => entry.recipientUserId === actors.execA.id)
      await db.delete(apricartExecutiveAssignments).where(and(
        eq(apricartExecutiveAssignments.userId, actors.execA.id),
        eq(apricartExecutiveAssignments.organizationId, org.expiring),
      ))
      expect(await deliverClaimedPriceContractEmail(await claimed(row.id))).toBe("skipped")
      expect(await statusOf(row.id)).toBe("SKIPPED")
      expect(sendPriceContractReminderEmail).not.toHaveBeenCalled()
      await db.insert(apricartExecutiveAssignments).values({ userId: actors.execA.id, organizationId: org.expiring })
    })

    it("re-arms when the date changes, and skips the reminder for the old date", async () => {
      const before = await outboxFor(org.expiring)
      await db.update(organizations).set({ priceContractValidUntil: dayFromToday(5) }).where(eq(organizations.id, org.expiring))

      const stale = before.find((entry) => entry.recipientUserId === actors.sa2.id)!
      expect(stale.status).toBe("PENDING")
      expect(await deliverClaimedPriceContractEmail(await claimed(stale.id))).toBe("skipped")
      expect(await statusOf(stale.id)).toBe("SKIPPED")
      expect(sendPriceContractReminderEmail).not.toHaveBeenCalled()

      const queued = await queueDuePriceContractReminders(db, new Date())
      const fresh = queued.eventKeys.filter((key) => key.includes(`:${org.expiring}:${dayFromToday(5)}:`))
      expect(fresh.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("the daily sweep", () => {
    it("refuses a call without the cron secret", async () => {
      const response = await cronRoute.POST(json("http://localhost/api/v1/organizations/cron/price-contract-reminders", "POST", {}))
      expect(response.status).toBe(401)
    })

    it("previews the due organizations on a dry run", async () => {
      const response = await read(await cronRoute.POST(json(
        "http://localhost/api/v1/organizations/cron/price-contract-reminders",
        "POST",
        { dry_run: true },
        { authorization: "Bearer integration-tests-cron-secret-value" },
      )))
      expect(response.status).toBe(200)
      expect(response.body.organizationIds).toContain(org.expiring)
      expect(response.body.organizationIds).not.toContain(org.expired)
      expect(response.body.organizationIds).not.toContain(org.later)
      expect(response.body.organizationIds).not.toContain(org.dormant)
    })
  })
})

import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, desc, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as loginSendRoute from "@/app/api/v1/mfa/login/send-otp/route"
import * as loginVerifyRoute from "@/app/api/v1/mfa/login/verify-otp/route"
import * as selfSendRoute from "@/app/api/v1/mfa/send-otp/route"
import * as statusRoute from "@/app/api/v1/mfa/status/route"
import * as toggleRoute from "@/app/api/v1/mfa/toggle/route"
import * as selfVerifyRoute from "@/app/api/v1/mfa/verify-otp/route"
import { mfaCodes, organizations, roles, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import {
  checkDailyLimit,
  checkMfaCooldown,
  clearAllMFACooldowns,
  clearDailyCount,
  disableMFA,
  enableMFA,
  generateAndSendOTP,
  generateOTP,
  isMFAEnabled,
  verifyOTP,
} from "@/lib/mfa"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The one-time-code second factor against the real `mfa_codes` table.
 *
 * Faked: the session, the mail transport (codes are captured from the call),
 * the rate limiter, and Upstash (replaced by the in-memory Redis so the
 * cooldown, daily-count and attempt bookkeeping in `lib/mfa.ts` all run for
 * real). The OTP rows, their attempt counters, the "one live code per type"
 * rule and the authentication trail are the real code against the real schema.
 */

type SentMail = { to: string; code: string; type: string }

const mocks = vi.hoisted(() => ({
  sent: [] as SentMail[],
  mailFails: false,
  rateLimitAllowed: true,
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/email", () => ({
  sendOTPEmail: vi.fn(async (to: string, code: string, type: string) => {
    if (mocks.mailFails) return false
    mocks.sent.push({ to, code, type })
    return true
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({
  withRateLimit: vi.fn(async () => null),
  checkRateLimit: vi.fn(async () => ({ allowed: mocks.rateLimitAllowed, remaining: 1, resetIn: 42 })),
  getClientIdentifier: vi.fn(async () => "ip:127.0.0.1"),
  rateLimitResponse: (resetIn: number) =>
    new Response(JSON.stringify({ error: "Too many requests" }), {
      status: 429,
      headers: { "Retry-After": String(resetIn) },
    }),
}))
vi.mock("@upstash/redis", async () => {
  const { getLocalMemoryRedis } = await import("@/lib/local-memory-redis")
  return { Redis: class { constructor() { return getLocalMemoryRedis() } } }
})

const { getServerSession } = mockedNextAuth

type Fixtures = {
  suffix: string
  organizationId: number
  adminId: string
  adminEmail: string
  adminUsername: string
  orderPortalId: string
  noMfaId: string
  noMfaUsername: string
}

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "mfa integration" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures(): Promise<Fixtures> {
  const suffix = randomUUID().slice(0, 8)
  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT MFA ${suffix}`, code: `ITMFA-${suffix}` })
    .returning({ id: organizations.id })

  const base = {
    passwordHash: "$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE",
    organizationId: organization.id,
  }
  const adminEmail = `it-mfa-admin-${suffix}@example.test`
  const adminUsername = `it-mfa-admin-${suffix}`
  const noMfaUsername = `it-mfa-plain-${suffix}`

  const [admin] = await db.insert(users).values({
    ...base,
    email: adminEmail,
    username: adminUsername,
    roleId: await roleId("HEAD_OFFICE"),
    fullName: "MFA Admin",
    mfaEnabled: true,
  }).returning({ id: users.id })
  const [orderPortal] = await db.insert(users).values({
    ...base,
    email: `it-mfa-op-${suffix}@example.test`,
    username: `it-mfa-op-${suffix}`,
    roleId: await roleId("ORDER_PORTAL"),
    fullName: "MFA Order Portal",
  }).returning({ id: users.id })
  const [plain] = await db.insert(users).values({
    ...base,
    email: `it-mfa-plain-${suffix}@example.test`,
    username: noMfaUsername,
    roleId: await roleId("BRANCH_ADMIN"),
    fullName: "No MFA",
    mfaEnabled: false,
  }).returning({ id: users.id })

  return {
    suffix,
    organizationId: organization.id,
    adminId: admin.id,
    adminEmail,
    adminUsername,
    orderPortalId: orderPortal.id,
    noMfaId: plain.id,
    noMfaUsername,
  }
}

async function destroyFixtures(fixtures: Fixtures): Promise<void> {
  const ids = [fixtures.adminId, fixtures.orderPortalId, fixtures.noMfaId]
  await db.delete(systemLogs).where(inArray(systemLogs.userId, ids))
  await db.delete(mfaCodes).where(inArray(mfaCodes.userId, ids))
  await db.delete(users).where(inArray(users.id, ids))
  await db.delete(organizations).where(eq(organizations.id, fixtures.organizationId))
}

function signIn(user: { id: string; role: string; organizationId: number } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    user === null ? null : ({ user: { ...user, email: "x@example.test", mustChangePassword: false } } as any),
  )
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/mfa", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function liveCodes(userId: string, type = "LOGIN") {
  return db
    .select({ code: mfaCodes.code, attempts: mfaCodes.attempts, isUsed: mfaCodes.isUsed })
    .from(mfaCodes)
    .where(and(eq(mfaCodes.userId, userId), eq(mfaCodes.type, type), eq(mfaCodes.isUsed, false)))
    .orderBy(desc(mfaCodes.createdAt))
}

function wrongCodeFor(code: string): string {
  return code === "123456" ? "654321" : "123456"
}

describe.skipIf(!hasTestDatabase)("MFA one-time codes", () => {
  let fixtures: Fixtures
  const lastCode = () => mocks.sent.at(-1)?.code ?? ""

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  beforeEach(async () => {
    mocks.sent.length = 0
    mocks.mailFails = false
    mocks.rateLimitAllowed = true
    await db.delete(mfaCodes).where(inArray(mfaCodes.userId, [fixtures.adminId, fixtures.orderPortalId, fixtures.noMfaId]))
    await clearDailyCount(fixtures.adminId)
    // The lockout test leaves an OTP_VERIFY cooldown behind for a minute.
    await clearAllMFACooldowns(fixtures.adminId)
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  describe("generateOTP", () => {
    it("always yields six digits without a leading zero", () => {
      for (let i = 0; i < 300; i += 1) expect(generateOTP()).toMatch(/^[1-9]\d{5}$/)
    })
  })

  describe("generateAndSendOTP", () => {
    it("stores one live code, mails exactly that code, and says how long it lasts", async () => {
      const result = await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")

      expect(result).toEqual({ success: true, message: `OTP sent to ${fixtures.adminEmail}. Valid for 2 minutes.` })
      expect(mocks.sent).toHaveLength(1)
      const rows = await liveCodes(fixtures.adminId)
      expect(rows).toHaveLength(1)
      expect(rows[0].code).toBe(lastCode())
    })

    it("gives a verification code ten minutes", async () => {
      const result = await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "VERIFY_EMAIL")
      expect(result.message).toContain("Valid for 10 minutes")
    })

    it("retires the previous code when a new one is sent", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      const first = lastCode()
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      const second = lastCode()

      const rows = await liveCodes(fixtures.adminId)
      expect(rows.map((row) => row.code)).toEqual([second])
      if (first !== second) {
        expect((await verifyOTP(fixtures.adminId, first, "LOGIN")).success).toBe(false)
      }
      expect((await verifyOTP(fixtures.adminId, second, "LOGIN")).success).toBe(true)
    })

    it("keeps one live code per type, independently", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "VERIFY_EMAIL")
      expect(await liveCodes(fixtures.adminId, "LOGIN")).toHaveLength(1)
      expect(await liveCodes(fixtures.adminId, "VERIFY_EMAIL")).toHaveLength(1)
    })

    it("refuses bad input before touching the database", async () => {
      expect(await generateAndSendOTP("", fixtures.adminEmail, "LOGIN")).toMatchObject({ success: false, message: "Invalid user ID" })
      expect(await generateAndSendOTP(fixtures.adminId, "not-an-email", "LOGIN")).toMatchObject({ message: "Invalid email address" })
      expect(await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "SMS" as never)).toMatchObject({ message: "Invalid request type" })
      expect(await liveCodes(fixtures.adminId)).toHaveLength(0)
    })

    it("reports a mail failure", async () => {
      mocks.mailFails = true
      expect(await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")).toEqual({
        success: false,
        message: "Failed to send OTP email. Please try again.",
      })
    })

    it("stops at the daily limit of twenty and resumes once the count is cleared", async () => {
      for (let i = 0; i < 20; i += 1) {
        expect((await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")).success).toBe(true)
      }
      expect(await checkDailyLimit(fixtures.adminId)).toBe(false)
      expect(await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")).toEqual({
        success: false,
        message: "Daily OTP request limit exceeded. Please try again tomorrow.",
      })

      await clearDailyCount(fixtures.adminId)
    // The lockout test leaves an OTP_VERIFY cooldown behind for a minute.
    await clearAllMFACooldowns(fixtures.adminId)
      expect(await checkDailyLimit(fixtures.adminId)).toBe(true)
    })

    it("reports a database failure without mailing a code nobody can use", async () => {
      // mfa_codes.user_id is a uuid foreign key: an id that is not a user cannot be stored.
      const result = await generateAndSendOTP(randomUUID(), fixtures.adminEmail, "LOGIN")
      expect(result).toEqual({ success: false, message: "Failed to save OTP. Please try again." })
      expect(mocks.sent).toHaveLength(0)
    })
  })

  describe("verifyOTP", () => {
    it("accepts the live code once, then never again", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      const code = lastCode()

      expect(await verifyOTP(fixtures.adminId, ` ${code} `, "LOGIN")).toEqual({ success: true, message: "OTP verified successfully" })
      expect(await verifyOTP(fixtures.adminId, code, "LOGIN")).toEqual({
        success: false,
        message: "OTP has expired. Please request a new one.",
      })
    })

    it("does not accept a code issued for a different purpose", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "VERIFY_EMAIL")
      expect((await verifyOTP(fixtures.adminId, lastCode(), "LOGIN")).success).toBe(false)
      expect((await verifyOTP(fixtures.adminId, lastCode(), "VERIFY_EMAIL")).success).toBe(true)
    })

    it("does not accept another user's code", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      expect((await verifyOTP(fixtures.orderPortalId, lastCode(), "LOGIN")).success).toBe(false)
    })

    it("counts down the remaining attempts on each wrong code", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      const wrong = wrongCodeFor(lastCode())

      const first = await verifyOTP(fixtures.adminId, wrong, "LOGIN")
      expect(first).toMatchObject({ success: false, remainingAttempts: 4 })
      const second = await verifyOTP(fixtures.adminId, wrong, "LOGIN")
      expect(second.remainingAttempts).toBe(3)
      expect((await liveCodes(fixtures.adminId))[0].attempts).toBe(2)
    })

    it("locks the code after five wrong attempts, even against the right code", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      const code = lastCode()
      const wrong = wrongCodeFor(code)

      for (let i = 0; i < 4; i += 1) await verifyOTP(fixtures.adminId, wrong, "LOGIN")
      const fifthAttempt = await verifyOTP(fixtures.adminId, wrong, "LOGIN")
      expect(fifthAttempt).toMatchObject({ success: false, remainingAttempts: 0 })
      expect(fifthAttempt.message).toMatch(/^Too many failed attempts\. Please wait 1 minute/)

      const thenRight = await verifyOTP(fixtures.adminId, code, "LOGIN")
      expect(thenRight.success).toBe(false)
      expect(thenRight.message).toMatch(/^Too many failed attempts/)
    })

    it("rejects malformed codes without spending an attempt", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      expect(await verifyOTP(fixtures.adminId, "12345", "LOGIN")).toEqual({ success: false, message: "Invalid OTP format" })
      expect(await verifyOTP(fixtures.adminId, "12a456", "LOGIN")).toEqual({ success: false, message: "Invalid OTP format" })
      expect(await verifyOTP(fixtures.adminId, "", "LOGIN")).toEqual({ success: false, message: "Invalid OTP code" })
      expect(await verifyOTP("", "123456", "LOGIN")).toEqual({ success: false, message: "Invalid request" })
      expect(await verifyOTP(fixtures.adminId, "123456", "SMS" as never)).toEqual({ success: false, message: "Invalid request type" })
      expect((await liveCodes(fixtures.adminId))[0].attempts).toBe(0)
    })

    it("treats an expired code as expired", async () => {
      await generateAndSendOTP(fixtures.adminId, fixtures.adminEmail, "LOGIN")
      await db.update(mfaCodes)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(mfaCodes.userId, fixtures.adminId))

      expect(await verifyOTP(fixtures.adminId, lastCode(), "LOGIN")).toEqual({
        success: false,
        message: "OTP has expired. Please request a new one.",
      })
    })
  })

  describe("enrolment", () => {
    it("switches MFA on and off and reports it", async () => {
      expect(await disableMFA(fixtures.orderPortalId)).toMatchObject({ success: true })
      expect(await isMFAEnabled(fixtures.orderPortalId)).toBe(false)
      expect(await enableMFA(fixtures.orderPortalId)).toMatchObject({ success: true })
      expect(await isMFAEnabled(fixtures.orderPortalId)).toBe(true)
      await disableMFA(fixtures.orderPortalId)
    })

    it("discards outstanding codes when MFA is switched off", async () => {
      await enableMFA(fixtures.orderPortalId)
      await generateAndSendOTP(fixtures.orderPortalId, `it-mfa-op-${fixtures.suffix}@example.test`, "LOGIN")
      await disableMFA(fixtures.orderPortalId)
      const remaining = await db.select().from(mfaCodes).where(eq(mfaCodes.userId, fixtures.orderPortalId))
      expect(remaining).toHaveLength(0)
    })

    it("refuses an empty user id", async () => {
      expect(await enableMFA("")).toMatchObject({ success: false })
      expect(await disableMFA("")).toMatchObject({ success: false })
      expect(await isMFAEnabled("")).toBe(false)
      expect(await isMFAEnabled(randomUUID())).toBe(false)
    })

    it("has no request cooldown to report", async () => {
      expect(await checkMfaCooldown(fixtures.adminId)).toBe(0)
    })
  })

  describe("login endpoints", () => {
    const send = (body: unknown) => loginSendRoute.POST(post(body))
    const verify = (body: unknown) => loginVerifyRoute.POST(post(body))
    const GENERIC = { message: "If MFA is enabled for this account, a verification code has been sent." }

    it("answers identically for an unknown account, an account without MFA, and a real send", async () => {
      const unknown = await send({ username: `nobody-${fixtures.suffix}` })
      const plain = await send({ username: fixtures.noMfaUsername })
      const real = await send({ username: fixtures.adminUsername.toUpperCase() })

      for (const response of [unknown, plain, real]) {
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual(GENERIC)
      }
      expect(mocks.sent.map((mail) => mail.to)).toEqual([fixtures.adminEmail])
    })

    it("finds the account by email as well as by username", async () => {
      await send({ username: fixtures.adminEmail.toUpperCase() })
      expect(mocks.sent).toHaveLength(1)
    })

    it("records every challenge in the trail, telling the outcomes apart", async () => {
      await send({ username: fixtures.noMfaUsername })
      const [row] = await db
        .select({ action: systemLogs.action, success: systemLogs.success, errorMessage: systemLogs.errorMessage })
        .from(systemLogs)
        .where(eq(systemLogs.userId, fixtures.noMfaId))
        .orderBy(desc(systemLogs.id))
        .limit(1)
      expect(row).toMatchObject({ action: "AUTH_MFA_CHALLENGE", success: false })
    })

    it("validates the request", async () => {
      expect((await send({})).status).toBe(400)
      expect((await send({ username: "x", type: "VERIFY_EMAIL" })).status).toBe(400)
      expect((await verify({ username: "x" })).status).toBe(400)
      expect((await verify({ username: fixtures.adminUsername, code: "123" })).status).toBe(400)
    })

    it("answers 429 when the sender is throttled, before looking the account up", async () => {
      mocks.rateLimitAllowed = false
      const response = await send({ username: fixtures.adminUsername })
      expect(response.status).toBe(429)
      expect(mocks.sent).toHaveLength(0)
      expect((await verify({ username: fixtures.adminUsername, code: "123456" })).status).toBe(429)
    })

    it("verifies the mailed code and returns the account id", async () => {
      await send({ username: fixtures.adminUsername })
      const response = await verify({ username: fixtures.adminUsername, code: lastCode() })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ verified: true, userId: fixtures.adminId })
    })

    it("refuses a wrong code with the remaining attempts, and refuses unknown and non-MFA accounts identically", async () => {
      await send({ username: fixtures.adminUsername })
      const wrong = await verify({ username: fixtures.adminUsername, code: wrongCodeFor(lastCode()) })
      expect(wrong.status).toBe(400)
      expect((await wrong.json()).error).toMatch(/\(4 attempts remaining\)$/)

      for (const username of [`nobody-${fixtures.suffix}`, fixtures.noMfaUsername]) {
        const response = await verify({ username, code: "123456" })
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: "Invalid or expired OTP code" })
      }
    })
  })

  describe("self-service endpoints", () => {
    const admin = () => ({ id: fixtures.adminId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId })
    const orderPortal = () => ({ id: fixtures.orderPortalId, role: "ORDER_PORTAL", organizationId: fixtures.organizationId })

    it("is closed to anonymous callers and to roles without a Settings page", async () => {
      signIn(null)
      expect((await statusRoute.GET(new NextRequest("http://localhost/x"))).status).toBe(401)
      expect((await toggleRoute.POST(post({ action: "enable" }))).status).toBe(401)

      signIn(orderPortal())
      expect((await statusRoute.GET(new NextRequest("http://localhost/x"))).status).toBe(403)
      expect((await toggleRoute.POST(post({ action: "enable" }))).status).toBe(403)
      expect((await selfSendRoute.POST(post({}))).status).toBe(403)
      expect((await selfVerifyRoute.POST(post({ code: "123456" }))).status).toBe(403)
    })

    it("reports, disables and re-enables the caller's own MFA, recording each change", async () => {
      signIn(admin())
      expect(await (await statusRoute.GET(new NextRequest("http://localhost/x"))).json()).toMatchObject({ mfaEnabled: true })

      const off = await toggleRoute.POST(post({ action: "disable" }))
      expect(await off.json()).toMatchObject({ mfaEnabled: false })
      expect(await isMFAEnabled(fixtures.adminId)).toBe(false)

      const on = await toggleRoute.POST(post({ action: "enable" }))
      expect(await on.json()).toMatchObject({ mfaEnabled: true })

      const actions = await db
        .select({ action: systemLogs.action })
        .from(systemLogs)
        .where(eq(systemLogs.userId, fixtures.adminId))
      expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(["AUTH_MFA_DISABLED", "AUTH_MFA_ENABLED"]))
    })

    it("refuses an unknown toggle action", async () => {
      signIn(admin())
      expect((await toggleRoute.POST(post({ action: "maybe" }))).status).toBe(400)
    })

    it("sends to the caller's own address and verifies the code", async () => {
      signIn(admin())
      const sent = await selfSendRoute.POST(post({ type: "LOGIN" }))
      expect(sent.status).toBe(200)
      expect(mocks.sent.map((mail) => mail.to)).toEqual([fixtures.adminEmail])

      const short = await selfVerifyRoute.POST(post({ code: "12" }))
      expect(short.status).toBe(400)

      const verified = await selfVerifyRoute.POST(post({ code: lastCode() }))
      expect(verified.status).toBe(200)
      expect(await verified.json()).toMatchObject({ verified: true })
    })

    it("passes a mail failure back as a 400", async () => {
      signIn(admin())
      mocks.mailFails = true
      const response = await selfSendRoute.POST(post({}))
      expect(response.status).toBe(400)
    })
  })
})


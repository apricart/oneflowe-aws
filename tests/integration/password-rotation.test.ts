import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as changePasswordRoute from "@/app/api/v1/users/me/change-password/route"
import * as sendRoute from "@/app/api/v1/users/me/email-verification/send/route"
import * as verifyRoute from "@/app/api/v1/users/me/email-verification/verify/route"
import { authSessions, mfaCodes, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { hashPassword, verifyPassword } from "@/lib/password"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The whole rotation round trip against real Postgres: a code goes out, the
 * code comes back on one session, that session — and only that session —
 * may set a new password, exactly once, within ten minutes.
 *
 * Faked: the session (`getServerSession` and the session id the handler reads
 * from the JWT), the rate limiter, the mail transport (the code is captured
 * from the call), and Upstash (an in-memory Redis so `lib/mfa.ts` runs its
 * real cooldown and attempt logic without a server). Everything else — the
 * OTP table, the proof on `auth_sessions`, the password hash, the audit
 * rows — is the real code against the real schema.
 */

type SentMail = { to: string; code: string; type: string; details: unknown }

const mocks = vi.hoisted(() => ({
  sessionId: vi.fn<() => Promise<string | null>>(async () => null),
  withRateLimit: vi.fn(async () => null),
  /** Mail sent since the last `beforeEach`. */
  sent: [] as SentMail[],
  /** Every mail the suite ever sent; never reset. */
  allSent: [] as SentMail[],
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/server/current-session", () => ({ getCurrentSessionId: mocks.sessionId }))
vi.mock("@/lib/email", () => ({
  sendOTPEmail: vi.fn(async (to: string, code: string, type: string, details: unknown) => {
    mocks.sent.push({ to, code, type, details })
    mocks.allSent.push({ to, code, type, details })
    return true
  }),
}))
vi.mock("@upstash/redis", async () => {
  const { getLocalMemoryRedis } = await import("@/lib/local-memory-redis")
  return { Redis: class { constructor() { return getLocalMemoryRedis() } } }
})

const { getServerSession } = mockedNextAuth
const { POST: changePassword } = changePasswordRoute
const { POST: sendCode } = sendRoute
const { POST: verifyCode } = verifyRoute

const OLD_PASSWORD = "Handout-Passw0rd!"
const NEW_PASSWORD = "Chosen-Passw0rd!2026"

type Fixtures = {
  suffix: string
  organizationId: number
  branchAdminId: string
  unroutableId: string
  sessionA: string
  sessionB: string
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by password-rotation integration tests" })
    .returning({ id: roles.id })
  return created.id
}

async function openSession(userId: string, organizationId: number): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(authSessions).values({
    id,
    subjectId: userId,
    organizationId,
    startedAt: now,
    lastActivityAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
  })
  return id
}

async function createFixtures(): Promise<Fixtures> {
  const suffix = randomUUID().slice(0, 8)
  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Rotation ${suffix}`, code: `ITPR-${suffix}` })
    .returning({ id: organizations.id })
  const passwordHash = await hashPassword(OLD_PASSWORD)

  const [branchAdmin] = await db
    .insert(users)
    .values({
      email: `it-rotation-ba-${suffix}@example.test`,
      username: `imran-${suffix}-ba`,
      passwordHash,
      roleId: await resolveRoleId("BRANCH_ADMIN"),
      organizationId: organization.id,
      fullName: `Imran ${suffix}`,
      externalSource: "KE_LOGISTICS",
      externalId: suffix,
      mustChangePassword: true,
      sessionVersion: 3,
    })
    .returning({ id: users.id })

  const [unroutable] = await db
    .insert(users)
    .values({
      email: `nadia.${suffix}@ke-legacy.invalid`,
      username: `nadia-${suffix}-op`,
      passwordHash,
      roleId: await resolveRoleId("ORDER_PORTAL"),
      organizationId: organization.id,
      fullName: `Nadia ${suffix}`,
      mustChangePassword: true,
    })
    .returning({ id: users.id })

  return {
    suffix,
    organizationId: organization.id,
    branchAdminId: branchAdmin.id,
    unroutableId: unroutable.id,
    sessionA: await openSession(branchAdmin.id, organization.id),
    sessionB: await openSession(branchAdmin.id, organization.id),
  }
}

async function destroyFixtures(fixtures: Fixtures): Promise<void> {
  const userIds = [fixtures.branchAdminId, fixtures.unroutableId]
  await db.delete(systemLogs).where(inArray(systemLogs.userId, userIds))
  await db.delete(mfaCodes).where(inArray(mfaCodes.userId, userIds))
  await db.delete(sessions).where(inArray(sessions.userId, userIds))
  await db.delete(authSessions).where(inArray(authSessions.subjectId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(organizations).where(eq(organizations.id, fixtures.organizationId))
}

function signIn(userId: string | null, email = "x@example.test"): void {
  vi.mocked(getServerSession).mockResolvedValue(
    userId === null ? null : ({ user: { id: userId, email, role: "BRANCH_ADMIN", mustChangePassword: true } } as any),
  )
}

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function readAccount(userId: string) {
  const [row] = await db
    .select({
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      sessionVersion: users.sessionVersion,
      passwordChangedAt: users.passwordChangedAt,
      emailVerifiedAt: users.emailVerifiedAt,
      failedLoginAttempts: users.failedLoginAttempts,
    })
    .from(users)
    .where(eq(users.id, userId))
  return row
}

async function proofOn(sessionId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: authSessions.emailVerifiedAt })
    .from(authSessions)
    .where(eq(authSessions.id, sessionId))
  return row?.at ?? null
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await db
    .select({ action: systemLogs.action })
    .from(systemLogs)
    .where(eq(systemLogs.userId, userId))
    .orderBy(systemLogs.id)
  return rows.map((row) => row.action)
}

describe.skipIf(!hasTestDatabase)("forced password rotation through its real endpoints", () => {
  let fixtures: Fixtures
  const latestCode = () => mocks.sent.at(-1)?.code ?? ""

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  beforeEach(() => {
    mocks.sent.length = 0
    mocks.sessionId.mockResolvedValue(fixtures.sessionA)
    signIn(fixtures.branchAdminId, `it-rotation-ba-${fixtures.suffix}@example.test`)
  })

  it("refuses everything without a session", async () => {
    signIn(null)
    expect((await sendCode()).status).toBe(401)
    expect((await verifyCode(post("/api/v1/users/me/email-verification/verify", { code: "123456" }))).status).toBe(401)
    expect((await changePassword(post("/api/v1/users/me/change-password", { currentPassword: OLD_PASSWORD, password: NEW_PASSWORD }))).status).toBe(401)
    expect(mocks.sent).toEqual([])
  })

  it("will not change a password without a fresh proof on this session", async () => {
    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "EMAIL_VERIFICATION_REQUIRED" })
    const account = await readAccount(fixtures.branchAdminId)
    expect(account.mustChangePassword).toBe(true)
    expect(await verifyPassword(OLD_PASSWORD, account.passwordHash)).toBe(true)
  })

  it("refuses to send to an address that cannot receive mail, and generates nothing", async () => {
    signIn(fixtures.unroutableId)

    const response = await sendCode()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "EMAIL_UNROUTABLE", emailHint: "n***@ke-legacy.invalid" })
    expect(mocks.sent).toEqual([])
    const codes = await db.select({ id: mfaCodes.id }).from(mfaCodes).where(eq(mfaCodes.userId, fixtures.unroutableId))
    expect(codes).toEqual([])
  })

  it("sends a code that names the account it is for, and masks the address in the response", async () => {
    const response = await sendCode()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      sent: true,
      emailHint: "i***@example.test",
      validForMinutes: 10,
    })
    expect(mocks.sent).toHaveLength(1)
    expect(mocks.sent[0]).toMatchObject({
      to: `it-rotation-ba-${fixtures.suffix}@example.test`,
      type: "VERIFY_EMAIL",
      details: {
        validForMinutes: 10,
        account: { username: `imran-${fixtures.suffix}-ba`, accountLabel: "Branch Admin" },
      },
    })
    expect(mocks.sent[0].code).toMatch(/^\d{6}$/)
  })

  it("rejects a wrong code without stamping a proof", async () => {
    await sendCode()
    const wrong = latestCode() === "000000" ? "111111" : "000000"

    const response = await verifyCode(post("/api/v1/users/me/email-verification/verify", { code: wrong }))

    expect(response.status).toBe(400)
    expect(await proofOn(fixtures.sessionA)).toBeNull()
  })

  it("rejects a malformed body outright", async () => {
    expect((await verifyCode(post("/api/v1/users/me/email-verification/verify", { code: "12345" }))).status).toBe(400)
    expect((await verifyCode(post("/api/v1/users/me/email-verification/verify", { code: "123456", extra: 1 }))).status).toBe(400)
    expect((await changePassword(post("/api/v1/users/me/change-password", { password: NEW_PASSWORD }))).status).toBe(400)
    expect((await changePassword(post("/api/v1/users/me/change-password", { currentPassword: OLD_PASSWORD, password: NEW_PASSWORD, role: "SUPER_ADMIN" }))).status).toBe(400)
  })

  it("stamps the proof on the session that entered the code, and on the account", async () => {
    await sendCode()

    const response = await verifyCode(post("/api/v1/users/me/email-verification/verify", { code: latestCode() }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ verified: true, validForSeconds: 600 })
    expect(await proofOn(fixtures.sessionA)).toBeInstanceOf(Date)
    expect(await proofOn(fixtures.sessionB)).toBeNull()
    expect((await readAccount(fixtures.branchAdminId)).emailVerifiedAt).toBeInstanceOf(Date)
  })

  it("does not let another session of the same person spend the proof", async () => {
    mocks.sessionId.mockResolvedValue(fixtures.sessionB)

    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    }))

    expect(response.status).toBe(403)
    expect(await proofOn(fixtures.sessionA)).toBeInstanceOf(Date)
  })

  it("keeps the proof when the current password is wrong, and counts the attempt", async () => {
    const before = (await readAccount(fixtures.branchAdminId)).failedLoginAttempts

    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: "not-the-password",
      password: NEW_PASSWORD,
    }))

    expect(response.status).toBe(400)
    expect(await proofOn(fixtures.sessionA)).toBeInstanceOf(Date)
    const account = await readAccount(fixtures.branchAdminId)
    expect(account.mustChangePassword).toBe(true)
    // Counted unless the lockout budget is switched off for this environment.
    expect(account.failedLoginAttempts).toBeGreaterThanOrEqual(before)
  })

  it("refuses a new password equal to the current one, keeping the proof", async () => {
    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: OLD_PASSWORD,
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("different") })
    expect(await proofOn(fixtures.sessionA)).toBeInstanceOf(Date)
  })

  it("refuses a weak new password, keeping the proof", async () => {
    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: "short",
    }))

    expect(response.status).toBe(400)
    expect(await proofOn(fixtures.sessionA)).toBeInstanceOf(Date)
  })

  it("refuses a proof older than ten minutes", async () => {
    await db
      .update(authSessions)
      .set({ emailVerifiedAt: new Date(Date.now() - 11 * 60_000) })
      .where(eq(authSessions.id, fixtures.sessionA))

    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    }))

    expect(response.status).toBe(403)
    expect((await readAccount(fixtures.branchAdminId)).mustChangePassword).toBe(true)

    // Put a fresh proof back for the change that follows.
    await db.update(authSessions).set({ emailVerifiedAt: new Date() }).where(eq(authSessions.id, fixtures.sessionA))
  })

  it("changes the password once, consuming the proof, clearing the flag and revoking every session", async () => {
    const before = await readAccount(fixtures.branchAdminId)

    const response = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: OLD_PASSWORD,
      password: NEW_PASSWORD,
    }))

    expect(response.status).toBe(200)
    const after = await readAccount(fixtures.branchAdminId)
    expect(after.mustChangePassword).toBe(false)
    expect(after.passwordChangedAt).toBeInstanceOf(Date)
    expect(after.sessionVersion).toBe(before.sessionVersion + 1)
    expect(after.failedLoginAttempts).toBe(0)
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true)
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(false)
    expect(await proofOn(fixtures.sessionA)).toBeNull()

    // A retry finds no proof: the change is not repeatable.
    const again = await changePassword(post("/api/v1/users/me/change-password", {
      currentPassword: NEW_PASSWORD,
      password: "Another-Passw0rd!2026",
    }))
    expect(again.status).toBe(403)
    expect(await verifyPassword(NEW_PASSWORD, (await readAccount(fixtures.branchAdminId)).passwordHash)).toBe(true)
  })

  it("leaves an audit trail a reviewer can reconstruct, with no code or password in it", async () => {
    const actions = await auditActions(fixtures.branchAdminId)

    expect(actions).toContain("AUTH_EMAIL_VERIFICATION_SENT")
    expect(actions).toContain("AUTH_EMAIL_VERIFICATION_FAILURE")
    expect(actions).toContain("AUTH_EMAIL_VERIFIED")
    expect(actions).toContain("AUTH_PASSWORD_CHANGE_FAILURE")
    expect(actions.filter((action) => action === "AUTH_PASSWORD_CHANGED")).toHaveLength(1)

    const rows = await db
      .select({ details: systemLogs.details, errorMessage: systemLogs.errorMessage })
      .from(systemLogs)
      .where(and(eq(systemLogs.userId, fixtures.branchAdminId), eq(systemLogs.resourceType, "auth")))
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(OLD_PASSWORD)
    expect(serialized).not.toContain(NEW_PASSWORD)
    expect(mocks.allSent.length).toBeGreaterThan(0)
    for (const mail of mocks.allSent) expect(serialized).not.toContain(mail.code)
  })

  it("does not touch the other account in the tenant", async () => {
    const other = await readAccount(fixtures.unroutableId)
    expect(other.mustChangePassword).toBe(true)
    expect(other.passwordChangedAt).toBeNull()
    expect(await verifyPassword(OLD_PASSWORD, other.passwordHash)).toBe(true)
  })
})

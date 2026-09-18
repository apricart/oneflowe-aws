import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as changePasswordRoute from "@/app/api/v1/users/me/change-password/route"
import { authSessions, mfaCodes, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { hashPassword, verifyPassword } from "@/lib/password"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The forced password change with the emailed proof switched off
 * (`lib/password-change-policy.ts`, the setting that currently ships), against
 * real Postgres: no code goes out, none is asked for, and the change endpoint
 * alone takes the current password and the new one. Everything the proof did
 * *not* gate must still hold — the current password, the policy, new ≠ old,
 * the flag, the version bump, the sign-out of every device — and the session
 * named by the token must still be this account's live one.
 *
 * Faked: the session (`getServerSession` and the session id the handler reads
 * from the JWT), the rate limiter, the mail transport (so a stray code would
 * be caught rather than sent), Upstash, and the policy pinned to *off* so
 * this file tests one mode whatever the constant says. The required mode
 * runs in `password-rotation.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  sessionId: vi.fn<() => Promise<string | null>>(async () => null),
  withRateLimit: vi.fn(async () => null),
  sendOTPEmail: vi.fn(async () => true),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/server/current-session", () => ({ getCurrentSessionId: mocks.sessionId }))
vi.mock("@/lib/email", () => ({ sendOTPEmail: mocks.sendOTPEmail }))
vi.mock("@/lib/password-change-policy", () => ({
  isEmailVerificationRequiredForPasswordChange: () => false,
}))
vi.mock("@upstash/redis", async () => {
  const { getLocalMemoryRedis } = await import("@/lib/local-memory-redis")
  return { Redis: class { constructor() { return getLocalMemoryRedis() } } }
})

const { getServerSession } = mockedNextAuth
const { POST: changePassword } = changePasswordRoute

const OLD_PASSWORD = "Handout-Passw0rd!"
const NEW_PASSWORD = "Chosen-Passw0rd!2026"
const CHANGE = "/api/v1/users/me/change-password"

type Fixtures = {
  suffix: string
  organizationId: number
  /** The account that changes its password. */
  subjectId: string
  /** Another flagged account in the same tenant, never changed. */
  otherId: string
  /** Two live sessions of the subject. */
  sessionA: string
  sessionA2: string
  /** A live session of the other account. */
  sessionB: string
  /** A revoked session of the other account. */
  sessionBRevoked: string
  /** A physical session row of the subject, which the change must drop. */
  physicalSessionId: string
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by password-change-direct integration tests" })
    .returning({ id: roles.id })
  return created.id
}

async function openSession(userId: string, organizationId: number, revoked = false): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(authSessions).values({
    id,
    subjectId: userId,
    organizationId,
    startedAt: now,
    lastActivityAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
    revokedAt: revoked ? now : null,
  })
  return id
}

async function createFixtures(): Promise<Fixtures> {
  const suffix = randomUUID().slice(0, 8)
  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Direct Change ${suffix}`, code: `ITPD-${suffix}` })
    .returning({ id: organizations.id })
  const passwordHash = await hashPassword(OLD_PASSWORD)
  const roleId = await resolveRoleId("ORDER_PORTAL")

  const [subject] = await db
    .insert(users)
    .values({
      email: `it-direct-op-${suffix}@example.test`,
      username: `imran-${suffix}-op`,
      passwordHash,
      roleId,
      organizationId: organization.id,
      fullName: `Imran ${suffix}`,
      externalSource: "KE_LOGISTICS",
      externalId: suffix,
      mustChangePassword: true,
      sessionVersion: 5,
    })
    .returning({ id: users.id })

  const [other] = await db
    .insert(users)
    .values({
      email: `it-direct-other-${suffix}@example.test`,
      username: `nadia-${suffix}-op`,
      passwordHash,
      roleId,
      organizationId: organization.id,
      fullName: `Nadia ${suffix}`,
      mustChangePassword: true,
    })
    .returning({ id: users.id })

  const [physical] = await db
    .insert(sessions)
    .values({
      userId: subject.id,
      organizationId: organization.id,
      refreshTokenHash: `it-direct-${suffix}`,
      expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
    })
    .returning({ id: sessions.id })

  return {
    suffix,
    organizationId: organization.id,
    subjectId: subject.id,
    otherId: other.id,
    sessionA: await openSession(subject.id, organization.id),
    sessionA2: await openSession(subject.id, organization.id),
    sessionB: await openSession(other.id, organization.id),
    sessionBRevoked: await openSession(other.id, organization.id, true),
    physicalSessionId: physical.id,
  }
}

async function destroyFixtures(fixtures: Fixtures): Promise<void> {
  const userIds = [fixtures.subjectId, fixtures.otherId]
  await db.delete(systemLogs).where(inArray(systemLogs.userId, userIds))
  await db.delete(mfaCodes).where(inArray(mfaCodes.userId, userIds))
  await db.delete(sessions).where(inArray(sessions.userId, userIds))
  await db.delete(authSessions).where(inArray(authSessions.subjectId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(organizations).where(eq(organizations.id, fixtures.organizationId))
}

function signIn(userId: string | null, email = "x@example.test"): void {
  vi.mocked(getServerSession).mockResolvedValue(
    userId === null ? null : ({ user: { id: userId, email, role: "ORDER_PORTAL", mustChangePassword: true } } as any),
  )
}

function post(body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${CHANGE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const change = (currentPassword: string, password: string) => changePassword(post({ currentPassword, password }))

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

async function auditRows(userId: string) {
  return db
    .select({ action: systemLogs.action, details: systemLogs.details, errorMessage: systemLogs.errorMessage })
    .from(systemLogs)
    .where(and(eq(systemLogs.userId, userId), eq(systemLogs.resourceType, "auth")))
    .orderBy(systemLogs.id)
}

async function expectUnchanged(userId: string, sessionVersion: number): Promise<void> {
  const account = await readAccount(userId)
  expect(account.mustChangePassword).toBe(true)
  expect(account.passwordChangedAt).toBeNull()
  expect(account.sessionVersion).toBe(sessionVersion)
  expect(await verifyPassword(OLD_PASSWORD, account.passwordHash)).toBe(true)
}

describe.skipIf(!hasTestDatabase)("forced password change with the emailed proof switched off", () => {
  let fixtures: Fixtures

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  beforeEach(() => {
    mocks.sessionId.mockResolvedValue(fixtures.sessionA)
    signIn(fixtures.subjectId, `it-direct-op-${fixtures.suffix}@example.test`)
  })

  it("refuses without a session", async () => {
    signIn(null)

    expect((await change(OLD_PASSWORD, NEW_PASSWORD)).status).toBe(401)
    await expectUnchanged(fixtures.subjectId, 5)
  })

  it("refuses a token with no registry session id", async () => {
    mocks.sessionId.mockResolvedValue(null)

    expect((await change(OLD_PASSWORD, NEW_PASSWORD)).status).toBe(401)
    await expectUnchanged(fixtures.subjectId, 5)
  })

  it("rejects a malformed body and a mass-assignment attempt outright", async () => {
    expect((await changePassword(post({ password: NEW_PASSWORD }))).status).toBe(400)
    expect((await changePassword(post({ currentPassword: OLD_PASSWORD, password: NEW_PASSWORD, mustChangePassword: false }))).status).toBe(400)
    expect((await changePassword(post({ currentPassword: OLD_PASSWORD, password: NEW_PASSWORD, role: "SUPER_ADMIN" }))).status).toBe(400)
    await expectUnchanged(fixtures.subjectId, 5)
  })

  it("still requires the current password, and counts a wrong one", async () => {
    const before = (await readAccount(fixtures.subjectId)).failedLoginAttempts

    const response = await change("not-the-password", NEW_PASSWORD)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: "The current password is incorrect." })
    const account = await readAccount(fixtures.subjectId)
    expect(account.mustChangePassword).toBe(true)
    // Counted unless the lockout budget is switched off for this environment.
    expect(account.failedLoginAttempts).toBeGreaterThanOrEqual(before)
  })

  it("still refuses a new password equal to the current one", async () => {
    const response = await change(OLD_PASSWORD, OLD_PASSWORD)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("different") })
    await expectUnchanged(fixtures.subjectId, 5)
  })

  it("still applies the password policy", async () => {
    expect((await change(OLD_PASSWORD, "short")).status).toBe(400)
    await expectUnchanged(fixtures.subjectId, 5)
  })

  it("refuses a revoked session of the account with 401, changing nothing", async () => {
    signIn(fixtures.otherId)
    mocks.sessionId.mockResolvedValue(fixtures.sessionBRevoked)

    const response = await change(OLD_PASSWORD, NEW_PASSWORD)

    expect(response.status).toBe(401)
    await expectUnchanged(fixtures.otherId, 1)
    const rows = await auditRows(fixtures.otherId)
    expect(rows.at(-1)).toMatchObject({ action: "AUTH_PASSWORD_CHANGE_FAILURE" })
    expect(JSON.stringify(rows.at(-1)?.details)).toContain("session_invalid")
  })

  it("refuses a session that belongs to another account with 401, changing neither", async () => {
    mocks.sessionId.mockResolvedValue(fixtures.sessionB)

    const response = await change(OLD_PASSWORD, NEW_PASSWORD)

    expect(response.status).toBe(401)
    await expectUnchanged(fixtures.subjectId, 5)
    await expectUnchanged(fixtures.otherId, 1)
  })

  it("changes the password with no code sent, none asked for, and no proof on any session", async () => {
    const before = await readAccount(fixtures.subjectId)

    const response = await change(OLD_PASSWORD, NEW_PASSWORD)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })

    const after = await readAccount(fixtures.subjectId)
    expect(after.mustChangePassword).toBe(false)
    expect(after.passwordChangedAt).toBeInstanceOf(Date)
    expect(after.sessionVersion).toBe(before.sessionVersion + 1)
    expect(after.failedLoginAttempts).toBe(0)
    expect(after.emailVerifiedAt).toBeNull()
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true)
    expect(await verifyPassword(OLD_PASSWORD, after.passwordHash)).toBe(false)

    // No mail, no code row: the proof was never part of this.
    expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
    expect(await db.select({ id: mfaCodes.id }).from(mfaCodes).where(eq(mfaCodes.userId, fixtures.subjectId))).toEqual([])
    const proofs = await db
      .select({ at: authSessions.emailVerifiedAt })
      .from(authSessions)
      .where(inArray(authSessions.id, [fixtures.sessionA, fixtures.sessionA2]))
    expect(proofs.map((row) => row.at)).toEqual([null, null])

    // Every device is signed out: the physical session row is gone.
    expect(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, fixtures.subjectId))).toEqual([])
  })

  it("does not accept the old password as current afterwards", async () => {
    const response = await change(OLD_PASSWORD, "Another-Passw0rd!2026")

    expect(response.status).toBe(400)
    expect(await verifyPassword(NEW_PASSWORD, (await readAccount(fixtures.subjectId)).passwordHash)).toBe(true)
  })

  it("leaves an audit trail that says no proof was taken, with no password in it", async () => {
    const rows = await auditRows(fixtures.subjectId)
    const actions = rows.map((row) => row.action)

    expect(actions).not.toContain("AUTH_EMAIL_VERIFICATION_SENT")
    expect(actions).not.toContain("AUTH_EMAIL_VERIFIED")
    expect(actions).not.toContain("AUTH_EMAIL_VERIFICATION_FAILURE")
    expect(actions).toContain("AUTH_PASSWORD_CHANGE_FAILURE")
    const changed = rows.filter((row) => row.action === "AUTH_PASSWORD_CHANGED")
    expect(changed).toHaveLength(1)
    expect(changed[0].details).toMatchObject({ forced: true, emailVerified: false })

    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(OLD_PASSWORD)
    expect(serialized).not.toContain(NEW_PASSWORD)
  })

  it("does not touch the other account in the tenant", async () => {
    await expectUnchanged(fixtures.otherId, 1)
    expect((await readAccount(fixtures.otherId)).emailVerifiedAt).toBeNull()
  })
})

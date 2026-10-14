import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm"

import {
  authSessions,
  branches,
  employeeCredentials,
  organizations,
  passwordResetChallenges,
  roles,
  sessions,
  systemLogs,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { hashPassword, verifyPassword } from "@/lib/password"
import {
  PASSWORD_RESET_DAILY_LIMIT,
  PASSWORD_RESET_MAX_ATTEMPTS,
  completePasswordReset,
  requestPasswordReset,
  verifyPasswordResetCode,
} from "@/lib/server/password-reset"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * Self-service password reset against real Postgres
 * (`lib/server/password-reset.ts`, `plans/OF-AUTH-self-service-password-reset.md`).
 *
 * The routes are thin and unit-tested beside themselves; what only a database
 * can prove is here: the stored digests, the partial unique index behind
 * "a resend invalidates the earlier code", the attempt cap, single use under
 * concurrency, and that completing a reset signs the account out everywhere
 * without touching anybody else.
 *
 * Faked: the mail transport (so the code can be read back, and so a failure
 * can be simulated) and Upstash. Everything else is the shipped code.
 */

const mocks = vi.hoisted(() => ({
  sendOTPEmail: vi.fn(async (_to: string, _code: string, _type: string, _details?: unknown) => true),
}))

vi.mock("@/lib/email", () => ({ sendOTPEmail: mocks.sendOTPEmail }))
vi.mock("@upstash/redis", async () => {
  const { getLocalMemoryRedis } = await import("@/lib/local-memory-redis")
  return { Redis: class { constructor() { return getLocalMemoryRedis() } } }
})

const OLD_PASSWORD = "Handout-Passw0rd!"
const NEW_PASSWORD = "Chosen-Passw0rd!2026"

type Fixtures = {
  suffix: string
  organizationId: number
  inactiveOrganizationId: number
  branchId: number
  /** A portal-created account: email or username both work. */
  portalUserId: string
  portalUsername: string
  portalEmail: string
  /** A mirrored K-Electric account: username only, never by email. */
  mirroredUserId: string
  mirroredUsername: string
  mirroredEmail: string
  /** Two accounts behind one email; the email alone names neither. */
  sharedEmail: string
  sharedAId: string
  sharedBId: string
  /** Not active. */
  inactiveUsername: string
  inactiveUserId: string
  /** In an inactive tenant. */
  suspendedTenantUsername: string
  suspendedTenantUserId: string
  /** Someone else in the same tenant whose sessions must survive. */
  bystanderId: string
  /** An Order Portal employee principal (`emp_<id>`). */
  employeeId: number
  employeeUsername: string
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by password-reset integration tests" })
    .returning({ id: roles.id })
  return created.id
}

async function createFixtures(): Promise<Fixtures> {
  const suffix = randomUUID().slice(0, 8)
  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Reset ${suffix}`, code: `ITPR-${suffix}` })
    .returning({ id: organizations.id })
  const [inactiveOrganization] = await db
    .insert(organizations)
    .values({ name: `IT Reset Off ${suffix}`, code: `ITPX-${suffix}`, status: "inactive" })
    .returning({ id: organizations.id })
  const [branch] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `IT Reset Branch ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  const passwordHash = await hashPassword(OLD_PASSWORD)
  const orderPortal = await resolveRoleId("ORDER_PORTAL")
  const branchAdmin = await resolveRoleId("BRANCH_ADMIN")

  const insertUser = async (values: Partial<typeof users.$inferInsert> & { username: string; email: string }) => {
    const [row] = await db
      .insert(users)
      .values({
        passwordHash,
        roleId: orderPortal,
        organizationId: organization.id,
        branchId: branch.id,
        fullName: values.username,
        ...values,
      })
      .returning({ id: users.id })
    return row.id
  }

  const portalUsername = `sana-${suffix}-op`
  const portalEmail = `it-reset-portal-${suffix}@example.test`
  const mirroredUsername = `imran-${suffix}-op`
  const mirroredEmail = `it-reset-mirror-${suffix}@example.test`
  const sharedEmail = `it-reset-shared-${suffix}@example.test`
  const inactiveUsername = `gone-${suffix}-op`
  const suspendedTenantUsername = `paused-${suffix}-op`
  const employeeUsername = `emp-${suffix}`

  const portalUserId = await insertUser({
    username: portalUsername,
    email: portalEmail,
    mustChangePassword: true,
    sessionVersion: 3,
    failedLoginAttempts: 4,
    lockoutUntil: new Date(Date.now() + 10 * 60_000),
  })
  const mirroredUserId = await insertUser({
    username: mirroredUsername,
    email: mirroredEmail,
    externalSource: "KE_LOGISTICS",
    externalId: `mirror-${suffix}`,
  })
  const sharedAId = await insertUser({ username: `shared-${suffix}-ba`, email: sharedEmail, roleId: branchAdmin })
  const sharedBId = await insertUser({ username: `shared-${suffix}-op`, email: sharedEmail })
  const inactiveUserId = await insertUser({
    username: inactiveUsername,
    email: `it-reset-gone-${suffix}@example.test`,
    isActive: false,
  })
  const suspendedTenantUserId = await insertUser({
    username: suspendedTenantUsername,
    email: `it-reset-paused-${suffix}@example.test`,
    organizationId: inactiveOrganization.id,
    branchId: null,
  })
  const bystanderId = await insertUser({
    username: `bystander-${suffix}-op`,
    email: `it-reset-bystander-${suffix}@example.test`,
  })

  const [employee] = await db
    .insert(employeeCredentials)
    .values({
      branchId: branch.id,
      organizationId: organization.id,
      username: employeeUsername,
      email: `it-reset-employee-${suffix}@example.test`,
      passwordHash,
      createdByUserId: portalUserId,
      sessionVersion: 2,
    })
    .returning({ id: employeeCredentials.id })

  return {
    suffix,
    organizationId: organization.id,
    inactiveOrganizationId: inactiveOrganization.id,
    branchId: branch.id,
    portalUserId,
    portalUsername,
    portalEmail,
    mirroredUserId,
    mirroredUsername,
    mirroredEmail,
    sharedEmail,
    sharedAId,
    sharedBId,
    inactiveUsername,
    inactiveUserId,
    suspendedTenantUsername,
    suspendedTenantUserId,
    bystanderId,
    employeeId: employee.id,
    employeeUsername,
  }
}

function userIdsOf(fixtures: Fixtures): string[] {
  return [
    fixtures.portalUserId,
    fixtures.mirroredUserId,
    fixtures.sharedAId,
    fixtures.sharedBId,
    fixtures.inactiveUserId,
    fixtures.suspendedTenantUserId,
    fixtures.bystanderId,
  ]
}

function subjectIdsOf(fixtures: Fixtures): string[] {
  return [...userIdsOf(fixtures), `emp_${fixtures.employeeId}`]
}

async function destroyFixtures(fixtures: Fixtures): Promise<void> {
  const subjectIds = subjectIdsOf(fixtures)
  await db.delete(systemLogs).where(and(
    like(systemLogs.action, "AUTH_PASSWORD_RESET_%"),
    or(
      inArray(systemLogs.userId, subjectIds),
      like(systemLogs.resourceId, `%${fixtures.suffix}%`),
      isNull(systemLogs.userId),
    ),
  ))
  await db.delete(passwordResetChallenges).where(inArray(passwordResetChallenges.subjectId, subjectIds))
  await db.delete(authSessions).where(inArray(authSessions.subjectId, subjectIds))
  await db.delete(sessions).where(inArray(sessions.userId, userIdsOf(fixtures)))
  await db.delete(employeeCredentials).where(eq(employeeCredentials.id, fixtures.employeeId))
  await db.delete(users).where(inArray(users.id, userIdsOf(fixtures)))
  await db.delete(branches).where(eq(branches.id, fixtures.branchId))
  await db.delete(organizations).where(inArray(organizations.id, [
    fixtures.organizationId,
    fixtures.inactiveOrganizationId,
  ]))
}

async function openSession(subjectId: string, organizationId: number): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db.insert(authSessions).values({
    id,
    subjectId,
    organizationId,
    startedAt: now,
    lastActivityAt: now,
    absoluteExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000),
  })
  return id
}

async function challengeRows(subjectId: string) {
  return db
    .select()
    .from(passwordResetChallenges)
    .where(eq(passwordResetChallenges.subjectId, subjectId))
    .orderBy(passwordResetChallenges.createdAt)
}

/**
 * Request a reset the way the route does — the email leaves only when
 * `afterResponse` runs — and return the challenge id and the code that was
 * mailed, if any.
 */
async function requestAndDeliver(identifier: string): Promise<{ challengeId: string; code: string | null }> {
  mocks.sendOTPEmail.mockClear()
  const outcome = await requestPasswordReset(identifier)
  expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
  await outcome.afterResponse()
  const call = mocks.sendOTPEmail.mock.calls.at(-1)
  return { challengeId: outcome.challengeId, code: call ? call[1] : null }
}

function wrongCodeFor(code: string): string {
  return code === "000000" ? "000001" : "000000"
}

describe.skipIf(!hasTestDatabase)("self-service password reset", () => {
  let fixtures: Fixtures

  beforeAll(async () => {
    fixtures = await createFixtures()
  })

  afterAll(async () => {
    if (fixtures) await destroyFixtures(fixtures)
    await closePool()
  })

  beforeEach(async () => {
    mocks.sendOTPEmail.mockReset().mockResolvedValue(true)
    await db.delete(passwordResetChallenges).where(inArray(passwordResetChallenges.subjectId, subjectIdsOf(fixtures)))
  })

  describe("requesting a code", () => {
    it("mails a six-digit code to the account and stores only its digest", async () => {
      const { challengeId, code } = await requestAndDeliver(fixtures.portalUsername)

      expect(code).toMatch(/^\d{6}$/)
      expect(mocks.sendOTPEmail).toHaveBeenCalledWith(
        fixtures.portalEmail,
        code,
        "RESET_PASSWORD",
        expect.objectContaining({ validForMinutes: 10 }),
      )
      const [row] = await challengeRows(fixtures.portalUserId)
      expect(row.id).toBe(challengeId)
      expect(row.subjectType).toBe("user")
      expect(row.codeDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(row.codeDigest).not.toContain(code)
      expect(row.consumedAt).toBeNull()
    })

    it("accepts the email address of a portal-created account", async () => {
      const { code } = await requestAndDeliver(fixtures.portalEmail.toUpperCase())

      expect(code).not.toBeNull()
      expect(await challengeRows(fixtures.portalUserId)).toHaveLength(1)
    })

    it("finds a mirrored account by username but never by its email", async () => {
      const byEmail = await requestAndDeliver(fixtures.mirroredEmail)
      expect(byEmail.code).toBeNull()
      expect(await challengeRows(fixtures.mirroredUserId)).toHaveLength(0)

      const byUsername = await requestAndDeliver(fixtures.mirroredUsername)
      expect(byUsername.code).not.toBeNull()
      expect(await challengeRows(fixtures.mirroredUserId)).toHaveLength(1)
    })

    it("refuses an email that names more than one account", async () => {
      const { code } = await requestAndDeliver(fixtures.sharedEmail)

      expect(code).toBeNull()
      expect(await challengeRows(fixtures.sharedAId)).toHaveLength(0)
      expect(await challengeRows(fixtures.sharedBId)).toHaveLength(0)
    })

    it.each([
      ["an unknown username", () => `nobody-${fixtures.suffix}`],
      ["an inactive account", () => fixtures.inactiveUsername],
      ["an account in an inactive organization", () => fixtures.suspendedTenantUsername],
    ])("answers %s with a decoy that looks like a real challenge", async (_label, identifier) => {
      const { challengeId, code } = await requestAndDeliver(identifier())

      expect(code).toBeNull()
      expect(challengeId).toMatch(/^[0-9a-f-]{36}$/)
      const [stored] = await db
        .select({ id: passwordResetChallenges.id })
        .from(passwordResetChallenges)
        .where(eq(passwordResetChallenges.id, challengeId))
      expect(stored).toBeUndefined()
    })

    it("invalidates the earlier code when a new one is requested", async () => {
      const first = await requestAndDeliver(fixtures.portalUsername)
      const second = await requestAndDeliver(fixtures.portalUsername)

      const rows = await challengeRows(fixtures.portalUserId)
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === first.challengeId)?.consumedAt).not.toBeNull()
      expect(rows.find((row) => row.id === second.challengeId)?.consumedAt).toBeNull()
      expect(await verifyPasswordResetCode(first.challengeId, first.code!)).toEqual({ kind: "rejected" })
    })

    it("holds at most one live challenge per account, even under concurrent requests", async () => {
      await Promise.all(Array.from({ length: 4 }, () => requestPasswordReset(fixtures.portalUsername)))

      const live = (await challengeRows(fixtures.portalUserId)).filter((row) => row.consumedAt === null)
      expect(live.length).toBeLessThanOrEqual(1)
    })

    it("withdraws a code whose email could not be sent", async () => {
      mocks.sendOTPEmail.mockResolvedValue(false)

      const outcome = await requestPasswordReset(fixtures.portalUsername)
      await outcome.afterResponse()

      const [row] = await challengeRows(fixtures.portalUserId)
      expect(row.id).toBe(outcome.challengeId)
      expect(row.consumedAt).not.toBeNull()
    })

    it(`stops issuing codes after ${PASSWORD_RESET_DAILY_LIMIT} in a day`, async () => {
      for (let index = 0; index < PASSWORD_RESET_DAILY_LIMIT; index += 1) {
        await requestPasswordReset(fixtures.portalUsername)
      }

      const { code } = await requestAndDeliver(fixtures.portalUsername)

      expect(code).toBeNull()
      expect(await challengeRows(fixtures.portalUserId)).toHaveLength(PASSWORD_RESET_DAILY_LIMIT)
    })
  })

  describe("verifying the code", () => {
    it("rejects a wrong code exactly as it rejects a decoy", async () => {
      const real = await requestAndDeliver(fixtures.portalUsername)
      const decoy = await requestAndDeliver(`nobody-${fixtures.suffix}`)

      const againstReal = await verifyPasswordResetCode(real.challengeId, wrongCodeFor(real.code!))
      const againstDecoy = await verifyPasswordResetCode(decoy.challengeId, "123456")

      expect(againstReal).toEqual(againstDecoy)
      expect(againstReal).toEqual({ kind: "rejected" })
    })

    it(`consumes the challenge after ${PASSWORD_RESET_MAX_ATTEMPTS} wrong guesses, right code or not`, async () => {
      const { challengeId, code } = await requestAndDeliver(fixtures.portalUsername)

      for (let index = 0; index < PASSWORD_RESET_MAX_ATTEMPTS; index += 1) {
        await verifyPasswordResetCode(challengeId, wrongCodeFor(code!))
      }

      const [row] = await challengeRows(fixtures.portalUserId)
      expect(row.attempts).toBe(PASSWORD_RESET_MAX_ATTEMPTS)
      expect(row.consumedAt).not.toBeNull()
      expect(await verifyPasswordResetCode(challengeId, code!)).toEqual({ kind: "rejected" })
    })

    it("refuses an expired code", async () => {
      const { challengeId, code } = await requestAndDeliver(fixtures.portalUsername)
      await db
        .update(passwordResetChallenges)
        .set({
          createdAt: new Date(Date.now() - 20 * 60_000),
          expiresAt: new Date(Date.now() - 1_000),
        })
        .where(eq(passwordResetChallenges.id, challengeId))

      expect(await verifyPasswordResetCode(challengeId, code!)).toEqual({ kind: "rejected" })
    })

    it("accepts the right code once and stores only the reset token's digest", async () => {
      const { challengeId, code } = await requestAndDeliver(fixtures.portalUsername)

      const first = await verifyPasswordResetCode(challengeId, code!)
      const second = await verifyPasswordResetCode(challengeId, code!)

      expect(first.kind).toBe("verified")
      expect(second).toEqual({ kind: "rejected" })
      const [row] = await challengeRows(fixtures.portalUserId)
      expect(row.verifiedAt).not.toBeNull()
      expect(row.resetTokenDigest).toMatch(/^[0-9a-f]{64}$/)
      if (first.kind === "verified") expect(row.resetTokenDigest).not.toBe(first.resetToken)
    })
  })

  describe("completing the reset", () => {
    async function verifiedChallenge(identifier: string): Promise<{ challengeId: string; resetToken: string }> {
      const { challengeId, code } = await requestAndDeliver(identifier)
      const verified = await verifyPasswordResetCode(challengeId, code!)
      if (verified.kind !== "verified") throw new Error("fixture challenge did not verify")
      return { challengeId, resetToken: verified.resetToken }
    }

    it("refuses a token that is wrong, and one for an unverified challenge", async () => {
      const verified = await verifiedChallenge(fixtures.portalUsername)

      expect(await completePasswordReset({
        challengeId: verified.challengeId,
        resetToken: "A".repeat(43),
        newPassword: NEW_PASSWORD,
      })).toEqual({ kind: "invalid_token" })

      const unverified = await requestAndDeliver(fixtures.portalUsername)
      expect(await completePasswordReset({
        challengeId: unverified.challengeId,
        resetToken: verified.resetToken,
        newPassword: NEW_PASSWORD,
      })).toEqual({ kind: "invalid_token" })
    })

    it("refuses the current password and a password the policy rejects", async () => {
      const verified = await verifiedChallenge(fixtures.portalUsername)

      expect(await completePasswordReset({ ...verified, newPassword: OLD_PASSWORD }))
        .toEqual({ kind: "password_unchanged" })
      expect((await completePasswordReset({ ...verified, newPassword: "short" })).kind)
        .toBe("invalid_password")
      // Neither refusal spends the token.
      const [row] = await challengeRows(fixtures.portalUserId)
      expect(row.consumedAt).toBeNull()
    })

    it("sets the password, clears the lockout and the forced change, and signs out every device", async () => {
      const sessionOne = await openSession(fixtures.portalUserId, fixtures.organizationId)
      const sessionTwo = await openSession(fixtures.portalUserId, fixtures.organizationId)
      const bystanderSession = await openSession(fixtures.bystanderId, fixtures.organizationId)
      const [physical] = await db
        .insert(sessions)
        .values({
          userId: fixtures.portalUserId,
          organizationId: fixtures.organizationId,
          refreshTokenHash: `it-reset-${fixtures.suffix}`,
          expiresAt: new Date(Date.now() + 8 * 60 * 60_000),
        })
        .returning({ id: sessions.id })
      const verified = await verifiedChallenge(fixtures.portalUsername)

      expect(await completePasswordReset({ ...verified, newPassword: NEW_PASSWORD }))
        .toEqual({ kind: "completed" })

      const [account] = await db.select().from(users).where(eq(users.id, fixtures.portalUserId))
      expect(await verifyPassword(NEW_PASSWORD, account.passwordHash)).toBe(true)
      expect(account.mustChangePassword).toBe(false)
      expect(account.sessionVersion).toBe(4)
      expect(account.failedLoginAttempts).toBe(0)
      expect(account.lockoutUntil).toBeNull()
      expect(account.passwordChangedAt).not.toBeNull()

      const registry = await db
        .select({ id: authSessions.id, revokedAt: authSessions.revokedAt })
        .from(authSessions)
        .where(inArray(authSessions.id, [sessionOne, sessionTwo, bystanderSession]))
      expect(registry.find((row) => row.id === sessionOne)?.revokedAt).not.toBeNull()
      expect(registry.find((row) => row.id === sessionTwo)?.revokedAt).not.toBeNull()
      expect(registry.find((row) => row.id === bystanderSession)?.revokedAt).toBeNull()

      const [legacySession] = await db
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.id, physical.id))
      expect(legacySession.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())

      const [completedAudit] = await db
        .select({ success: systemLogs.success })
        .from(systemLogs)
        .where(and(
          eq(systemLogs.userId, fixtures.portalUserId),
          eq(systemLogs.action, "AUTH_PASSWORD_RESET_COMPLETED"),
        ))
      expect(completedAudit?.success).toBe(true)

      // The bearer is single use.
      expect(await completePasswordReset({ ...verified, newPassword: `${NEW_PASSWORD}x` }))
        .toEqual({ kind: "invalid_token" })
    })

    it("lets exactly one of two concurrent completions through", async () => {
      const verified = await verifiedChallenge(fixtures.mirroredUsername)

      const outcomes = await Promise.all([
        completePasswordReset({ ...verified, newPassword: "First-Choice-Passw0rd!" }),
        completePasswordReset({ ...verified, newPassword: "Second-Choice-Passw0rd!" }),
      ])

      expect(outcomes.filter((outcome) => outcome.kind === "completed")).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.kind === "invalid_token")).toHaveLength(1)
      const [{ version }] = await db
        .select({ version: sql<number>`${users.sessionVersion}` })
        .from(users)
        .where(eq(users.id, fixtures.mirroredUserId))
      expect(version).toBe(2)
    })

    it("resets an Order Portal employee principal and revokes its sessions only", async () => {
      const subjectId = `emp_${fixtures.employeeId}`
      const employeeSession = await openSession(subjectId, fixtures.organizationId)
      const bystanderSession = await openSession(fixtures.bystanderId, fixtures.organizationId)
      const verified = await verifiedChallenge(fixtures.employeeUsername)

      const [challenge] = await challengeRows(subjectId)
      expect(challenge.subjectType).toBe("employee")

      expect(await completePasswordReset({ ...verified, newPassword: NEW_PASSWORD }))
        .toEqual({ kind: "completed" })

      const [employee] = await db
        .select()
        .from(employeeCredentials)
        .where(eq(employeeCredentials.id, fixtures.employeeId))
      expect(await verifyPassword(NEW_PASSWORD, employee.passwordHash)).toBe(true)
      expect(employee.sessionVersion).toBe(3)

      const registry = await db
        .select({ id: authSessions.id, revokedAt: authSessions.revokedAt })
        .from(authSessions)
        .where(inArray(authSessions.id, [employeeSession, bystanderSession]))
      expect(registry.find((row) => row.id === employeeSession)?.revokedAt).not.toBeNull()
      expect(registry.find((row) => row.id === bystanderSession)?.revokedAt).toBeNull()
    })

    it("refuses to complete for an account deactivated after the code was verified", async () => {
      const verified = await verifiedChallenge(`bystander-${fixtures.suffix}-op`)
      await db.update(users).set({ isActive: false }).where(eq(users.id, fixtures.bystanderId))

      try {
        expect(await completePasswordReset({ ...verified, newPassword: NEW_PASSWORD }))
          .toEqual({ kind: "invalid_token" })
        const [account] = await db.select().from(users).where(eq(users.id, fixtures.bystanderId))
        expect(await verifyPassword(OLD_PASSWORD, account.passwordHash)).toBe(true)
      } finally {
        await db.update(users).set({ isActive: true }).where(eq(users.id, fixtures.bystanderId))
      }
    })
  })
})

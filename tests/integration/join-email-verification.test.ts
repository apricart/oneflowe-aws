import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, sql } from "drizzle-orm"
import { NextRequest } from "next/server"

import * as requestRoute from "@/app/api/v1/join/email-verification/request/route"
import * as verifyRoute from "@/app/api/v1/join/email-verification/verify/route"
import * as submitRoute from "@/app/api/v1/join/requests/route"
import {
  joinEmailVerifications,
  organizationJoinCodes,
  organizationJoinRequests,
  organizations,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import {
  JOIN_EMAIL_CODE_INVALID_MESSAGE,
  JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE,
  JOIN_EMAIL_DAILY_LIMIT_MESSAGE,
  JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE,
  JOIN_EMAIL_NOT_VERIFIED_MESSAGE,
  UNKNOWN_JOIN_CODE_MESSAGE,
} from "@/lib/organization-join"
import {
  JOIN_EMAIL_DAILY_LIMIT,
  JOIN_EMAIL_MAX_ATTEMPTS,
  joinEmailDigest,
  joinEmailProofIsLive,
} from "@/lib/server/join-email-verification"

import { mintJoinEmailProof, unknownJoinEmailProof } from "./helpers/join-email-proof"
import {
  JOIN_FIXTURE_EMAIL_DOMAIN,
  createJoinFixtures,
  destroyJoinFixtures,
  findRequestByEmail,
  hasTestDatabase,
  type JoinFixtures,
} from "./helpers/organization-join-fixtures"

/**
 * Proving a join applicant's address before the form
 * (plans/OF-JOIN-email-otp-verification.md), against real Postgres: the
 * request and verify routes, the digests they store, the attempt cap, the
 * resend, the daily cap, and the submit spending the proof — bound to the
 * organization and the address — in the transaction that stores the request.
 *
 * Faked: the mail transport (so the code can be read back and a failure
 * simulated), password hashing (speed) and the Redis limiter (the contract
 * test asserts each route consults its budgets).
 */

const mocks = vi.hoisted(() => ({
  sendOTPEmail: vi.fn(async (_to: string, _code: string, _type: string, _details?: unknown) => true),
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 10, resetIn: 60 })),
}))

vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendOTPEmail: mocks.sendOTPEmail,
}))
vi.mock("@/lib/password", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/password")>()),
  hashPassword: mocks.hashPassword,
}))
vi.mock("@/lib/rate-limiter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limiter")>()),
  checkRateLimit: mocks.checkRateLimit,
  getClientIdentifier: async () => "ip:127.0.0.1",
}))

const STRONG_PASSWORD = "Join-Flow-2026!x"

function jsonRequest(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function json(response: Response): Promise<any> {
  return response.clone().json()
}

describe.skipIf(!hasTestDatabase)("verifying a join applicant's email", () => {
  let fixtures: JoinFixtures
  let code = ""
  let foreignCode = ""
  let domainlessCode = ""
  let domainlessOrganizationId = 0

  const address = (label: string) =>
    `${label}-${fixtures.suffix}-${randomUUID().slice(0, 6)}@${JOIN_FIXTURE_EMAIL_DOMAIN}`

  const requestCode = (body: Record<string, unknown>) =>
    requestRoute.POST(jsonRequest("/api/v1/join/email-verification/request", body))
  const verifyCode = (body: Record<string, unknown>) =>
    verifyRoute.POST(jsonRequest("/api/v1/join/email-verification/verify", body))
  const submit = (body: Record<string, unknown>) =>
    submitRoute.POST(jsonRequest("/api/v1/join/requests", body))

  /** The code the last mail carried. */
  function lastMailedCode(): string {
    const call = mocks.sendOTPEmail.mock.calls.at(-1)
    expect(call).toBeDefined()
    return call![1]
  }

  /** Request, read the mail, verify: the proof a real applicant ends with. */
  async function proveAddress(email: string, joinCode = code) {
    const requested = await requestCode({ code: joinCode, email })
    expect(requested.status, JSON.stringify(await json(requested))).toBe(202)
    const { challengeId } = await json(requested)
    const verified = await verifyCode({ challengeId, otp: lastMailedCode() })
    expect(verified.status).toBe(200)
    const { proof } = await json(verified)
    return { challengeId: challengeId as string, proof: proof as string }
  }

  const standardSubmission = (email: string, emailVerification: unknown, overrides: Record<string, unknown> = {}) => ({
    code,
    firstName: "Ada",
    lastName: "Lovelace",
    email,
    username: `ada-${fixtures.suffix}-${randomUUID().slice(0, 6)}`,
    password: STRONG_PASSWORD,
    role: "ORDER_PORTAL",
    branchId: fixtures.northBranchId,
    emailVerification,
    ...overrides,
  })

  beforeAll(async () => {
    fixtures = await createJoinFixtures()
    code = `JEV-${fixtures.suffix}`.toUpperCase()
    foreignCode = `JEVF-${fixtures.suffix}`.toUpperCase()
    domainlessCode = `JEVD-${fixtures.suffix}`.toUpperCase()
    const [domainless] = await db
      .insert(organizations)
      .values({ name: `IT Join Domainless ${fixtures.suffix}`, code: `ITJD_${fixtures.suffix}`, status: "active" })
      .returning({ id: organizations.id })
    domainlessOrganizationId = domainless.id
    await db.insert(organizationJoinCodes).values([
      { organizationId: fixtures.organizationId, code },
      { organizationId: fixtures.foreignOrganizationId, code: foreignCode },
      { organizationId: domainlessOrganizationId, code: domainlessCode },
    ])
  })

  afterAll(async () => {
    if (domainlessOrganizationId) {
      await db.delete(organizations).where(eq(organizations.id, domainlessOrganizationId))
    }
    if (fixtures) await destroyJoinFixtures(fixtures)
    await closePool()
  })

  beforeEach(() => {
    mocks.sendOTPEmail.mockReset()
    mocks.sendOTPEmail.mockImplementation(async () => true)
  })

  describe("requesting a code", () => {
    it("mails a six-digit code to the address and stores only digests", async () => {
      const email = address("mail")
      const response = await requestCode({ code: code.toLowerCase(), email: email.toUpperCase() })
      expect(response.status).toBe(202)
      const { challengeId, validForMinutes } = await json(response)
      expect(validForMinutes).toBe(10)

      expect(mocks.sendOTPEmail).toHaveBeenCalledTimes(1)
      const [to, otp, type] = mocks.sendOTPEmail.mock.calls[0]
      expect(to).toBe(email.toLowerCase())
      expect(otp).toMatch(/^\d{6}$/)
      expect(type).toBe("VERIFY_EMAIL")

      const [row] = await db.select().from(joinEmailVerifications).where(eq(joinEmailVerifications.id, challengeId))
      expect(row.organizationId).toBe(fixtures.organizationId)
      expect(row.emailDigest).toBe(joinEmailDigest(email))
      expect(row.codeDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(row)).not.toContain(otp)
      expect(JSON.stringify(row).toLowerCase()).not.toContain(email.toLowerCase())
    })

    it("answers an unknown code with the one generic message and sends nothing", async () => {
      const response = await requestCode({ code: "ZZZZ-ZZZZ-ZZZZ", email: address("unknown") })
      expect(response.status).toBe(404)
      expect((await json(response)).error).toBe(UNKNOWN_JOIN_CODE_MESSAGE)
      expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
    })

    it("refuses an address outside the organization's domain, a subdomain, and a lookalike", async () => {
      for (const email of [
        `ada-${fixtures.suffix}@elsewhere.test`,
        `ada-${fixtures.suffix}@mail.${JOIN_FIXTURE_EMAIL_DOMAIN}`,
        `ada-${fixtures.suffix}@${JOIN_FIXTURE_EMAIL_DOMAIN}.evil.test`,
      ]) {
        const response = await requestCode({ code, email })
        expect(response.status, email).toBe(400)
      }
      expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
    })

    it("refuses an organization with no domain", async () => {
      const response = await requestCode({ code: domainlessCode, email: address("domainless") })
      expect(response.status).toBe(409)
      expect((await json(response)).error).toBe(JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE)
      expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
    })

    it("refuses an organization id and any other field it does not take", async () => {
      const response = await requestCode({ code, email: address("strict"), organizationId: fixtures.foreignOrganizationId })
      expect(response.status).toBe(400)
      expect(mocks.sendOTPEmail).not.toHaveBeenCalled()
    })

    it("spends the challenge and says so when the mail cannot be sent", async () => {
      mocks.sendOTPEmail.mockImplementation(async () => false)
      const email = address("undelivered")
      const response = await requestCode({ code, email })
      expect(response.status).toBe(503)
      expect((await json(response)).error).toBe(JOIN_EMAIL_CODE_SEND_FAILED_MESSAGE)

      const rows = await db.select().from(joinEmailVerifications)
        .where(eq(joinEmailVerifications.emailDigest, joinEmailDigest(email)))
      expect(rows).toHaveLength(1)
      expect(rows[0].consumedAt).not.toBeNull()
    })

    it("a resend retires the earlier code", async () => {
      const email = address("resend")
      const first = await json(await requestCode({ code, email }))
      const firstCode = lastMailedCode()
      const second = await json(await requestCode({ code, email }))
      expect(second.challengeId).not.toBe(first.challengeId)

      const stale = await verifyCode({ challengeId: first.challengeId, otp: firstCode })
      expect(stale.status).toBe(400)
      const current = await verifyCode({ challengeId: second.challengeId, otp: lastMailedCode() })
      expect(current.status).toBe(200)
    })

    it(`stops at ${JOIN_EMAIL_DAILY_LIMIT} codes per address per day`, async () => {
      const email = address("daily")
      for (let index = 0; index < JOIN_EMAIL_DAILY_LIMIT; index += 1) {
        expect((await requestCode({ code, email })).status).toBe(202)
      }
      const refused = await requestCode({ code, email })
      expect(refused.status).toBe(429)
      expect(refused.headers.get("Retry-After")).toBe(String(24 * 60 * 60))
      expect((await json(refused)).error).toBe(JOIN_EMAIL_DAILY_LIMIT_MESSAGE)
      expect(mocks.sendOTPEmail).toHaveBeenCalledTimes(JOIN_EMAIL_DAILY_LIMIT)

      // Per address and per organization: the same mailbox in another tenant is not held back.
      expect((await requestCode({ code: foreignCode, email })).status).toBe(202)
    })
  })

  describe("verifying the code", () => {
    it("answers a single proof for the right code", async () => {
      const email = address("verify")
      const { challengeId } = await json(await requestCode({ code, email }))
      const response = await verifyCode({ challengeId, otp: lastMailedCode() })
      expect(response.status).toBe(200)
      const result = await json(response)
      expect(result.proof).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(result.validForSeconds).toBe(3600)

      // The same code a second time is refused: the challenge is verified.
      const again = await verifyCode({ challengeId, otp: lastMailedCode() })
      expect(again.status).toBe(400)
    })

    it(`spends the challenge after ${JOIN_EMAIL_MAX_ATTEMPTS} wrong codes, and never says how many are left`, async () => {
      const email = address("guess")
      const { challengeId } = await json(await requestCode({ code, email }))
      const right = lastMailedCode()
      const wrong = right === "123456" ? "654321" : "123456"

      for (let attempt = 0; attempt < JOIN_EMAIL_MAX_ATTEMPTS; attempt += 1) {
        const response = await verifyCode({ challengeId, otp: wrong })
        expect(response.status).toBe(400)
        expect(await json(response)).toEqual({ error: JOIN_EMAIL_CODE_INVALID_MESSAGE })
      }
      const afterCap = await verifyCode({ challengeId, otp: right })
      expect(afterCap.status).toBe(400)
    })

    it("refuses an expired code and a challenge that never existed with the same answer", async () => {
      const email = address("expired")
      const { challengeId } = await json(await requestCode({ code, email }))
      await db.update(joinEmailVerifications)
        .set({ createdAt: sql`now() - interval '20 minutes'`, expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(joinEmailVerifications.id, challengeId))
      const expired = await verifyCode({ challengeId, otp: lastMailedCode() })
      const unknown = await verifyCode({ challengeId: randomUUID(), otp: "123456" })
      expect(expired.status).toBe(400)
      expect(unknown.status).toBe(400)
      expect(await json(expired)).toEqual(await json(unknown))
    })
  })

  describe("submitting the form", () => {
    it("is refused without a proof, and stores nothing", async () => {
      const email = address("noproof")
      const { emailVerification: _omitted, ...body } = standardSubmission(email, undefined)
      const response = await submit(body)
      expect(response.status).toBe(400)
      expect(await findRequestByEmail(email)).toBeNull()
    })

    it("stores the request, stamps it verified, and spends the proof", async () => {
      const email = address("accepted")
      const proof = await proveAddress(email)
      const response = await submit(standardSubmission(email, proof))
      expect(response.status, JSON.stringify(await json(response))).toBe(201)

      const stored = await findRequestByEmail(email)
      expect(stored?.emailVerifiedAt).toBeInstanceOf(Date)
      expect(await joinEmailProofIsLive({ ...proof, organizationId: fixtures.organizationId, email })).toBe(false)
      const [row] = await db.select().from(joinEmailVerifications).where(eq(joinEmailVerifications.id, proof.challengeId))
      expect(row.consumedAt).not.toBeNull()
    })

    it("refuses a proof for another address", async () => {
      const proven = address("proven")
      const other = address("other")
      const proof = await proveAddress(proven)
      const response = await submit(standardSubmission(other, proof))
      expect(response.status).toBe(400)
      expect((await json(response)).error).toBe(JOIN_EMAIL_NOT_VERIFIED_MESSAGE)
      expect(await findRequestByEmail(other)).toBeNull()
      // Still good for the address it was issued for.
      expect(await joinEmailProofIsLive({ ...proof, organizationId: fixtures.organizationId, email: proven })).toBe(true)
    })

    it("refuses a proof issued through another organization's code, though both share a domain", async () => {
      const email = address("crosstenant")
      const proof = await proveAddress(email, foreignCode)
      const response = await submit(standardSubmission(email, proof))
      expect(response.status).toBe(400)
      expect((await json(response)).error).toBe(JOIN_EMAIL_NOT_VERIFIED_MESSAGE)
      expect(await findRequestByEmail(email)).toBeNull()
    })

    it("refuses a lapsed proof, a forged one, and a code that was never verified", async () => {
      const lapsedEmail = address("lapsed")
      const lapsed = await proveAddress(lapsedEmail)
      await db.update(joinEmailVerifications)
        .set({
          createdAt: sql`now() - interval '3 hours'`,
          expiresAt: sql`now() - interval '170 minutes'`,
          verifiedAt: sql`now() - interval '2 hours'`,
          proofExpiresAt: sql`now() - interval '1 hour'`,
        })
        .where(eq(joinEmailVerifications.id, lapsed.challengeId))
      expect((await submit(standardSubmission(lapsedEmail, lapsed))).status).toBe(400)

      const forgedEmail = address("forged")
      const real = await proveAddress(forgedEmail)
      const forged = { challengeId: real.challengeId, proof: unknownJoinEmailProof().proof }
      expect((await submit(standardSubmission(forgedEmail, forged))).status).toBe(400)

      const unverifiedEmail = address("unverified")
      const { challengeId } = await json(await requestCode({ code, email: unverifiedEmail }))
      const guessed = { challengeId, proof: unknownJoinEmailProof().proof }
      expect((await submit(standardSubmission(unverifiedEmail, guessed))).status).toBe(400)

      expect(await findRequestByEmail(lapsedEmail)).toBeNull()
      expect(await findRequestByEmail(unverifiedEmail)).toBeNull()
    })

    it("keeps the proof when the submission is refused for another reason, and spends it once", async () => {
      const takenUsername = `taken-${fixtures.suffix}`
      const firstEmail = address("first")
      const first = await submit(standardSubmission(
        firstEmail,
        await mintJoinEmailProof(fixtures.organizationId, firstEmail),
        { username: takenUsername },
      ))
      expect(first.status).toBe(201)

      const email = address("retry")
      const proof = await proveAddress(email)
      const clash = await submit(standardSubmission(email, proof, { username: takenUsername }))
      expect(clash.status).toBe(409)
      expect(await joinEmailProofIsLive({ ...proof, organizationId: fixtures.organizationId, email })).toBe(true)

      const accepted = await submit(standardSubmission(email, proof))
      expect(accepted.status).toBe(201)

      // Replayed after the request it opened was rejected: still spent.
      await db.update(organizationJoinRequests)
        .set({ status: "rejected", decidedAt: new Date(), decidedByUserId: fixtures.headOfficeId })
        .where(eq(organizationJoinRequests.email, email))
      const replay = await submit(standardSubmission(email, proof))
      expect(replay.status).toBe(400)
      expect((await json(replay)).error).toBe(JOIN_EMAIL_NOT_VERIFIED_MESSAGE)
    })

    it("lets exactly one of two simultaneous submissions spend a proof", async () => {
      const email = address("race")
      const proof = await proveAddress(email)
      const responses = await Promise.all([
        submit(standardSubmission(email, proof)),
        submit(standardSubmission(email, proof)),
      ])
      const statuses = responses.map((response) => response.status).sort()
      expect(statuses.filter((status) => status === 201)).toHaveLength(1)
      const stored = await db.select({ id: organizationJoinRequests.id }).from(organizationJoinRequests)
        .where(eq(organizationJoinRequests.email, email))
      expect(stored).toHaveLength(1)
    })
  })

  it("leaves nothing for a domainless tenant", async () => {
    const rows = await db.select().from(joinEmailVerifications)
      .where(eq(joinEmailVerifications.organizationId, domainlessOrganizationId))
    expect(rows).toHaveLength(0)
  })
})

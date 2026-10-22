import "server-only"

import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { and, eq, gt, isNull, sql } from "drizzle-orm"

import { joinEmailVerifications } from "@/db/schema"
import { db } from "@/lib/db"
import { sendOTPEmail } from "@/lib/email"
import {
  JOIN_EMAIL_CODE_VALIDITY_MINUTES,
  JOIN_EMAIL_PROOF_VALIDITY_MINUTES,
} from "@/lib/organization-join"
import { recordAuthAuditEvent } from "@/lib/server/auth-audit"
import { env } from "@/lib/server/env"
import { normalizeEmail } from "@/lib/user-uniqueness"

/**
 * Proving that a join applicant receives mail at the address they typed
 * (plans/OF-JOIN-email-otp-verification.md).
 *
 * The applicant has no account, so `lib/mfa.ts` (keyed on `users.id`) cannot
 * hold the code. This follows `lib/server/password-reset.ts` instead: a
 * challenge row holding HMAC digests only — of the code, of the proof, and of
 * the address itself — so a verification that is never finished leaves no
 * personal data behind.
 *
 *   1. `issueJoinEmailCode` — a 6-digit code to the address, for one
 *      organization. A resend consumes the live challenge first.
 *   2. `verifyJoinEmailCode` — the code back, at most five tries, answered
 *      with a single-use proof.
 *   3. `consumeJoinEmailProof` — the join submit spends the proof inside the
 *      transaction that stores the request. That is the control; the page
 *      showing the form only after step 2 is presentation.
 *
 * No step asks whether the address belongs to an account or to a pending
 * request, so none of them can be used to find out.
 */

export const JOIN_EMAIL_MAX_ATTEMPTS = 5
export const JOIN_EMAIL_DAILY_LIMIT = 10

const CODE_VALIDITY_MS = JOIN_EMAIL_CODE_VALIDITY_MINUTES * 60 * 1000
const PROOF_VALIDITY_MS = JOIN_EMAIL_PROOF_VALIDITY_MINUTES * 60 * 1000
const ONE_DAY_MS = 24 * 60 * 60 * 1000

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type JoinEmailProof = { challengeId: string; proof: string }

export type IssueJoinEmailCodeOutcome =
  | { kind: "sent"; challengeId: string; validForMinutes: number }
  | { kind: "daily_limit" }
  | { kind: "delivery_failed" }

export type VerifyJoinEmailCodeOutcome =
  | { kind: "verified"; proof: string; validForSeconds: number }
  | { kind: "rejected" }

function hmac(value: string): string {
  return createHmac("sha256", env.NEXTAUTH_SECRET)
    .update(`oneflowe-join-email:v1:${value}`)
    .digest("hex")
}

/**
 * The address, as the table and the rate limiter know it. Normalised by the
 * same `normalizeEmail` the join request is stored under, so the address the
 * submit stores and the address that was proven compare equal exactly when
 * they are the same mailbox.
 */
export function joinEmailDigest(email: string): string {
  return hmac(`email:${normalizeEmail(email)}`)
}

/** Exported for the digest-binding tests; never given a value read from storage. */
export function joinEmailCodeDigest(challengeId: string, code: string): string {
  return hmac(`code:${challengeId}:${code}`)
}

export function joinEmailProofDigest(challengeId: string, proof: string): string {
  return hmac(`proof:${challengeId}:${proof}`)
}

function safeDigestEqual(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(candidate)) return false
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"))
}

async function dailyBudgetAvailable(organizationId: number, emailDigest: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(joinEmailVerifications)
    .where(and(
      eq(joinEmailVerifications.organizationId, organizationId),
      eq(joinEmailVerifications.emailDigest, emailDigest),
      gt(joinEmailVerifications.createdAt, new Date(Date.now() - ONE_DAY_MS)),
    ))
  return (row?.count ?? 0) < JOIN_EMAIL_DAILY_LIMIT
}

/**
 * Sends a code to `email` for joining `organizationId`. The caller has already
 * resolved the organization from the join code and held the address to its
 * domain; this does neither.
 *
 * The code is sent before answering, unlike the password reset: nothing about
 * accounts was consulted, so neither the answer nor its timing can reveal one,
 * and the applicant is told honestly when the mail could not be sent.
 */
export async function issueJoinEmailCode(input: {
  organizationId: number
  email: string
}): Promise<IssueJoinEmailCodeOutcome> {
  const email = normalizeEmail(input.email)
  const emailDigest = joinEmailDigest(email)
  if (!(await dailyBudgetAvailable(input.organizationId, emailDigest))) {
    return { kind: "daily_limit" }
  }

  const challengeId = randomUUID()
  const code = randomInt(100_000, 1_000_000).toString()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_VALIDITY_MS)

  await db.transaction(async (tx) => {
    // A resend retires every earlier code or unspent proof for this address in
    // this organization; the partial unique index makes that race-safe.
    await tx
      .update(joinEmailVerifications)
      .set({ consumedAt: now })
      .where(and(
        eq(joinEmailVerifications.organizationId, input.organizationId),
        eq(joinEmailVerifications.emailDigest, emailDigest),
        isNull(joinEmailVerifications.consumedAt),
      ))
    await tx.insert(joinEmailVerifications).values({
      id: challengeId,
      organizationId: input.organizationId,
      emailDigest,
      codeDigest: joinEmailCodeDigest(challengeId, code),
      expiresAt,
      createdAt: now,
    })
  })

  const delivered = await sendOTPEmail(email, code, "VERIFY_EMAIL", {
    validForMinutes: JOIN_EMAIL_CODE_VALIDITY_MINUTES,
    account: null,
  })

  if (!delivered) {
    // A code nobody received must not stay guessable for its lifetime.
    await db
      .update(joinEmailVerifications)
      .set({ consumedAt: new Date() })
      .where(and(eq(joinEmailVerifications.id, challengeId), isNull(joinEmailVerifications.consumedAt)))
    await recordAuthAuditEvent({
      action: "AUTH_JOIN_EMAIL_VERIFICATION_FAILURE",
      organizationId: input.organizationId,
      success: false,
      reason: "join_email_delivery_failed",
      details: { challengeId },
    })
    return { kind: "delivery_failed" }
  }

  await recordAuthAuditEvent({
    action: "AUTH_JOIN_EMAIL_CODE_SENT",
    organizationId: input.organizationId,
    success: true,
    details: { challengeId, expiresAt: expiresAt.toISOString() },
  })
  return { kind: "sent", challengeId, validForMinutes: JOIN_EMAIL_CODE_VALIDITY_MINUTES }
}

/** Counts a wrong guess against a live challenge, spending it on the last one. */
async function rejectCodeAttempt(challengeId: string): Promise<void> {
  await db
    .update(joinEmailVerifications)
    .set({
      attempts: sql`${joinEmailVerifications.attempts} + 1`,
      consumedAt: sql`CASE
        WHEN ${joinEmailVerifications.attempts} + 1 >= ${JOIN_EMAIL_MAX_ATTEMPTS}
          THEN now()
        ELSE ${joinEmailVerifications.consumedAt}
      END`,
    })
    .where(and(
      eq(joinEmailVerifications.id, challengeId),
      isNull(joinEmailVerifications.consumedAt),
      isNull(joinEmailVerifications.verifiedAt),
      gt(joinEmailVerifications.expiresAt, new Date()),
      sql`${joinEmailVerifications.attempts} < ${JOIN_EMAIL_MAX_ATTEMPTS}`,
    ))
}

export async function verifyJoinEmailCode(
  challengeId: string,
  code: string,
): Promise<VerifyJoinEmailCodeOutcome> {
  const [challenge] = await db
    .select({
      organizationId: joinEmailVerifications.organizationId,
      codeDigest: joinEmailVerifications.codeDigest,
      attempts: joinEmailVerifications.attempts,
      expiresAt: joinEmailVerifications.expiresAt,
      verifiedAt: joinEmailVerifications.verifiedAt,
      consumedAt: joinEmailVerifications.consumedAt,
    })
    .from(joinEmailVerifications)
    .where(eq(joinEmailVerifications.id, challengeId))
    .limit(1)

  const suppliedDigest = joinEmailCodeDigest(challengeId, code)
  if (
    !challenge
    || challenge.consumedAt
    || challenge.verifiedAt
    || challenge.expiresAt.getTime() <= Date.now()
    || challenge.attempts >= JOIN_EMAIL_MAX_ATTEMPTS
    || !safeDigestEqual(challenge.codeDigest, suppliedDigest)
  ) {
    await rejectCodeAttempt(challengeId)
    await recordAuthAuditEvent({
      action: "AUTH_JOIN_EMAIL_VERIFICATION_FAILURE",
      organizationId: challenge?.organizationId ?? null,
      success: false,
      reason: "join_email_challenge_invalid",
      details: { challengeId },
    })
    return { kind: "rejected" }
  }

  const proof = randomBytes(32).toString("base64url")
  const verifiedAt = new Date()
  const proofExpiresAt = new Date(verifiedAt.getTime() + PROOF_VALIDITY_MS)
  // Claimed on the digest the caller proved, so two racing correct answers
  // produce one proof.
  const [verified] = await db
    .update(joinEmailVerifications)
    .set({ verifiedAt, proofDigest: joinEmailProofDigest(challengeId, proof), proofExpiresAt })
    .where(and(
      eq(joinEmailVerifications.id, challengeId),
      eq(joinEmailVerifications.codeDigest, suppliedDigest),
      isNull(joinEmailVerifications.consumedAt),
      isNull(joinEmailVerifications.verifiedAt),
      gt(joinEmailVerifications.expiresAt, verifiedAt),
      sql`${joinEmailVerifications.attempts} < ${JOIN_EMAIL_MAX_ATTEMPTS}`,
    ))
    .returning({ organizationId: joinEmailVerifications.organizationId })
  if (!verified) return { kind: "rejected" }

  await recordAuthAuditEvent({
    action: "AUTH_JOIN_EMAIL_VERIFIED",
    organizationId: verified.organizationId,
    success: true,
    details: { challengeId, validForSeconds: PROOF_VALIDITY_MS / 1000 },
  })
  return { kind: "verified", proof, validForSeconds: PROOF_VALIDITY_MS / 1000 }
}

/** The conditions under which a proof may be spent on this organization and address. */
function liveProofCondition(input: JoinEmailProof & { organizationId: number; email: string }, now: Date) {
  return and(
    eq(joinEmailVerifications.id, input.challengeId),
    eq(joinEmailVerifications.organizationId, input.organizationId),
    eq(joinEmailVerifications.emailDigest, joinEmailDigest(input.email)),
    eq(joinEmailVerifications.proofDigest, joinEmailProofDigest(input.challengeId, input.proof)),
    isNull(joinEmailVerifications.consumedAt),
    gt(joinEmailVerifications.proofExpiresAt, now),
  )
}

/**
 * Whether the proof could be spent right now. A read only, so the submit can
 * refuse a lapsed proof before hashing a password; `consumeJoinEmailProof` is
 * what decides.
 */
export async function joinEmailProofIsLive(
  input: JoinEmailProof & { organizationId: number; email: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: joinEmailVerifications.id })
    .from(joinEmailVerifications)
    .where(liveProofCondition(input, new Date()))
    .limit(1)
  return Boolean(row)
}

/**
 * Spends the proof inside the transaction that stores the join request, and
 * says whether it could. Bound to the organization the join code resolved to
 * on this request and to the address about to be stored; a proof for another
 * address, another organization, a lapsed one, or one already spent matches
 * no row. If the insert after it fails, the rollback leaves the proof unspent.
 */
export async function consumeJoinEmailProof(
  tx: TransactionExecutor,
  input: JoinEmailProof & { organizationId: number; email: string },
): Promise<boolean> {
  const now = new Date()
  const [consumed] = await tx
    .update(joinEmailVerifications)
    .set({ consumedAt: now })
    .where(liveProofCondition(input, now))
    .returning({ id: joinEmailVerifications.id })
  return Boolean(consumed)
}


/**
 * Thrown inside a join request's creating transaction when its proof cannot be
 * spent, so the insert rolls back with it. The creators answer it as an
 * `unverified` failure.
 */
export class JoinEmailProofRejected extends Error {
  constructor() {
    super("join email proof rejected")
    this.name = "JoinEmailProofRejected"
  }
}

/** Spends the proof or aborts the transaction. */
export async function spendJoinEmailProof(
  tx: TransactionExecutor,
  input: JoinEmailProof & { organizationId: number; email: string },
): Promise<void> {
  if (!(await consumeJoinEmailProof(tx, input))) throw new JoinEmailProofRejected()
}

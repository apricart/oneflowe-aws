import { randomBytes, randomUUID } from "node:crypto"

import { and, eq, isNull } from "drizzle-orm"
import { NextRequest } from "next/server"

import { joinEmailVerifications } from "@/db/schema"
import { db } from "@/lib/db"
import {
  joinEmailCodeDigest,
  joinEmailDigest,
  joinEmailProofDigest,
  type JoinEmailProof,
} from "@/lib/server/join-email-verification"
import { resolveOrganizationByJoinCode } from "@/lib/server/organization-join"
import { normalizeJoinCode } from "@/lib/organization-join"

/**
 * A verified email proof for (organization, address), written straight to
 * `join_email_verifications` — what the request and verify steps would have
 * left behind (plans/OF-JOIN-email-otp-verification.md). Suites about the
 * join form itself use it so each case does not have to drive the code mail;
 * `tests/integration/join-email-verification.test.ts` drives the real steps.
 *
 * Retires any live challenge for the same address first, exactly as a resend
 * does, so the one-live-challenge index is respected across repeated calls.
 */
export async function mintJoinEmailProof(organizationId: number, email: string): Promise<JoinEmailProof> {
  const challengeId = randomUUID()
  const proof = randomBytes(32).toString("base64url")
  const emailDigest = joinEmailDigest(email)
  const now = new Date()

  await db.transaction(async (tx) => {
    await tx
      .update(joinEmailVerifications)
      .set({ consumedAt: now })
      .where(and(
        eq(joinEmailVerifications.organizationId, organizationId),
        eq(joinEmailVerifications.emailDigest, emailDigest),
        isNull(joinEmailVerifications.consumedAt),
      ))
    await tx.insert(joinEmailVerifications).values({
      id: challengeId,
      organizationId,
      emailDigest,
      codeDigest: joinEmailCodeDigest(challengeId, "000000"),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      verifiedAt: now,
      proofDigest: joinEmailProofDigest(challengeId, proof),
      proofExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: new Date(now.getTime() - 1000),
    })
  })
  return { challengeId, proof }
}

/** A well-formed proof that matches no row. */
export function unknownJoinEmailProof(): JoinEmailProof {
  return { challengeId: randomUUID(), proof: randomBytes(32).toString("base64url") }
}

/**
 * Adds `emailVerification` to a join submission that has none, minted for the
 * organization its code resolves to and the address it names. A body that
 * already carries one is sent as it is, and a body whose code or address
 * cannot be resolved gets a proof that matches nothing, so it fails at the
 * check it was written to fail at, not at "no proof".
 */
export async function withJoinEmailProof(body: unknown): Promise<unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const record = body as Record<string, unknown>
  if ("emailVerification" in record) return body

  const organization = typeof record.code === "string"
    ? await resolveOrganizationByJoinCode(normalizeJoinCode(record.code)).catch(() => null)
    : null
  const emailVerification = organization && typeof record.email === "string" && record.email.trim()
    ? await mintJoinEmailProof(organization.organizationId, record.email)
    : unknownJoinEmailProof()
  return { ...record, emailVerification }
}

/**
 * Wraps the join submit handler so every request carries a proof (see
 * `withJoinEmailProof`). Unparseable bodies are passed through untouched.
 */
export function submitWithJoinEmailProof(
  handler: (request: NextRequest) => Promise<Response>,
): (request: NextRequest) => Promise<Response> {
  return async (request) => {
    const text = await request.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return handler(new NextRequest(request.url, { method: request.method, headers: request.headers, body: text }))
    }
    const body = await withJoinEmailProof(parsed)
    return handler(new NextRequest(request.url, {
      method: request.method,
      headers: request.headers,
      body: JSON.stringify(body),
    }))
  }
}

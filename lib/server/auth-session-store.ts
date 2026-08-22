import "server-only"

import { createHash } from "node:crypto"
import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm"
import { authSessions } from "@/db/schema"
import { db } from "@/lib/db"
import {
  normalizeSessionIdleTimeoutMinutes,
  type SessionExpirationReason,
  type SessionPolicyClaims,
} from "@/lib/session-policy"

export type SessionRegistryIdentity = {
  sessionId: string
  subjectId: string
  organizationId: number | null
  sessionStartedAt: number
  sessionAbsoluteExpiresAt: number
}

type ValidSessionRegistryResult = {
  kind: "valid"
  claims: SessionPolicyClaims
}

export type SessionRegistryResult =
  | ValidSessionRegistryResult
  | { kind: "invalid"; reason: SessionExpirationReason }
  | { kind: "unavailable"; error: unknown }

type SessionRegistryRow = {
  subjectId: string
  organizationId: number | null
  startedAt: Date
  lastActivityAt: Date
  absoluteExpiresAt: Date
  revokedAt: Date | null
}

function logSessionLifecycle(
  event: "created" | "activity_renewed" | "expired" | "revocation_processed",
  identity: Pick<SessionRegistryIdentity, "sessionId" | "subjectId" | "organizationId">,
  details?: Record<string, unknown>,
): void {
  // Never log a bearer token or raw session ID. A one-way reference permits
  // operational correlation without creating another reusable credential.
  const sessionReference = createHash("sha256")
    .update(identity.sessionId)
    .digest("hex")
    .slice(0, 16)
  console.info("[AuthSession]", {
    event,
    sessionReference,
    subjectId: identity.subjectId,
    organizationId: identity.organizationId,
    ...details,
  })
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

function validIdentity(identity: SessionRegistryIdentity): boolean {
  return (
    validUuid(identity.sessionId) &&
    typeof identity.subjectId === "string" &&
    identity.subjectId.length > 0 &&
    Number.isSafeInteger(identity.sessionStartedAt) &&
    identity.sessionStartedAt > 0 &&
    Number.isSafeInteger(identity.sessionAbsoluteExpiresAt) &&
    identity.sessionAbsoluteExpiresAt > identity.sessionStartedAt
  )
}

function rowMatchesIdentity(
  row: SessionRegistryRow,
  identity: SessionRegistryIdentity,
): boolean {
  return (
    row.subjectId === identity.subjectId &&
    row.organizationId === identity.organizationId &&
    row.startedAt.getTime() === identity.sessionStartedAt &&
    row.absoluteExpiresAt.getTime() === identity.sessionAbsoluteExpiresAt
  )
}

function claimsFromRow(
  row: SessionRegistryRow,
  idleTimeoutMinutes: number,
): SessionPolicyClaims {
  return {
    sessionPolicyVersion: 1,
    sessionStartedAt: row.startedAt.getTime(),
    sessionLastActivityAt: row.lastActivityAt.getTime(),
    sessionIdleTimeoutMinutes: idleTimeoutMinutes,
    sessionAbsoluteExpiresAt: row.absoluteExpiresAt.getTime(),
  }
}

const registrySelection = {
  subjectId: authSessions.subjectId,
  organizationId: authSessions.organizationId,
  startedAt: authSessions.startedAt,
  lastActivityAt: authSessions.lastActivityAt,
  absoluteExpiresAt: authSessions.absoluteExpiresAt,
  revokedAt: authSessions.revokedAt,
}

export async function createAuthSessionRecord(input: {
  sessionId: string
  subjectId: string
  organizationId: number | null
  claims: SessionPolicyClaims
}): Promise<void> {
  if (
    !validIdentity({
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      organizationId: input.organizationId,
      sessionStartedAt: input.claims.sessionStartedAt,
      sessionAbsoluteExpiresAt: input.claims.sessionAbsoluteExpiresAt,
    })
  ) {
    throw new TypeError("Cannot create an auth session with an invalid identity")
  }

  await db.insert(authSessions).values({
    id: input.sessionId,
    subjectId: input.subjectId,
    organizationId: input.organizationId,
    startedAt: new Date(input.claims.sessionStartedAt),
    lastActivityAt: new Date(input.claims.sessionLastActivityAt),
    absoluteExpiresAt: new Date(input.claims.sessionAbsoluteExpiresAt),
  })
  logSessionLifecycle("created", {
    sessionId: input.sessionId,
    subjectId: input.subjectId,
    organizationId: input.organizationId,
  })
}

/**
 * Validate a registry row without recording activity. Expiration is persisted
 * as revocation before returning, so a later tenant-policy increase can never
 * revive a session that was already rejected under a stricter policy.
 */
export async function validateAuthSessionRecord(
  identity: SessionRegistryIdentity,
  idleTimeoutMinutesInput: unknown,
  nowMs: number,
): Promise<SessionRegistryResult> {
  if (!validIdentity(identity) || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { kind: "invalid", reason: "invalid_policy" }
  }

  const idleTimeoutMinutes = normalizeSessionIdleTimeoutMinutes(
    idleTimeoutMinutesInput,
  )
  const now = new Date(nowMs)

  try {
    const [expired] = await db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(authSessions.id, identity.sessionId),
          eq(authSessions.subjectId, identity.subjectId),
          isNull(authSessions.revokedAt),
          or(
            lte(authSessions.absoluteExpiresAt, now),
            sql`${authSessions.lastActivityAt} + (${idleTimeoutMinutes} * INTERVAL '1 minute') <= ${now}`,
          ),
        ),
      )
      .returning(registrySelection)

    if (expired) {
      const reason =
        expired.absoluteExpiresAt.getTime() <= nowMs
          ? "absolute_timeout"
          : "idle_timeout"
      logSessionLifecycle("expired", identity, { reason })
      return {
        kind: "invalid",
        reason,
      }
    }

    const [row] = await db
      .select(registrySelection)
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, identity.sessionId),
          eq(authSessions.subjectId, identity.subjectId),
        ),
      )
      .limit(1)

    if (!row || row.revokedAt || !rowMatchesIdentity(row, identity)) {
      return { kind: "invalid", reason: "invalid_policy" }
    }
    if (row.absoluteExpiresAt.getTime() <= nowMs) {
      return { kind: "invalid", reason: "absolute_timeout" }
    }
    if (
      row.lastActivityAt.getTime() + idleTimeoutMinutes * 60_000 <=
      nowMs
    ) {
      return { kind: "invalid", reason: "idle_timeout" }
    }

    return {
      kind: "valid",
      claims: claimsFromRow(row, idleTimeoutMinutes),
    }
  } catch (error) {
    return { kind: "unavailable", error }
  }
}

/**
 * Atomically record explicit activity only while the registry row is live.
 * GREATEST prevents an older concurrent request from moving activity backward.
 */
export async function advanceAuthSessionRecord(
  identity: SessionRegistryIdentity,
  idleTimeoutMinutesInput: unknown,
  nowMs: number,
): Promise<SessionRegistryResult> {
  if (!validIdentity(identity) || !Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { kind: "invalid", reason: "invalid_policy" }
  }

  const idleTimeoutMinutes = normalizeSessionIdleTimeoutMinutes(
    idleTimeoutMinutesInput,
  )
  const now = new Date(nowMs)

  try {
    const [row] = await db
      .update(authSessions)
      .set({
        lastActivityAt: sql`GREATEST(${authSessions.lastActivityAt}, ${now})`,
      })
      .where(
        and(
          eq(authSessions.id, identity.sessionId),
          eq(authSessions.subjectId, identity.subjectId),
          isNull(authSessions.revokedAt),
          gt(authSessions.absoluteExpiresAt, now),
          sql`${authSessions.lastActivityAt} + (${idleTimeoutMinutes} * INTERVAL '1 minute') > ${now}`,
        ),
      )
      .returning(registrySelection)

    if (!row) {
      return validateAuthSessionRecord(
        identity,
        idleTimeoutMinutes,
        nowMs,
      )
    }

    if (!rowMatchesIdentity(row, identity)) {
      await revokeAuthSessionRecord(identity.sessionId, identity.subjectId, nowMs)
      return { kind: "invalid", reason: "invalid_policy" }
    }

    logSessionLifecycle("activity_renewed", identity, {
      activityAt: row.lastActivityAt.toISOString(),
    })
    return {
      kind: "valid",
      claims: claimsFromRow(row, idleTimeoutMinutes),
    }
  } catch (error) {
    return { kind: "unavailable", error }
  }
}

export async function revokeAuthSessionRecord(
  sessionId: string,
  subjectId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (
    !validUuid(sessionId) ||
    typeof subjectId !== "string" ||
    subjectId.length === 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    return
  }

  await db
    .update(authSessions)
    .set({ revokedAt: new Date(nowMs) })
    .where(
      and(
        eq(authSessions.id, sessionId),
        eq(authSessions.subjectId, subjectId),
        isNull(authSessions.revokedAt),
      ),
    )
  logSessionLifecycle("revocation_processed", {
    sessionId,
    subjectId,
    organizationId: null,
  })
}

export async function revokeAuthSessionFromToken(
  token: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!token) return
  const sessionId = token.sessionId
  const subjectId = token.sub
  if (typeof sessionId !== "string" || typeof subjectId !== "string") return

  await revokeAuthSessionRecord(sessionId, subjectId)
}

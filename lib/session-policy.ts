/**
 * Edge-safe session policy primitives.
 *
 * The normal NextAuth JWT `exp` value is rolling: reading `/api/auth/session`
 * issues a new token and moves that expiry forward. These signed claims provide
 * the non-rolling security boundaries that the application enforces itself.
 */

export const SESSION_POLICY_VERSION = 1

// One to fifteen minutes lets a tenant choose a stricter value without ever
// weakening it during normalization; fifteen minutes is the global ceiling.
export const SESSION_IDLE_TIMEOUT_MINUTES_MIN = 1
export const SESSION_IDLE_TIMEOUT_MINUTES_MAX = 15
export const SESSION_IDLE_TIMEOUT_MINUTES_DEFAULT = 15

// Absolute lifetime is deliberately not tenant-configurable. A tenant may
// tighten its idle timeout, but cannot extend a login beyond one workday.
export const SESSION_ABSOLUTE_TIMEOUT_SECONDS = 8 * 60 * 60
export const SESSION_ABSOLUTE_TIMEOUT_MS = SESSION_ABSOLUTE_TIMEOUT_SECONDS * 1000

// Client activity updates use the native NextAuth session-update endpoint,
// which verifies a CSRF token before invoking the JWT callback.
export const SESSION_ACTIVITY_UPDATE_MARKER = "oneflowe-user-activity-v1"
export const SESSION_ACTIVITY_SYNC_INTERVAL_MS = 60_000

const MINUTE_MS = 60_000
const CLOCK_SKEW_TOLERANCE_MS = 60_000

export type SessionExpirationReason =
  | "absolute_timeout"
  | "idle_timeout"
  | "invalid_policy"

export type SessionPolicyClaims = {
  sessionPolicyVersion: number
  sessionStartedAt: number
  sessionLastActivityAt: number
  sessionIdleTimeoutMinutes: number
  sessionAbsoluteExpiresAt: number
  sessionInvalidReason?: SessionExpirationReason
}

type TokenLike = Record<string, unknown>

function numericSettingValue(value: unknown): number | null {
  if (typeof value === "number") return value
  if (typeof value !== "string" || value.trim() === "") return null

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Normalize both environment and tenant values into the enforced audit range.
 * Invalid data uses the supplied safe fallback; out-of-range numeric data is
 * clamped so a legacy value cannot disable or lengthen the security boundary.
 */
export function normalizeSessionIdleTimeoutMinutes(
  value: unknown,
  fallback: number = SESSION_IDLE_TIMEOUT_MINUTES_DEFAULT,
): number {
  const fallbackValue = numericSettingValue(fallback)
  const safeFallback =
    fallbackValue !== null && Number.isInteger(fallbackValue)
      ? Math.min(
          SESSION_IDLE_TIMEOUT_MINUTES_MAX,
          Math.max(SESSION_IDLE_TIMEOUT_MINUTES_MIN, fallbackValue),
        )
      : SESSION_IDLE_TIMEOUT_MINUTES_DEFAULT

  const parsed = numericSettingValue(value)
  if (parsed === null || !Number.isInteger(parsed)) return safeFallback

  return Math.min(
    SESSION_IDLE_TIMEOUT_MINUTES_MAX,
    Math.max(SESSION_IDLE_TIMEOUT_MINUTES_MIN, parsed),
  )
}

function isFiniteTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  )
}

function isExpirationReason(value: unknown): value is SessionExpirationReason {
  return (
    value === "absolute_timeout" ||
    value === "idle_timeout" ||
    value === "invalid_policy"
  )
}

export function readSessionPolicyClaims(
  token: TokenLike,
): SessionPolicyClaims | null {
  if (token.sessionPolicyVersion !== SESSION_POLICY_VERSION) return null
  if (!isFiniteTimestamp(token.sessionStartedAt)) return null
  if (!isFiniteTimestamp(token.sessionLastActivityAt)) return null
  if (!isFiniteTimestamp(token.sessionAbsoluteExpiresAt)) return null

  const idleTimeoutMinutes = token.sessionIdleTimeoutMinutes
  if (
    typeof idleTimeoutMinutes !== "number" ||
    !Number.isInteger(idleTimeoutMinutes) ||
    idleTimeoutMinutes < SESSION_IDLE_TIMEOUT_MINUTES_MIN ||
    idleTimeoutMinutes > SESSION_IDLE_TIMEOUT_MINUTES_MAX
  ) {
    return null
  }

  if (token.sessionLastActivityAt < token.sessionStartedAt) return null
  if (
    token.sessionAbsoluteExpiresAt <= token.sessionStartedAt ||
    token.sessionAbsoluteExpiresAt >
      token.sessionStartedAt + SESSION_ABSOLUTE_TIMEOUT_MS ||
    token.sessionLastActivityAt > token.sessionAbsoluteExpiresAt
  ) {
    return null
  }

  const invalidReason = token.sessionInvalidReason
  if (invalidReason !== undefined && !isExpirationReason(invalidReason)) {
    return null
  }

  return {
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    sessionStartedAt: token.sessionStartedAt,
    sessionLastActivityAt: token.sessionLastActivityAt,
    sessionIdleTimeoutMinutes: idleTimeoutMinutes,
    sessionAbsoluteExpiresAt: token.sessionAbsoluteExpiresAt,
    ...(invalidReason ? { sessionInvalidReason: invalidReason } : {}),
  }
}

export function getSessionExpirationReason(
  token: TokenLike,
  now: number = Date.now(),
): SessionExpirationReason | null {
  const boundaryReason = getSessionNonIdleExpirationReason(token, now)
  if (boundaryReason) return boundaryReason

  const claims = readSessionPolicyClaims(token)
  if (!claims) return "invalid_policy"

  const idleExpiresAt =
    claims.sessionLastActivityAt + claims.sessionIdleTimeoutMinutes * MINUTE_MS
  if (now >= idleExpiresAt) return "idle_timeout"

  return null
}

/**
 * Validate immutable policy integrity and the absolute deadline without using
 * the JWT's mutable activity claim. Server callbacks and edge middleware use
 * this before the monotonic server registry authoritatively checks idle time.
 */
export function getSessionNonIdleExpirationReason(
  token: TokenLike,
  now: number = Date.now(),
): SessionExpirationReason | null {
  const claims = readSessionPolicyClaims(token)
  if (!claims || !Number.isSafeInteger(now) || now <= 0) {
    return "invalid_policy"
  }

  if (claims.sessionInvalidReason) return claims.sessionInvalidReason

  if (
    claims.sessionStartedAt > now + CLOCK_SKEW_TOLERANCE_MS ||
    claims.sessionLastActivityAt > now + CLOCK_SKEW_TOLERANCE_MS
  ) {
    return "invalid_policy"
  }

  if (now >= claims.sessionAbsoluteExpiresAt) return "absolute_timeout"

  return null
}

export function getEffectiveSessionExpiresAt(token: TokenLike): number | null {
  const claims = readSessionPolicyClaims(token)
  if (!claims) return null

  return Math.min(
    claims.sessionAbsoluteExpiresAt,
    claims.sessionLastActivityAt + claims.sessionIdleTimeoutMinutes * MINUTE_MS,
  )
}

export function issueSessionPolicyClaims(
  now: number,
  idleTimeoutMinutes: unknown,
): SessionPolicyClaims {
  if (!Number.isSafeInteger(now) || now <= 0) {
    throw new TypeError("A valid server timestamp is required to issue a session")
  }

  return {
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    sessionStartedAt: now,
    sessionLastActivityAt: now,
    sessionIdleTimeoutMinutes:
      normalizeSessionIdleTimeoutMinutes(idleTimeoutMinutes),
    sessionAbsoluteExpiresAt: now + SESSION_ABSOLUTE_TIMEOUT_MS,
  }
}

/**
 * Advance an existing signed policy without ever resurrecting an expired one.
 *
 * The old policy is checked first (so increasing a setting cannot revive an
 * already-expired token), followed by the current tenant policy (so tightening
 * a setting applies immediately). Only then may authenticated activity renew
 * the idle timestamp.
 */
export function advanceSessionPolicyClaims<T extends TokenLike>(
  token: T,
  input: {
    now: number
    idleTimeoutMinutes: unknown
    recordActivity: boolean
  },
): T & SessionPolicyClaims {
  const existingReason = getSessionExpirationReason(token, input.now)
  if (existingReason) {
    return {
      ...token,
      sessionInvalidReason: existingReason,
    } as T & SessionPolicyClaims
  }

  const currentIdleTimeoutMinutes = normalizeSessionIdleTimeoutMinutes(
    input.idleTimeoutMinutes,
    token.sessionIdleTimeoutMinutes as number,
  )
  const policyWithCurrentTimeout = {
    ...token,
    sessionIdleTimeoutMinutes: currentIdleTimeoutMinutes,
  }

  const currentPolicyReason = getSessionExpirationReason(
    policyWithCurrentTimeout,
    input.now,
  )
  if (currentPolicyReason) {
    return {
      ...policyWithCurrentTimeout,
      sessionInvalidReason: currentPolicyReason,
    } as T & SessionPolicyClaims
  }

  return {
    ...policyWithCurrentTimeout,
    ...(input.recordActivity
      ? { sessionLastActivityAt: input.now }
      : {}),
  } as T & SessionPolicyClaims
}

export function isSessionActivityUpdate(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  return (
    (value as Record<string, unknown>).activity ===
    SESSION_ACTIVITY_UPDATE_MARKER
  )
}

/**
 * Pure account-lockout policy primitives.
 *
 * Split from the database-backed writers in `lib/server/auth-lockout.ts` the
 * same way `lib/session-policy.ts` is split from its server counterpart: the
 * decision logic carries no `server-only` import, so both the sign-in path and
 * its tests can evaluate it directly.
 */

/** Error surfaced to the sign-in page when an account is locked. */
export const ACCOUNT_LOCKED_ERROR = "ACCOUNT_LOCKED"

// PCI DSS 8.3.4 allows at most ten attempts before lockout and requires the
// lockout to last at least thirty minutes. These bounds are the enforced range,
// so no configuration value can relax the control.
export const LOCKOUT_THRESHOLD_MIN = 3
export const LOCKOUT_THRESHOLD_MAX = 10
export const LOCKOUT_DURATION_MINUTES_MIN = 30
export const LOCKOUT_DURATION_MINUTES_MAX = 1440

export type LockoutPrincipal =
  | { kind: "user"; id: string }
  | { kind: "employee"; id: number }

/** The lockout columns every provider selects alongside the password hash. */
export type LockoutState = {
  failedLoginAttempts?: number | null
  lockoutUntil: Date | null
}

export type LockoutDecision =
  | { locked: false }
  | { locked: true; until: Date; retryAfterSeconds: number }

/**
 * Decide whether an already-loaded account row is currently locked.
 *
 * A lockout timestamp in the past is simply expired, which is what gives the
 * account a fresh attempt budget without any scheduled cleanup job. A missing
 * or unparseable value is treated as unlocked rather than as a permanent lock,
 * so bad data can never strand a legitimate account.
 */
export function evaluateLockout(
  state: LockoutState | null | undefined,
  now: number = Date.now(),
): LockoutDecision {
  const until = state?.lockoutUntil
  if (!(until instanceof Date)) return { locked: false }

  const untilMs = until.getTime()
  if (!Number.isFinite(untilMs) || untilMs <= now) return { locked: false }

  return {
    locked: true,
    until,
    retryAfterSeconds: Math.ceil((untilMs - now) / 1000),
  }
}

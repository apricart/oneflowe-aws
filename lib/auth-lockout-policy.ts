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

// The enforced range for the per-account lockout. No configuration value may
// fall outside it, so a misconfigured secret store cannot relax the control
// further than the bounds here already allow.
//
// The attempt threshold still satisfies PCI DSS 8.3.4, which permits at most
// ten attempts before lockout.
//
// The duration floor does NOT. PCI DSS 8.3.4 requires a lockout of at least
// thirty minutes; this floor is five, set deliberately by the product owner so
// a user who mistypes a password is not locked out of the portal for half an
// hour. That is a knowing deviation from the standard, not an oversight -- the
// account is still locked, still audited (AUTH_ACCOUNT_LOCKED), and still
// refuses the password while locked, but the window an attacker must wait out
// between bursts is six times shorter. Raise this back to 30 if the platform
// is ever brought into scope for a PCI assessment.
export const LOCKOUT_THRESHOLD_MIN = 3
export const LOCKOUT_THRESHOLD_MAX = 10
export const LOCKOUT_DURATION_MINUTES_MIN = 5
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

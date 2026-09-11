import "server-only"

import { eq, ne, or, isNotNull, sql } from "drizzle-orm"
import { employeeCredentials, users } from "@/db/schema"
import { db } from "@/lib/db"
import { env } from "@/lib/server/env"
import type { LockoutPrincipal } from "@/lib/auth-lockout-policy"
import { isBruteForceProtectionEnforced } from "@/lib/auth-brute-force-mode"

/**
 * Database-backed per-account brute-force lockout (PCI DSS 8.3.4).
 *
 * Deliberately separate from the login rate limiter. That limiter is keyed on
 * the client address combined with the username, so an attacker who rotates
 * source addresses receives a fresh attempt budget against the same account.
 * These counters are keyed on the account alone, and live in Postgres rather
 * than Redis so a cache outage cannot silently disable the control.
 *
 * The pure decision logic lives in `@/lib/auth-lockout-policy`.
 */

export {
  ACCOUNT_LOCKED_ERROR,
  evaluateLockout,
  type LockoutDecision,
  type LockoutPrincipal,
  type LockoutState,
} from "@/lib/auth-lockout-policy"

export const LOCKOUT_THRESHOLD = env.AUTH_LOCKOUT_THRESHOLD
export const LOCKOUT_DURATION_MINUTES = env.AUTH_LOCKOUT_DURATION_MINUTES
const LOCKOUT_DURATION_MS = LOCKOUT_DURATION_MINUTES * 60_000

type FailureRow = { failedLoginAttempts: number | null; lockoutUntil: Date | null }

export type FailedLoginResult = {
  /** True only for the attempt that crossed the threshold. */
  lockedNow: boolean
  lockoutUntil: Date | null
  attempts: number
  threshold: number
}

function failureResult(row: FailureRow | undefined, lockUntil: Date): FailedLoginResult {
  const lockoutUntil = row?.lockoutUntil ?? null
  return {
    // The lock timestamp is computed per attempt, so an exact match identifies
    // the attempt that produced this lockout rather than an older one.
    lockedNow: lockoutUntil?.getTime() === lockUntil.getTime(),
    lockoutUntil,
    attempts: row?.failedLoginAttempts ?? 0,
    threshold: LOCKOUT_THRESHOLD,
  }
}

/**
 * Record one failed attempt and apply the lock if it crosses the threshold.
 *
 * Runs as a single UPDATE: every right-hand side reads the pre-update row, so
 * concurrent attempts cannot interleave into a lost increment the way a
 * read-then-write would.
 */
export async function registerFailedLogin(
  principal: LockoutPrincipal,
  now: Date = new Date(),
): Promise<FailedLoginResult> {
  // On the local development server the attempt is not counted at all, rather
  // than counted and forgiven: a stored counter would otherwise survive into a
  // later run against the same database and lock the account there. The caller
  // still audits the failed attempt -- only the lockout budget is skipped.
  if (!isBruteForceProtectionEnforced(env.NODE_ENV)) {
    return {
      lockedNow: false,
      lockoutUntil: null,
      attempts: 0,
      threshold: LOCKOUT_THRESHOLD,
    }
  }

  const lockUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS)

  if (principal.kind === "user") {
    const [row] = await db
      .update(users)
      .set({
        failedLoginAttempts: sql`CASE WHEN ${users.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN 0 ELSE ${users.failedLoginAttempts} + 1 END`,
        lockoutUntil: sql`CASE WHEN ${users.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN ${lockUntil} ELSE ${users.lockoutUntil} END`,
        lastFailedLoginAt: now,
      })
      .where(eq(users.id, principal.id))
      .returning({
        failedLoginAttempts: users.failedLoginAttempts,
        lockoutUntil: users.lockoutUntil,
      })
    return failureResult(row, lockUntil)
  }

  const [row] = await db
    .update(employeeCredentials)
    .set({
      failedLoginAttempts: sql`CASE WHEN ${employeeCredentials.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN 0 ELSE ${employeeCredentials.failedLoginAttempts} + 1 END`,
      lockoutUntil: sql`CASE WHEN ${employeeCredentials.failedLoginAttempts} + 1 >= ${LOCKOUT_THRESHOLD} THEN ${lockUntil} ELSE ${employeeCredentials.lockoutUntil} END`,
      lastFailedLoginAt: now,
    })
    .where(eq(employeeCredentials.id, principal.id))
    .returning({
      failedLoginAttempts: employeeCredentials.failedLoginAttempts,
      lockoutUntil: employeeCredentials.lockoutUntil,
    })
  return failureResult(row, lockUntil)
}

/**
 * Clear the counters after a fully successful authentication, or when an
 * administrator confirms the account holder's identity by resetting the
 * password.
 *
 * The WHERE clause skips the write for an account with nothing recorded, so a
 * normal login performs no write here. Returns true when something was cleared.
 */
export async function clearFailedLogins(
  principal: LockoutPrincipal,
): Promise<boolean> {
  if (principal.kind === "user") {
    const cleared = await db
      .update(users)
      .set({ failedLoginAttempts: 0, lockoutUntil: null })
      .where(
        sql`${eq(users.id, principal.id)} AND (${or(
          ne(users.failedLoginAttempts, 0),
          isNotNull(users.lockoutUntil),
        )})`,
      )
      .returning({ id: users.id })
    return cleared.length > 0
  }

  const cleared = await db
    .update(employeeCredentials)
    .set({ failedLoginAttempts: 0, lockoutUntil: null })
    .where(
      sql`${eq(employeeCredentials.id, principal.id)} AND (${or(
        ne(employeeCredentials.failedLoginAttempts, 0),
        isNotNull(employeeCredentials.lockoutUntil),
      )})`,
    )
    .returning({ id: employeeCredentials.id })
  return cleared.length > 0
}

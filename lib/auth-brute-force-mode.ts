/**
 * Where the sign-in brute-force controls are enforced.
 *
 * Two independent controls guard the sign-in path: the `login` rate limiter in
 * `lib/rate-limiter.ts` (keyed on client address + username, held in Redis) and
 * the per-account lockout in `lib/server/auth-lockout.ts` (keyed on the account
 * alone, held in Postgres, PCI DSS 8.3.4). Both exist to stop credential
 * stuffing against real tenants, and both are pointless friction against a
 * developer retyping a seeded demo password on their own machine.
 *
 * This module is the single place that decides, so the exemption cannot drift
 * apart between the two controls or be widened one call site at a time.
 *
 * The decision is deliberately `NODE_ENV`-only and reads no configuration
 * value, so no environment variable, secret store entry or request header can
 * turn the controls off in a running deployment. It is written as an
 * inequality against the one exempt value rather than an equality against
 * "production" so that an unset or unrecognised `NODE_ENV` still enforces:
 * the failure direction of this predicate is an unprotected login form, and
 * the only value that may point that way is one that `next dev` sets itself.
 */

/** The one environment that skips the sign-in brute-force controls. */
const EXEMPT_NODE_ENV = "development"

/** True when both sign-in brute-force controls apply. */
export function isBruteForceProtectionEnforced(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== EXEMPT_NODE_ENV
}

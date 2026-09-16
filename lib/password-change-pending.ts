/**
 * What a session that still owes a password change may reach.
 *
 * `users.must_change_password` travels in the JWT. The page proxy sends such a
 * session to `/change-password`; this module is the matching rule for the API,
 * where a redirect would be meaningless: every `/api/v1/*` request is refused
 * except the three the change itself needs. Kept pure and edge-safe because
 * `proxy.ts` imports it, and exported so a contract test can pin the list.
 */

export const PASSWORD_CHANGE_REQUIRED_CODE = "PASSWORD_CHANGE_REQUIRED"

export const PASSWORD_CHANGE_PENDING_API_ALLOWLIST: readonly string[] = [
  "/api/v1/users/me/change-password",
  "/api/v1/users/me/email-verification/send",
  "/api/v1/users/me/email-verification/verify",
]

/** Exact match after trailing-slash normalisation — never a prefix. */
export function isPasswordChangePendingApiPathAllowed(pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  return PASSWORD_CHANGE_PENDING_API_ALLOWLIST.includes(normalized)
}

/**
 * Whether a self-service password change must be preceded by an emailed code.
 *
 * The forced rotation (`plans/OF-KE-forced-password-rotation.md`) sends a
 * `VERIFY_EMAIL` code to the address on the account and accepts a new
 * password only after that code is entered back on the same session
 * (`lib/server/email-verification.ts`, `lib/server/password-change.ts`).
 * That proof is switched off for now at the client's request
 * (`plans/OF-KE-password-change-without-email-verification.md`): people who
 * could not reach the mailbox on their row were not getting past the page.
 *
 * Deliberately a constant in code rather than an environment variable, for
 * the reason `lib/auth-brute-force-mode.ts` gives: a security control that a
 * value in a secret store can turn off is one that drifts silently, whereas a
 * one-word change here goes through review and shows in history. Everything
 * the proof gated otherwise still applies — the current password, the policy,
 * new ≠ old, the flag, the `session_version` bump — and the audit row of every
 * change says whether the proof was taken. Set back to `"required"` to
 * re-enable; nothing else needs to change.
 *
 * Pure and import-free so the page can read it as well as the server.
 */

export type PasswordChangeEmailVerificationMode = "required" | "disabled"

/** The current setting. `lib/password-change-policy.test.ts` pins it. */
export const PASSWORD_CHANGE_EMAIL_VERIFICATION: PasswordChangeEmailVerificationMode = "disabled"

/** True when a password change must consume a fresh emailed proof on its session. */
export function isEmailVerificationRequiredForPasswordChange(
  mode: PasswordChangeEmailVerificationMode = PASSWORD_CHANGE_EMAIL_VERIFICATION,
): boolean {
  return mode === "required"
}

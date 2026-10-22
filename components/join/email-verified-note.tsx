import { MailCheck, MailWarning } from "lucide-react"

/**
 * Whether a join request's address was proven by an emailed code
 * (plans/OF-JOIN-email-otp-verification.md). Requests made before that step
 * existed, and addresses Head Office has since corrected, read "not verified".
 * Information for the reviewer only; approval does not depend on it.
 */
export function EmailVerifiedNote({ verified }: Readonly<{ verified: boolean }>) {
  return verified ? (
    <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-emerald-700 dark:text-emerald-400">
      <MailCheck className="h-3.5 w-3.5" aria-hidden="true" />
      Email verified
    </span>
  ) : (
    <span className="ml-2 inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-amber-700 dark:text-amber-400">
      <MailWarning className="h-3.5 w-3.5" aria-hidden="true" />
      Email not verified
    </span>
  )
}

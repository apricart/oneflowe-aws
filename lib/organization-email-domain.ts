/**
 * An organization's email domain — every rule that does not need a database.
 *
 * Super Admin sets the domain on the organization; the public join form then
 * fixes it as the suffix of the applicant's address, and the submit endpoint
 * refuses any address that is not at exactly that domain. The dialogs, the Zod
 * schemas, the join page and the endpoint all judge a domain here, so they
 * cannot disagree about what one looks like. The same pattern is pinned by
 * `organizations_email_domain_shape_ck`.
 *
 * The shapes are deliberately the subset `z.email()` accepts: a composed
 * address still has to pass `joinRequestSubmitSchema`, and nothing the form
 * lets an applicant type should then be refused for a reason they cannot see.
 */

/** The longest a DNS name may be. */
export const EMAIL_DOMAIN_MAX_LENGTH = 253

/** The longest the part before the `@` may be (RFC 5321). */
export const EMAIL_LOCAL_PART_MAX_LENGTH = 64

/**
 * Two or more dot-separated labels, each 1-63 characters of `[a-z0-9-]` that
 * neither starts nor ends with a dash, ending in an alphabetic top-level label.
 * Lower case only: it is applied to a normalised value.
 */
export const EMAIL_DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * Zod's own local-part rule: `[A-Za-z0-9_'+-.]`, not starting with a dot, no
 * two dots in a row, and ending in a character other than a dot or a quote.
 */
const EMAIL_LOCAL_PART_PATTERN = /^(?!\.)(?!.*\.\.)[A-Za-z0-9_'+\-.]*[A-Za-z0-9_+-]$/

/**
 * The one spelling of a domain.
 *
 * Trimmed and lower-cased, and a single leading `@` is dropped because an
 * administrator will reasonably type `@ke.com.pk`. Nothing else is rewritten:
 * a domain with a space or a second `@` in it is refused by `emailDomainError`
 * rather than silently repaired into something nobody typed.
 */
export function normalizeEmailDomain(value: unknown): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim().toLowerCase()
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed
}

/** Why a domain is unusable, or null when it is fine. Normalises first. */
export function emailDomainError(value: unknown): string | null {
  const domain = normalizeEmailDomain(value)
  if (domain.length === 0) return "Enter an email domain"
  if (domain.length > EMAIL_DOMAIN_MAX_LENGTH) {
    return `An email domain must be at most ${EMAIL_DOMAIN_MAX_LENGTH} characters`
  }
  if (domain.includes("@")) return "Enter only the domain, without a name or @ in it"
  if (!EMAIL_DOMAIN_PATTERN.test(domain)) {
    return "Enter a domain such as example.com — letters, numbers, dots and dashes only"
  }
  return null
}

/**
 * Why the part before the `@` is unusable, or null when it is fine.
 *
 * An `@` is refused rather than stripped. Someone who pastes
 * `name@gmail.com` into a field that ends in `@ke.com.pk` must be told, not
 * quietly handed `name@ke.com.pk` — which may be a different person's mailbox.
 */
export function emailLocalPartError(value: unknown): string | null {
  const localPart = typeof value === "string" ? value.trim() : ""
  if (localPart.length === 0) return "Enter your email address"
  if (localPart.includes("@")) {
    return "Enter only the part before the @ — the domain is filled in for you"
  }
  if (localPart.length > EMAIL_LOCAL_PART_MAX_LENGTH) {
    return `Use at most ${EMAIL_LOCAL_PART_MAX_LENGTH} characters before the @`
  }
  if (!EMAIL_LOCAL_PART_PATTERN.test(localPart)) {
    return "Use letters, numbers and . _ ' + - only, not starting or ending with a dot"
  }
  return null
}

/** The address the applicant is asking for, from what they typed and the domain. */
export function composeDomainEmail(localPart: string, domain: string): string {
  return `${localPart.trim().toLowerCase()}@${normalizeEmailDomain(domain)}`
}

/**
 * Whether an address is at exactly this domain.
 *
 * Exact on purpose: `mail.ke.com.pk`, `ke.com.pk.evil.test` and `evilke.com.pk`
 * are all refused for `ke.com.pk`. The domain is taken after the *last* `@`,
 * which is the one a mail server delivers to.
 */
export function emailMatchesDomain(email: string, domain: string): boolean {
  const expected = normalizeEmailDomain(domain)
  if (!expected) return false
  const at = email.lastIndexOf("@")
  if (at <= 0) return false
  return email.slice(at + 1).trim().toLowerCase() === expected
}

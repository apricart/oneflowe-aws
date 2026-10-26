/**
 * A branch's contact phone: the one number the branch is reached on.
 * See plans/OF-BRANCH-contact-phone.md.
 *
 * Nothing here imports a database or a session, so the create and edit forms
 * and the API hold the same rule and cannot disagree about it.
 */

/** The longest phone accepted; the width of `branches.contact_phone`. */
export const MAX_BRANCH_CONTACT_PHONE = 32

const ALLOWED_CHARACTERS = /^[0-9+()\-/. ]+$/
const MIN_DIGITS = 7
const MAX_DIGITS = 15

/** Trimmed, with runs of spaces collapsed to one. */
export function normalizeBranchContactPhone(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

/**
 * Whether a non-blank phone is acceptable: only digits, spaces and
 * `+ - ( ) / .`, at most `MAX_BRANCH_CONTACT_PHONE` characters, and 7 to 15
 * digits (a Pakistani mobile is 11, a landline with its area code 10 or 11,
 * an international number at most 15).
 */
export function isValidBranchContactPhone(value: string): boolean {
  const phone = normalizeBranchContactPhone(value)
  if (!phone || phone.length > MAX_BRANCH_CONTACT_PHONE) return false
  if (!ALLOWED_CHARACTERS.test(phone)) return false
  const digits = phone.replace(/\D/g, "").length
  return digits >= MIN_DIGITS && digits <= MAX_DIGITS
}

/**
 * What a form's phone field holds, as the value the API takes.
 *
 * Blank is `null` ("not provided"), which every branch created before this
 * field existed holds. An unacceptable number is `undefined`, so a form can
 * refuse to submit it rather than send something the server will reject.
 */
export function parseContactPhoneInput(raw: string): string | null | undefined {
  const phone = normalizeBranchContactPhone(raw)
  if (!phone) return null
  return isValidBranchContactPhone(phone) ? phone : undefined
}

export const BRANCH_CONTACT_PHONE_HINT =
  "Use digits, spaces and + - ( ) only, with 7 to 15 digits."

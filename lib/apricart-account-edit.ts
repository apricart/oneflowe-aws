/**
 * Super Admin edits an Apricart staff account — an Order Desk or warehouse
 * user — from its team page, and may set a new password for it. The request
 * goes to the shared `PATCH /api/v1/users/[id]`, which re-checks the caller,
 * re-validates every field (`userProfileUpdateSchema`) and, for a password,
 * ends the account's sessions. These rules only shape that request: only what
 * changed is sent, so an untouched field is never rewritten.
 */

export type AccountFields = {
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string
}

export type AccountRecord = {
  firstName: string | null
  lastName: string | null
  email: string
  username: string | null
  phone: string | null
}

export type AccountPatch = Partial<{
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string | null
  password: string
}>

export const ACCOUNT_PASSWORD_MIN_LENGTH = 12

export function accountFieldsFrom(record: AccountRecord): AccountFields {
  return {
    firstName: record.firstName ?? "",
    lastName: record.lastName ?? "",
    email: record.email,
    username: record.username ?? "",
    phone: record.phone ?? "",
  }
}

/** The server's password policy, so the form can say what is wrong before sending. */
export function accountPasswordProblem(password: string, confirmation: string): string | null {
  if (password.length < ACCOUNT_PASSWORD_MIN_LENGTH) return `The password must be at least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters`
  if (password.length > 128) return "The password must be at most 128 characters"
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    return "The password must include upper and lower case letters, a number and a symbol"
  }
  if (password !== confirmation) return "The two passwords do not match"
  return null
}

const REQUIRED: Array<[keyof AccountFields, string]> = [
  ["firstName", "First name"],
  ["lastName", "Last name"],
  ["email", "Email"],
  ["username", "Username"],
]

/**
 * The fields that changed, trimmed; a cleared phone is sent as null. A
 * required field may not be cleared. `newPassword` is null when no new
 * password is being set.
 */
export function buildAccountPatch(
  initial: AccountFields,
  form: AccountFields,
  newPassword: { password: string; confirmation: string } | null,
): { ok: true; patch: AccountPatch } | { ok: false; error: string } {
  const patch: AccountPatch = {}
  for (const [key, label] of REQUIRED) {
    const next = form[key].trim()
    if (next === initial[key].trim()) continue
    if (!next) return { ok: false, error: `${label} is required` }
    patch[key] = next
  }
  const phone = form.phone.trim()
  if (phone !== initial.phone.trim()) patch.phone = phone || null

  if (newPassword) {
    const problem = accountPasswordProblem(newPassword.password, newPassword.confirmation)
    if (problem) return { ok: false, error: problem }
    patch.password = newPassword.password
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "Nothing has changed" }
  return { ok: true, patch }
}

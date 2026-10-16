/**
 * The organization prefix on a new account's username
 * (plans/OF-USERS-organization-username-prefix.md).
 *
 * A username signs in on its own — the login asks for no organization — so it
 * stays unique across every tenant (`users_username_idx`). The prefix is what
 * lets two tenants each have a `huzaifa.abid`: `ubl-huzaifa.abid` and
 * `mee-huzaifa.abid` are different usernames.
 *
 * The prefix is derived from the organization's name, at most three letters
 * or digits, lower-cased:
 *
 *   * several words → the first letter of each of the first three
 *     ("United Bank Limited" → `ubl`, "K-Electric" → `ke`, "K-E-Demo" → `ked`);
 *   * one word → its first three characters ("Meezan" → `mee`);
 *   * no letter or digit at all → no prefix.
 *
 * Two organizations can derive the same prefix. That is accepted: the global
 * unique index still refuses a clash, and the clash is reported as a taken
 * username like any other. Renaming an organization changes the prefix of the
 * accounts created after the rename; existing usernames are never rewritten.
 *
 * Pure: the pages compose it to show the username that will be created, and
 * the server composes it again from the organization row it reads itself.
 */

export const USERNAME_PREFIX_MAX_LENGTH = 3
export const USERNAME_PREFIX_SEPARATOR = "-"
/** `users.username` is varchar(255). */
export const USERNAME_MAX_LENGTH = 255
/** The longest username that may be typed for a prefixed account, so prefix and all still fit. */
export const USERNAME_BASE_MAX_LENGTH = USERNAME_MAX_LENGTH - USERNAME_PREFIX_MAX_LENGTH - USERNAME_PREFIX_SEPARATOR.length

/** The prefix an organization's new usernames take, or "" when its name gives none. */
export function organizationUsernamePrefix(organizationName: string | null | undefined): string {
  const words = String(organizationName ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return ""
  if (words.length === 1) return words[0].slice(0, USERNAME_PREFIX_MAX_LENGTH)
  return words.slice(0, USERNAME_PREFIX_MAX_LENGTH).map((word) => word[0]).join("")
}

/**
 * A username with the organization's prefix: `<prefix>-<username>`, lower-cased.
 * A username that already carries this prefix is returned as it is, so
 * composing twice — once on the page, once on the server — adds it once.
 */
export function prefixedUsername(prefix: string, username: string): string {
  const base = username.trim().toLowerCase()
  if (!prefix || !base) return base
  const lead = `${prefix}${USERNAME_PREFIX_SEPARATOR}`
  return base.startsWith(lead) ? base : `${lead}${base}`
}

/** The part typed after the prefix: what a prefixed input box should show for `username`. */
export function withoutUsernamePrefix(prefix: string, username: string): string {
  const base = username.trim().toLowerCase()
  const lead = `${prefix}${USERNAME_PREFIX_SEPARATOR}`
  return prefix && base.startsWith(lead) ? base.slice(lead.length) : base
}

/** The username a new account of this organization gets. */
export function organizationUsername(organizationName: string | null | undefined, username: string): string {
  return prefixedUsername(organizationUsernamePrefix(organizationName), username)
}

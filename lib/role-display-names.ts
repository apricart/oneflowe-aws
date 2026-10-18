/**
 * What people are shown for the four tenant roles that were renamed, and for
 * the two storefronts those roles order through.
 *
 * Display only. The role codes (`BRANCH_ADMIN`, `GROUP_USER`, `ORDER_PORTAL`,
 * `GROUP_ORDER_PORTAL`) are what the database, the session, the permissions and
 * every rule key on, and they are unchanged: never compare against, parse, or
 * store one of these strings. Every label map that names one of these roles
 * reads it from here, so a later rename is one edit.
 */
export const ROLE_DISPLAY_NAMES = Object.freeze({
  BRANCH_ADMIN: "Financial Approver",
  GROUP_USER: "Group Financial Approver",
  ORDER_PORTAL: "Order Initiator",
  GROUP_ORDER_PORTAL: "Group Order Initiator",
} as const)

/** The `/shop` storefront, used by the Order Initiator. */
export const ORDER_PORTAL_NAME = "Order Initiator Portal"

/** The `/group-portal` storefront, used by the Group Order Initiator. */
export const GROUP_ORDER_PORTAL_NAME = "Group Order Initiator Portal"

/**
 * The display name of a renamed role, or null for any other role (or none), so
 * a screen that builds a label from the role code can keep doing that for the
 * roles that were not renamed.
 */
export function renamedRoleName(role: string | null | undefined): string | null {
  if (!role || !Object.prototype.hasOwnProperty.call(ROLE_DISPLAY_NAMES, role)) return null
  return ROLE_DISPLAY_NAMES[role as keyof typeof ROLE_DISPLAY_NAMES]
}

/**
 * The one-time "role names have changed" notice shown after sign-in
 * (plans/OF-ROLES-rename-role-display-names.md).
 *
 * Presentation only: what a person is told decides nothing, and the role codes
 * behind the names are unchanged. The login page marks the notice due when a
 * sign-in succeeds; the first landing page that mounts the notice shows it and
 * clears the mark when it is closed, so it appears once per sign-in and never
 * in the middle of a session. The mark lives in `sessionStorage`; when storage
 * is blocked the notice simply does not appear.
 */

import { ROLE_DISPLAY_NAMES } from "@/lib/role-display-names"

/** Switch the notice off here once people are used to the new names. */
export const ROLE_RENAME_NOTICE_ENABLED = true

export const ROLE_RENAME_NOTICE_STORAGE_KEY = "oneflowe.roleRenameNotice"

type RenamedRole = keyof typeof ROLE_DISPLAY_NAMES

/** What these roles were called before the rename. */
export const PREVIOUS_ROLE_NAMES: Readonly<Record<RenamedRole, string>> = Object.freeze({
  BRANCH_ADMIN: "Branch Admin",
  ORDER_PORTAL: "Order Portal",
  GROUP_USER: "Group User",
  GROUP_ORDER_PORTAL: "Group Order Portal",
})

export type RoleRename = Readonly<{ role: RenamedRole; previousName: string; newName: string }>

const BRANCH_RENAMES: readonly RenamedRole[] = ["BRANCH_ADMIN", "ORDER_PORTAL"]
const GROUP_RENAMES: readonly RenamedRole[] = ["GROUP_USER", "GROUP_ORDER_PORTAL"]

function renamesOf(roles: readonly RenamedRole[]): readonly RoleRename[] {
  return roles.map((role) => ({
    role,
    previousName: PREVIOUS_ROLE_NAMES[role],
    newName: ROLE_DISPLAY_NAMES[role],
  }))
}

/**
 * The renames a person is told about: the two group roles see the two group
 * renames, the two branch roles see the two branch renames, and everyone else
 * (Head Office, Super Admin and every other role) sees all four.
 */
export function roleRenamesToAnnounce(role: string | null | undefined): readonly RoleRename[] {
  if (role === "GROUP_USER" || role === "GROUP_ORDER_PORTAL") return renamesOf(GROUP_RENAMES)
  if (role === "BRANCH_ADMIN" || role === "ORDER_PORTAL") return renamesOf(BRANCH_RENAMES)
  return renamesOf([...BRANCH_RENAMES, ...GROUP_RENAMES])
}

function sessionStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

/** Called by the login page when a sign-in succeeds. */
export function markRoleRenameNoticeDue(): void {
  if (!ROLE_RENAME_NOTICE_ENABLED) return
  try {
    sessionStore()?.setItem(ROLE_RENAME_NOTICE_STORAGE_KEY, "due")
  } catch {
    // Storage can be blocked; the notice is then not shown.
  }
}

export function isRoleRenameNoticeDue(): boolean {
  if (!ROLE_RENAME_NOTICE_ENABLED) return false
  try {
    return sessionStore()?.getItem(ROLE_RENAME_NOTICE_STORAGE_KEY) === "due"
  } catch {
    return false
  }
}

export function clearRoleRenameNoticeDue(): void {
  try {
    sessionStore()?.removeItem(ROLE_RENAME_NOTICE_STORAGE_KEY)
  } catch {
    // Nothing to clear when storage is blocked.
  }
}

/**
 * Which shell the support area wears.
 *
 * `/support` is shared by every role, and that is why it originally carried its
 * own minimal chrome: an `ORDER_PORTAL` user reaching it from `/shop` must not
 * suddenly find themselves inside the administrator's navigation.
 *
 * The reason holds; the *unconditional* application of it did not. A role that
 * has a sidebar everywhere else lost it on this one page and could only get
 * back through a "Back to dashboard" link. So the shell is chosen per role:
 * whoever the sidebar builds a menu for keeps that menu here.
 *
 * The list below must agree with `getNavigationByRole` in
 * `components/shell/sidebar.tsx` — that function is where a role does or does
 * not get a `/support` entry, and an entry that leads somewhere menu-less is
 * the bug this module exists to prevent. `support-shell.test.ts` reads the
 * sidebar and fails if the two disagree.
 *
 * Pure: no session, no request, no database. Presentation only — wearing the
 * sidebar grants nothing, `lib/support-access.ts` decides what may be read.
 */

/** Roles that keep the portal chrome (sidebar and topbar) inside `/support`. */
export const SUPPORT_PORTAL_SHELL_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
] as const

export type SupportPortalShellRole = (typeof SUPPORT_PORTAL_SHELL_ROLES)[number]

/**
 * Does this role read `/support` inside the portal chrome?
 *
 * False for `ORDER_PORTAL` and `GROUP_ORDER_PORTAL`, whose home is `/shop` and
 * `/group-portal`; they keep the minimal shell. False for an unknown or absent
 * role too — the safe answer is the shell that assumes nothing.
 */
export function supportUsesPortalShell(role: string | null | undefined): boolean {
  return (
    typeof role === "string" &&
    SUPPORT_PORTAL_SHELL_ROLES.includes(role as SupportPortalShellRole)
  )
}

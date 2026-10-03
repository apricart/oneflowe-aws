/**
 * Which roles wear the portal chrome — the sidebar and topbar — on a page that
 * is shared between portals.
 *
 * A shared area (`/support`, `/delivery-addresses`) is reached from the admin
 * shell, from `/shop` and from `/group-portal`. Two rules pull against each
 * other there, and this list is where they are reconciled once:
 *
 *   * an `ORDER_PORTAL` or `GROUP_ORDER_PORTAL` user has no sidebar anywhere
 *     else and must not suddenly find themselves inside the administrator's
 *     navigation;
 *   * a role that *does* have a sidebar everywhere else must not lose it on
 *     one page and be left with no way back except a link.
 *
 * So: whoever the sidebar builds a menu for keeps that menu on a shared page.
 *
 * The list must agree with `getNavigationByRole` in
 * `components/shell/sidebar.tsx` — that function is where a role does or does
 * not get an entry, and an entry that leads somewhere menu-less is the bug this
 * module exists to prevent.
 *
 * Pure: no session, no request, no database. **Presentation only** — wearing
 * the sidebar grants nothing. What a caller may read on a shared page is
 * decided by that page's own access module on its endpoints.
 */

/** Roles that keep the portal chrome on a page shared between portals. */
export const PORTAL_CHROME_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
] as const

export type PortalChromeRole = (typeof PORTAL_CHROME_ROLES)[number]

/**
 * Does this role read a shared page inside the portal chrome?
 *
 * False for `ORDER_PORTAL` and `GROUP_ORDER_PORTAL`, whose home is `/shop` and
 * `/group-portal`; they keep the minimal shell. False for an unknown or absent
 * role too — the safe answer is the shell that assumes nothing.
 */
export function usesPortalChrome(role: string | null | undefined): boolean {
  return (
    typeof role === "string" &&
    PORTAL_CHROME_ROLES.includes(role as PortalChromeRole)
  )
}

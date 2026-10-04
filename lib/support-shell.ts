import { usesPortalChrome, type PortalChromeRole } from "@/lib/portal-chrome"

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
 * That rule is not particular to support — `/delivery-addresses` is shared for
 * the same reason and answers it the same way — so the list itself now lives in
 * `lib/portal-chrome.ts` and this module is the support-shaped name for it.
 * The names below are kept because callers and `support-shell.test.ts` use
 * them; that test reads the sidebar and fails if the two disagree about
 * `/support`.
 *
 * Pure: no session, no request, no database. Presentation only — wearing the
 * sidebar grants nothing, `lib/support-access.ts` decides what may be read.
 */

/** Roles that keep the portal chrome (sidebar and topbar) inside `/support`. */
export { PORTAL_CHROME_ROLES as SUPPORT_PORTAL_SHELL_ROLES } from "@/lib/portal-chrome"

export type SupportPortalShellRole = PortalChromeRole

/**
 * Does this role read `/support` inside the portal chrome?
 *
 * False for `ORDER_PORTAL` and `GROUP_ORDER_PORTAL`, whose home is `/shop` and
 * `/group-portal`; they keep the minimal shell. False for an unknown or absent
 * role too — the safe answer is the shell that assumes nothing.
 */
export function supportUsesPortalShell(role: string | null | undefined): boolean {
  return usesPortalChrome(role)
}

import { NextResponse, type NextRequest } from "next/server"
import { logger } from "@/lib/utils"
import { getToken } from "next-auth/jwt"
import { edgeEnv } from "@/lib/edge/env"
import {
  isCookieAuthenticatedMutationAllowed,
  isKnownBodyTooLarge,
  requestBodyLimitForPath,
} from "@/lib/edge/request-security"
import { getSessionNonIdleExpirationReason } from "@/lib/session-policy"
import {
  isPasswordChangePendingApiPathAllowed,
  PASSWORD_CHANGE_REQUIRED_CODE,
} from "@/lib/password-change-pending"
import {
  isViewerApiRequestAllowed,
  isViewerAreaAllowed,
  isViewerRole,
  VIEWER_HOME,
} from "@/lib/viewer-access"
import {
  DESK_TEAM_AREA,
  isOrderDeskApiRequestAllowed,
  isOrderDeskRole,
  ORDER_DESK_AREAS,
  ORDER_DESK_HOME,
  ORDER_DESK_MANAGER_ROLES,
} from "@/lib/order-desk-access"
import { ACTIVITY_LOG_ROLES } from "@/lib/activity-log-access"
import { CONSOLIDATED_INVOICE_REPORT_AREA, CONSOLIDATED_INVOICE_REPORT_ROLES } from "@/lib/consolidated-invoice-access"
import {
  APRICART_EXECUTIVE_AREAS,
  APRICART_EXECUTIVE_HOME,
  DELIVERY_DASHBOARD_AREA,
  isApricartExecutiveApiRequestAllowed,
  isApricartExecutiveRole,
} from "@/lib/apricart-executive-access"
import {
  WAREHOUSE_AREAS,
  WAREHOUSE_HOME,
  WAREHOUSE_MANAGER_ROLES,
  WAREHOUSE_TEAM_AREA,
  isWarehouseApiRequestAllowed,
  isWarehouseRole,
} from "@/lib/warehouse-access"
import {
  APRICART_SUPPORT_AREAS,
  APRICART_SUPPORT_HOME,
  isApricartSupportApiRequestAllowed,
  isApricartSupportRole,
} from "@/lib/apricart-support-access"
import {
  HEAD_COUNT_REQUESTS_AREA,
  HEAD_COUNT_REQUEST_READ_ROLES,
} from "@/lib/branch-head-count-access"

const protectedPrefixes = [
  // The activity log was gated in ROLE_GATED_AREAS but missing here, so the
  // gate never ran for it; the page and its endpoint check regardless.
  "/activity",
  "/approvals",
  "/branches",
  "/branch-inventory",
  "/budgets",
  "/budget-by-quantity",
  "/change-password",
  "/dashboard",
  // A shared area rather than a role-gated one: five roles reach it across
  // three portals. Its layout refuses the rest through
  // `canReadDeliveryAddresses`, and every handler behind it re-checks.
  "/delivery-addresses",
  "/delivery-dashboard",
  "/desk-team",
  "/employee-management",
  "/executive",
  "/group-portal",
  "/groups",
  // Branch head count requests: raised by Branch Admin / Group User, decided by
  // Head Office. Gated to those three in ROLE_GATED_AREAS below.
  HEAD_COUNT_REQUESTS_AREA,
  "/inventory",
  "/invoices",
  "/join-requests",
  "/order-desk",
  "/orders",
  "/organizations",
  "/products",
  "/receipts",
  "/refunds",
  "/reports",
  "/settings",
  "/shop",
  "/support",
  "/warehouse",
  "/warehouse-team",
  "/users",
]
const SESSION_COOKIE_NAMES = [
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
]

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

function expiredSessionRedirect(req: NextRequest): NextResponse {
  const url = new URL("/login", req.url || "http://localhost")
  url.searchParams.set("reason", "session-expired")
  const response = NextResponse.redirect(url)

  const cookiesToDelete = new Set(SESSION_COOKIE_NAMES)
  for (const cookie of req.cookies.getAll()) {
    if (
      SESSION_COOKIE_NAMES.some(
        (baseName) =>
          cookie.name === baseName || cookie.name.startsWith(`${baseName}.`),
      )
    ) {
      cookiesToDelete.add(cookie.name)
    }
  }

  for (const cookieName of cookiesToDelete) {
    response.cookies.set({
      name: cookieName,
      value: "",
      expires: new Date(0),
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: cookieName.startsWith("__Secure-"),
    })
  }

  return response
}

/**
 * Inject application security headers into every response
 */
function withSecurityHeaders(response: NextResponse, pathname: string = ""): NextResponse {
  // HSTS — force HTTPS for 1 year + subdomains
  response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  // Clickjacking protection — prevent framing entirely
  response.headers.set("X-Frame-Options", "DENY")
  // Prevent MIME-type sniffing
  response.headers.set("X-Content-Type-Options", "nosniff")
  // Modern XSS protection (rely on CSP, disable legacy filter)
  response.headers.set("X-XSS-Protection", "0")
  // Control referrer information
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  // Disable dangerous browser features
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
  // Content Security Policy
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://vitals.vercel-insights.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "media-src 'self'",
      ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
    ].join("; ")
  )
  // Remove server identification
  response.headers.delete("X-Powered-By")

  // Browsing Cache (Browser Caching)
  if (
    pathname.startsWith("/api/v1/") ||
    protectedPrefixes.some((prefix) => pathMatchesPrefix(pathname, prefix))
  ) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0")
  }

  return response
}

async function handleApiRequest(req: NextRequest, pathname: string, response: NextResponse): Promise<NextResponse> {
  const allowedMutation = isCookieAuthenticatedMutationAllowed({
    method: req.method,
    requestUrl: req.url,
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    cookieHeader: req.headers.get("cookie"),
  })
  if (!allowedMutation) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 }),
      pathname,
    )
  }

  const maximumBytes = requestBodyLimitForPath(pathname)
  if (isKnownBodyTooLarge(req.headers.get("content-length"), maximumBytes)) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Request body too large" }, { status: 413 }),
      pathname,
    )
  }

  // A session that still owes a password change reaches only the endpoints
  // that change it. The page branch below redirects; here a redirect would be
  // meaningless, so the request is refused. The claim is signed, and the
  // change endpoint demands its own proof besides, so the handlers do not
  // depend on this check alone.
  const token = await getToken({ req, secret: edgeEnv.NEXTAUTH_SECRET })
  if (
    (token as any)?.mustChangePassword === true &&
    !isPasswordChangePendingApiPathAllowed(pathname)
  ) {
    logger("middleware", { reason: "password_change_required", path: pathname })
    return withSecurityHeaders(
      NextResponse.json(
        { error: "Password change required", code: PASSWORD_CHANGE_REQUIRED_CODE },
        { status: 403 },
      ),
      pathname,
    )
  }

  // An Order Desk account has no organization of its own, and most handlers
  // check roles inline, where a missing organization can read as "no tenant
  // filter". So the desk reaches only the API calls its workspace makes, and
  // everything else is refused here before any handler runs. Each admitted
  // handler still checks the role and the desk's reach itself — this layer is
  // in addition to that, never instead of it.
  if (isOrderDeskRole((token as any)?.role) && !isOrderDeskApiRequestAllowed(req.method, pathname)) {
    logger("middleware", { reason: "order_desk_api_not_allowed", path: pathname })
    return withSecurityHeaders(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      pathname,
    )
  }
  // The same confinement for Apricart's management account, which also has no
  // organization of its own: the delivery dashboard reads and nothing else.
  if (
    isApricartExecutiveRole((token as any)?.role)
    && !isApricartExecutiveApiRequestAllowed(req.method, pathname)
  ) {
    logger("middleware", { reason: "apricart_executive_api_not_allowed", path: pathname })
    return withSecurityHeaders(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      pathname,
    )
  }
  // A Viewer changes nothing: it reads, and it may change its own password.
  // Every write handler refuses the role on its own; this refuses the rest of
  // the write API before any handler runs, so a handler that forgot to is not
  // the only thing standing between a read-only account and a change.
  if (isViewerRole((token as any)?.role) && !isViewerApiRequestAllowed(req.method, pathname)) {
    logger("middleware", { reason: "viewer_write_not_allowed", path: pathname })
    return withSecurityHeaders(
      NextResponse.json({ error: "Forbidden: this account is view only" }, { status: 403 }),
      pathname,
    )
  }
  // And for Apricart's warehouse, which also has no organization of its own:
  // its queue, its progress write and the challan upload, nothing else.
  if (isWarehouseRole((token as any)?.role) && !isWarehouseApiRequestAllowed(req.method, pathname)) {
    logger("middleware", { reason: "warehouse_api_not_allowed", path: pathname })
    return withSecurityHeaders(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      pathname,
    )
  }
  // And for Apricart's support agents, which also have no organization of
  // their own: the support queue's calls, nothing else.
  if (isApricartSupportRole((token as any)?.role) && !isApricartSupportApiRequestAllowed(req.method, pathname)) {
    logger("middleware", { reason: "apricart_support_api_not_allowed", path: pathname })
    return withSecurityHeaders(
      NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      pathname,
    )
  }
  return withSecurityHeaders(response, pathname)
}

const ADMIN_PORTAL_ROLES = new Set(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])

/**
 * The approver works inside the admin shell so it gets the same sidebar and
 * topbar, but it is not an administrator: it may reach the dashboard and order
 * directory for the branches assigned to it, its own approval queue, the
 * reports those assignments scope, optionally the money budgets of those same branches,
 * and settings. Every other shell area — organizations, users, inventory,
 * branches, quantity budgets — stays closed, and this allowlist fails closed
 * for anything not named in it.
 *
 * The dashboard and the order directory are pages shared with the
 * administrators. Reaching a shared page is not the same as reading another
 * branch's rows: every endpoint behind them resolves this role's branch set
 * from its own assignments on the server, so this allowlist widens which pages
 * render and never which data they return.
 */
const GROUP_USER_HOME = "/dashboard"
const GROUP_USER_AREAS = [
  "/approvals",
  "/budgets",
  "/dashboard",
  // It asks Head Office to set the head count of the branches assigned to it.
  HEAD_COUNT_REQUESTS_AREA,
  "/orders",
  "/reports",
  "/settings",
]

// The approval area belongs to the approver alone; an administrator that lands
// on it is sent back to its own dashboard.
const APPROVALS_AREA = "/approvals"

// The multi-branch ordering workspace is the requester's own area.
const GROUP_ORDER_PORTAL_HOME = "/group-portal"

/**
 * The invoice page is reached from more than one portal — the admin orders
 * directory and the employee store both link to it — so it is not owned by a
 * single role's area. Which invoice a caller may actually read is decided by
 * `lib/server/invoice-access.ts` on the endpoints behind the page, which
 * enforces organization isolation, branch scope, and per-user ownership; this
 * allowlist only stops the shell from bouncing the request home first.
 */
const INVOICE_AREA = "/invoices"

function isInvoiceArea(pathname: string): boolean {
  return pathMatchesPrefix(pathname, INVOICE_AREA)
}

/**
 * The support area is shared by every role for the same reason the invoice page
 * is: a client raises a query from whichever portal they live in, and Apricart
 * answers from the admin shell. Which threads a caller may actually read is
 * decided by `lib/support-access.ts` on the endpoints behind the page — this
 * allowlist only stops the shell bouncing the request home first.
 */
const SUPPORT_AREA = "/support"

function isSupportArea(pathname: string): boolean {
  return pathMatchesPrefix(pathname, SUPPORT_AREA)
}

/**
 * Delivery addresses are shared for the same reason: the branch that needs an
 * extra destination lives in `/shop` or `/group-portal`, and the Head Office
 * that approves it lives in the admin shell, so no single role's area owns the
 * page. Which addresses a caller may see and whether they may decide one is
 * settled by `lib/delivery-address-access.ts` on the handlers behind it and by
 * a branch set re-resolved from the session on every call — this allowlist only
 * stops the shell bouncing the request home first.
 */
const DELIVERY_ADDRESS_AREA = "/delivery-addresses"

function isDeliveryAddressArea(pathname: string): boolean {
  return pathMatchesPrefix(pathname, DELIVERY_ADDRESS_AREA)
}

function isSharedPortalArea(pathname: string): boolean {
  return isInvoiceArea(pathname) || isSupportArea(pathname) || isDeliveryAddressArea(pathname)
}

/** Group User areas that open only with the account's budget allocation grant. */
const GROUP_USER_BUDGET_AREAS = ["/budgets", "/reports/budget-summary"]

function groupUserRedirect(pathname: string, budgetAllocationEnabled: boolean): string | null {
  const isBudgetArea = GROUP_USER_BUDGET_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
  if (isBudgetArea && !budgetAllocationEnabled) return GROUP_USER_HOME
  const allowed = isSharedPortalArea(pathname)
    || GROUP_USER_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
  return allowed ? null : GROUP_USER_HOME
}

function adminPortalRedirect(pathname: string): string | null {
  const outsideAdminPortal = pathname.startsWith("/shop")
    || pathname.startsWith("/group-portal")
    || pathMatchesPrefix(pathname, APPROVALS_AREA)
  return outsideAdminPortal ? "/dashboard" : null
}

/**
 * Roles confined to one area of their own and no shared page at all.
 *
 *   * VIEWER — read-only: Head Office's pages when organization-wide, its
 *     dashboard alone when pinned to a branch (`isViewerAreaAllowed`). Every
 *     endpoint behind them re-checks, and refuses it any write.
 *   * ORDER_DESK — Apricart's order entry: its workspace, and not the invoice
 *     or support pages, which are scoped to a tenant it does not belong to.
 *   * APRICART_EXECUTIVE — Apricart's management: the delivery dashboard and
 *     nothing else, for the same reason.
 *   * WAREHOUSE — Apricart's warehouse: its delivery queue, for the same reason.
 *   * APRICART_SUPPORT — Apricart's support agents: the shared support pages and
 *     nothing else. Which threads it reads is `lib/support-access.ts`.
 */
type TenantClaims = { organizationId: unknown; branchId: unknown }

function withinAreas(areas: readonly string[]): (pathname: string) => boolean {
  return (pathname) => areas.some((prefix) => pathMatchesPrefix(pathname, prefix))
}

const SINGLE_AREA_ROLES: ReadonlyArray<{
  matches: (role: unknown) => boolean
  allows: (pathname: string, tenant: TenantClaims) => boolean
  home: string
}> = [
  { matches: isViewerRole, allows: isViewerAreaAllowed, home: VIEWER_HOME },
  { matches: isOrderDeskRole, allows: withinAreas(ORDER_DESK_AREAS), home: ORDER_DESK_HOME },
  { matches: isApricartExecutiveRole, allows: withinAreas(APRICART_EXECUTIVE_AREAS), home: APRICART_EXECUTIVE_HOME },
  { matches: isWarehouseRole, allows: withinAreas(WAREHOUSE_AREAS), home: WAREHOUSE_HOME },
  { matches: isApricartSupportRole, allows: withinAreas(APRICART_SUPPORT_AREAS), home: APRICART_SUPPORT_HOME },
]

/**
 * The portal each role is confined to, or null when the path is already inside
 * it. Each restricted role owns exactly one area and is redirected home from
 * everywhere else; /change-password stays reachable so a forced password change
 * can complete.
 *
 * ORDER_PORTAL -> /shop and the group roles -> /group-portal are mutually
 * exclusive: neither can reach the other's area or the admin shell.
 */
function rolePortalRedirect(
  role: string | undefined,
  pathname: string,
  budgetAllocationEnabled = false,
  tenant: TenantClaims = { organizationId: null, branchId: null },
): string | null {
  if (pathname.startsWith("/change-password")) return null

  if (role === "ORDER_PORTAL") {
    // The store links each fulfilled order to its invoice, so the invoice page
    // stays reachable, as does the shared support area it raises queries from;
    // everything else still funnels back to /shop.
    return pathname.startsWith("/shop") || isSharedPortalArea(pathname) ? null : "/shop"
  }
  if (role === "GROUP_USER") {
    return groupUserRedirect(pathname, budgetAllocationEnabled)
  }
  const confined = SINGLE_AREA_ROLES.find((entry) => entry.matches(role))
  if (confined) {
    return confined.allows(pathname, tenant) ? null : confined.home
  }
  if (role === "GROUP_ORDER_PORTAL") {
    // The requester keeps its own workspace and never reaches the admin shell,
    // the approver's queue, or the single-branch /shop. Its order history links
    // to the invoice page, and the support area is shared by every role; both
    // are scoped per row on their own endpoints rather than by area.
    return pathname.startsWith(GROUP_ORDER_PORTAL_HOME)
      || isInvoiceArea(pathname)
      || isSupportArea(pathname)
      // It requests delivery addresses for the branches it orders for, so it
      // reaches the page those requests are raised on.
      || isDeliveryAddressArea(pathname)
      ? null
      : GROUP_ORDER_PORTAL_HOME
  }
  if (role && ADMIN_PORTAL_ROLES.has(role)) {
    // Strict separation: administrators belong in the dashboard shell only, and
    // the approval queue is not theirs.
    return adminPortalRedirect(pathname)
  }
  return null
}

/**
 * Shell areas that belong to one role, checked after `rolePortalRedirect` has
 * confined each role to its own portal.
 *
 * Navigation only. Every one of these areas re-checks server-side in its route
 * handlers or its page layout, and this table never replaces that:
 *   * `/organizations` — Super Admin's platform administration.
 *   * `/activity` — the activity log, for Super Admin (every tenant) and Head
 *     Office (its own); what it *returns* is decided by
 *     `lib/activity-log-access.ts`.
 *   * `/branches` — Head Office's own branch administration.
 *   * `/join-requests` — the tenant's join code and join queue; who may decide
 *     one is `lib/organization-join-access.ts`, on the handlers.
 *
 * `/users` is deliberately absent: it checks in a server layout instead, so an
 * authenticated caller gets an explicit access-denied state rather than a
 * redirect.
 *
 * Kept as a table rather than a chain of `if`s so the whole set is readable in
 * one place, and so adding an area does not add a branch to `proxy`.
 */
const ROLE_GATED_AREAS: ReadonlyArray<{ prefix: string; roles: readonly string[]; home: string }> = [
  { prefix: "/organizations", roles: ["SUPER_ADMIN"], home: "/login" },
  // VIEWER on the next four: an organization-wide Viewer reads Head Office's
  // pages, and `rolePortalRedirect` has already sent a pinned one home.
  { prefix: "/activity", roles: [...ACTIVITY_LOG_ROLES, "VIEWER"], home: "/dashboard" },
  { prefix: "/branches", roles: ["HEAD_OFFICE", "VIEWER"], home: "/dashboard" },
  { prefix: "/join-requests", roles: ["HEAD_OFFICE", "VIEWER"], home: "/dashboard" },
  // Head count requests: the two requester roles and the Head Office that
  // decides (lib/branch-head-count-access.ts). Both handlers re-check.
  // VIEWER: an organization-wide one reads the queue as Head Office does.
  { prefix: HEAD_COUNT_REQUESTS_AREA, roles: [...HEAD_COUNT_REQUEST_READ_ROLES, "VIEWER"], home: "/dashboard" },
  // Creating desk users and granting their reach is Super Admin's alone.
  { prefix: DESK_TEAM_AREA, roles: ORDER_DESK_MANAGER_ROLES, home: "/dashboard" },
  // The desk's own workspace; no other role has a reason to render it.
  { prefix: ORDER_DESK_HOME, roles: ["ORDER_DESK"], home: "/dashboard" },
  // The executive's own workspace, and the same dashboard in the admin shell
  // for Super Admin. Both endpoints behind them re-check the role.
  { prefix: APRICART_EXECUTIVE_HOME, roles: ["APRICART_EXECUTIVE"], home: "/dashboard" },
  { prefix: DELIVERY_DASHBOARD_AREA, roles: ["SUPER_ADMIN"], home: "/dashboard" },
  // The warehouse's own workspace; every endpoint behind it re-checks the role
  // and the branch reach.
  { prefix: WAREHOUSE_HOME, roles: ["WAREHOUSE"], home: "/dashboard" },
  // Assigning warehouse accounts their branches is Super Admin's alone.
  { prefix: WAREHOUSE_TEAM_AREA, roles: WAREHOUSE_MANAGER_ROLES, home: "/dashboard" },
  // Inside /reports, which Branch Admin and Group User also reach; the report
  // is Super Admin's and Head Office's, and both its endpoints re-check.
  { prefix: CONSOLIDATED_INVOICE_REPORT_AREA, roles: [...CONSOLIDATED_INVOICE_REPORT_ROLES, "VIEWER"], home: "/reports" },
]

/** Where to send a caller whose role does not hold the area, or null. */
function roleGatedAreaRedirect(pathname: string, role: string | undefined): string | null {
  // On a path boundary, like every other area check here: "/warehouse-team"
  // is not inside "/warehouse".
  const area = ROLE_GATED_AREAS.find((candidate) => pathMatchesPrefix(pathname, candidate.prefix))
  if (!area || (role !== undefined && area.roles.includes(role))) return null
  return area.home
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const response = NextResponse.next()

  if (pathname.startsWith("/api/v1/")) {
    return await handleApiRequest(req, pathname, response)
  }

  // `/join` is public by design: it is how somebody with no account asks to be
  // let into an organization. It is not in `protectedPrefixes` either, so this
  // list is belt-and-braces rather than the thing that opens it. Note the exact
  // match — `/join-requests` is the Head Office queue and stays protected.
  const isPublicPath = ["/login", "/join"].includes(pathname)
  const needsAuth = protectedPrefixes.some((prefix) =>
    pathMatchesPrefix(pathname, prefix),
  ) && !isPublicPath

  if (!needsAuth) return withSecurityHeaders(response, pathname)

  const token = await getToken({ req, secret: edgeEnv.NEXTAUTH_SECRET })
  if (!token) {
    logger("middleware", { reason: "no_session", path: pathname })
    const loginPath = "/login"
    const url = new URL(loginPath, req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  // The server-side registry is the single authority for mutable idle time.
  // Edge middleware validates only immutable structure/absolute expiry so a
  // committed activity update cannot be contradicted by a lost cookie response.
  const expirationReason = getSessionNonIdleExpirationReason(token)
  if (expirationReason) {
    logger("middleware", {
      reason: "session_expired",
      expirationReason,
      path: pathname,
    })
    return withSecurityHeaders(expiredSessionRedirect(req), pathname)
  }

  const role = (token as any).role as string | undefined

  // Force newly-created users to change their password before accessing anything else.
  // mustChangePassword is set to true on user creation and cleared after the user
  // sets a new password. The flag lives in the JWT so no extra DB hit per request.
  const mustChangePassword = (token as any).mustChangePassword === true
  if (mustChangePassword && !pathname.startsWith("/change-password")) {
    const url = new URL("/change-password", req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  // Role-based routing enforcement
  const roleRedirect = rolePortalRedirect(role, pathname, (token as any).budgetAllocationEnabled === true, {
    organizationId: (token as any).organizationId,
    branchId: (token as any).branchId,
  })
  if (roleRedirect) {
    const url = new URL(roleRedirect, req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  const gatedAreaRedirect = roleGatedAreaRedirect(pathname, role)
  if (gatedAreaRedirect) {
    logger("middleware", { reason: "insufficient_role", path: pathname, role })
    const url = new URL(gatedAreaRedirect, req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  return withSecurityHeaders(response, pathname)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - API routes are matched separately below for CSRF/body-size checks
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - Static file extensions (manifest.json, images, etc.)
     */
    "/((?!api|_next/static|_next/image|favicon.ico|.*[.](?:svg|png|jpg|jpeg|gif|webp|json|ico)$).*)",
    "/dashboard",
    "/dashboard/:path*",
    "/organizations/:path*",
    "/users/:path*",
    "/join-requests",
    "/join-requests/:path*",
    "/delivery-addresses",
    "/delivery-addresses/:path*",
    "/branches/:path*",
    "/orders/:path*",
    "/inventory/:path*",
    "/budgets/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/shop",
    "/shop/:path*",
    "/support",
    "/support/:path*",
    "/approvals",
    "/approvals/:path*",
    "/group-portal",
    "/group-portal/:path*",
    "/change-password",
    "/change-password/:path*",
    "/api/v1/:path*",
  ],
}

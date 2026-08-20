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

const protectedPrefixes = [
  "/approvals",
  "/branches",
  "/branch-inventory",
  "/budgets",
  "/budget-by-quantity",
  "/change-password",
  "/dashboard",
  "/employee-management",
  "/group-portal",
  "/groups",
  "/inventory",
  "/invoices",
  "/orders",
  "/organizations",
  "/products",
  "/receipts",
  "/refunds",
  "/reports",
  "/settings",
  "/shop",
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
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
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

function handleApiRequest(req: NextRequest, pathname: string, response: NextResponse): NextResponse {
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
  return withSecurityHeaders(response, pathname)
}

const ADMIN_PORTAL_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"]

/**
 * The approver works inside the admin shell so it gets the same sidebar and
 * topbar, but it is not an administrator: it may reach only the approval queue,
 * the reports its branch assignments scope, and settings. Every other shell
 * area — organizations, users, inventory, budgets, branches — stays closed, and
 * this allowlist fails closed for anything not named in it.
 */
const GROUP_USER_HOME = "/approvals"
const GROUP_USER_AREAS = ["/approvals", "/reports", "/settings"]

// The approval area belongs to the approver alone; an administrator that lands
// on it is sent back to its own dashboard.
const APPROVALS_AREA = "/approvals"

// The multi-branch ordering workspace is the requester's own area.
const GROUP_ORDER_PORTAL_HOME = "/group-portal"

/**
 * The portal each role is confined to, or null when the path is already inside
 * it. Each restricted role owns exactly one area and is redirected home from
 * everywhere else; /change-password stays reachable so a forced password change
 * can complete.
 *
 * ORDER_PORTAL -> /shop and the group roles -> /group-portal are mutually
 * exclusive: neither can reach the other's area or the admin shell.
 */
function rolePortalRedirect(role: string | undefined, pathname: string): string | null {
  if (pathname.startsWith("/change-password")) return null

  if (role === "ORDER_PORTAL") {
    return pathname.startsWith("/shop") ? null : "/shop"
  }
  if (role === "GROUP_USER") {
    return GROUP_USER_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
      ? null
      : GROUP_USER_HOME
  }
  if (role === "GROUP_ORDER_PORTAL") {
    // The requester keeps its own workspace and never reaches the admin shell,
    // the approver's queue, or the single-branch /shop.
    return pathname.startsWith(GROUP_ORDER_PORTAL_HOME) ? null : GROUP_ORDER_PORTAL_HOME
  }
  if (role && ADMIN_PORTAL_ROLES.includes(role)) {
    // Strict separation: administrators belong in the dashboard shell only, and
    // the approval queue is not theirs.
    return pathname.startsWith("/shop")
      || pathname.startsWith("/group-portal")
      || pathMatchesPrefix(pathname, APPROVALS_AREA)
      ? "/dashboard"
      : null
  }
  return null
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const response = NextResponse.next()

  if (pathname.startsWith("/api/v1/")) {
    return handleApiRequest(req, pathname, response)
  }

  const isPublicPath = ["/login"].includes(pathname)
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
  const roleRedirect = rolePortalRedirect(role, pathname)
  if (roleRedirect) {
    const url = new URL(roleRedirect, req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  // Enforce SUPER_ADMIN for admin sections
  if (pathname.startsWith("/organizations") && role !== "SUPER_ADMIN") {
    logger("middleware", { reason: "insufficient_role", path: pathname, role })
    const url = new URL("/login", req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }
  // /users performs its role check in a server layout so authenticated users
  // receive an explicit access-denied state without mounting the management UI.
  // Head Office only routes  
  if (pathname.startsWith("/branches") && role !== "HEAD_OFFICE") {
    logger("middleware", { reason: "insufficient_role", path: pathname, role })
    const url = new URL("/dashboard", req.url || "http://localhost")
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
    "/branches/:path*",
    "/orders/:path*",
    "/inventory/:path*",
    "/budgets/:path*",
    "/reports/:path*",
    "/settings/:path*",
    "/shop",
    "/shop/:path*",
    "/approvals",
    "/approvals/:path*",
    "/group-portal",
    "/group-portal/:path*",
    "/change-password",
    "/change-password/:path*",
    "/api/v1/:path*",
  ],
}

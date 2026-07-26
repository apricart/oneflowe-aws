import { NextResponse, type NextRequest } from "next/server"
import { logger } from "@/lib/utils"
import { getToken } from "next-auth/jwt"
import { edgeEnv } from "@/lib/edge/env"
import {
  isCookieAuthenticatedMutationAllowed,
  isKnownBodyTooLarge,
  requestBodyLimitForPath,
} from "@/lib/edge/request-security"

const protectedPrefixes = ["/dashboard", "/organizations", "/users", "/orders", "/inventory", "/budgets", "/reports", "/settings", "/branches", "/shop", "/change-password"]

/**
 * Inject bank-grade security headers into every response
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
  if (pathname.startsWith("/api/v1/")) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0")
  }

  return response
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const response = NextResponse.next()

  if (pathname.startsWith("/api/v1/")) {
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

  const isPublicPath = ["/login"].includes(pathname)
  const needsAuth = protectedPrefixes.some((p) => pathname.startsWith(p)) && !isPublicPath

  if (!needsAuth) return withSecurityHeaders(response, pathname)

  const token = await getToken({ req, secret: edgeEnv.NEXTAUTH_SECRET })
  if (!token) {
    logger("middleware", { reason: "no_session", path: pathname })
    const loginPath = "/login"
    const url = new URL(loginPath, req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
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
  // 1. ORDER_PORTAL users can ONLY access /shop (allow /change-password when mustChangePassword is set)
  if (role === "ORDER_PORTAL" && !pathname.startsWith("/shop") && !pathname.startsWith("/change-password")) {
    const url = new URL("/shop", req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }

  // 2. Admin users cannot access /shop — strict separation
  if (role && ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"].includes(role) && pathname.startsWith("/shop")) {
    const url = new URL("/dashboard", req.url || "http://localhost")
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
  // Users route - accessible by SUPER_ADMIN and HEAD_OFFICE
  if (pathname.startsWith("/users") && !["SUPER_ADMIN", "HEAD_OFFICE"].includes(role || "")) {
    logger("middleware", { reason: "insufficient_role", path: pathname, role })
    const url = new URL("/login", req.url || "http://localhost")
    const redirectRes = NextResponse.redirect(url)
    return withSecurityHeaders(redirectRes, pathname)
  }
  // Head Office only routes  
  if (pathname.startsWith("/branches") && role !== "HEAD_OFFICE") {
    logger("middleware", { reason: "insufficient_role", path: pathname, role })
    const url = new URL("/login", req.url || "http://localhost")
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
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|json|ico)$).*)",
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
    "/change-password",
    "/change-password/:path*",
    "/api/v1/:path*",
  ],
}

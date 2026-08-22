import "server-only"

import { headers } from "next/headers"
import { env } from "@/lib/server/env"
import { resolveTrustedClientIp } from "@/lib/security/client-ip"

/**
 * The caller's address as seen through the trusted proxy chain.
 *
 * Uses the same header precedence and trusted-hop count as rate limiting, so a
 * spoofed `X-Forwarded-For` cannot select the client address here either.
 * Returns null when no address can be established; security callers must treat
 * null as "cannot verify" and never as "allowed".
 */
export async function resolveRequestClientIp(): Promise<string | null> {
  try {
    const headerList = await headers()
    const clientIp = resolveTrustedClientIp({
      cloudFrontViewerAddress: headerList.get("cloudfront-viewer-address"),
      forwardedFor: headerList.get("x-forwarded-for"),
      realIp: headerList.get("x-real-ip"),
      trustedProxyHops: env.RATE_LIMIT_TRUST_PROXY_HOPS,
    })

    return clientIp === "unknown" ? null : clientIp
  } catch (error) {
    // Outside a request scope (scripts, build time) there is no client address.
    console.error("[Auth] Unable to resolve the request client address:", error)
    return null
  }
}

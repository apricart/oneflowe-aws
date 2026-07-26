/**
 * API Rate Limiting using Upstash Redis
 * Protects endpoints from brute force and DoS attacks
 */

import { redis } from "@/lib/redis"
import { NextResponse } from "next/server"
import { headers } from "next/headers"
import { env } from "@/lib/server/env"
import { resolveTrustedClientIp } from "@/lib/security/client-ip"

// Rate limit configurations for different endpoint types
const RATE_LIMITS = {
    // Login/auth endpoints - strict limits
    login: { requests: 15, windowSeconds: 60 * 15 },    // 15 per 15 minutes

    // Standard API endpoints
    api: { requests: 100, windowSeconds: 60 },           // 100 per minute

    // Sensitive operations (password reset, user creation)
    sensitive: { requests: 10, windowSeconds: 60 * 5 },  // 10 per 5 minutes

    // Search/listing endpoints - slightly higher
    search: { requests: 200, windowSeconds: 60 },        // 200 per minute

    // Write operations (POST/PUT/DELETE)
    write: { requests: 50, windowSeconds: 60 },          // 50 per minute

    // OTP and resource-heavy endpoints
    otpSend: { requests: 5, windowSeconds: 60 * 15 },    // 5 per 15 minutes
    otpVerify: { requests: 10, windowSeconds: 60 * 10 }, // 10 per 10 minutes
    upload: { requests: 20, windowSeconds: 60 * 60 },    // 20 per hour
    import: { requests: 5, windowSeconds: 60 * 10 },     // 5 per 10 minutes
    report: { requests: 10, windowSeconds: 60 * 10 },    // 10 per 10 minutes
    order: { requests: 20, windowSeconds: 60 },           // 20 per minute
    refund: { requests: 10, windowSeconds: 60 * 10 },    // 10 per 10 minutes
    email: { requests: 5, windowSeconds: 60 * 10 },      // 5 per 10 minutes
} as const

export type RateLimitType = keyof typeof RATE_LIMITS

const FAIL_CLOSED_RATE_LIMITS = new Set<RateLimitType>([
    "login",
    "sensitive",
    "otpSend",
    "otpVerify",
    "upload",
    "import",
    "report",
    "order",
    "refund",
    "email",
])

// Validate rate limit configuration on startup
Object.entries(RATE_LIMITS).forEach(([key, config]) => {
    if (config.requests <= 0 || config.windowSeconds <= 0) {
        console.error(`[RateLimit] Invalid configuration for ${key}:`, config)
    }
})

// Redis key patterns for rate limiting
const RATE_LIMIT_KEY = (type: string, identifier: string) => {
    if (!type || !identifier) {
        throw new Error('[RateLimit] type and identifier are required for rate limit key')
    }
    return `rate_limit:${type}:${identifier}`
}

/**
 * Get client identifier for rate limiting
 * Uses IP address or user ID if available
 */
export async function getClientIdentifier(userId?: string): Promise<string> {
    try {
        // Validate and sanitize userId
        if (userId) {
            if (typeof userId !== 'string' || userId.trim().length === 0) {
                console.warn('[RateLimit] Invalid userId provided, falling back to IP')
            } else {
                return `user:${userId.trim()}`
            }
        }

        const headersList = await headers()
        const cloudFrontViewerAddress = headersList.get("cloudfront-viewer-address")
        const forwardedFor = headersList.get("x-forwarded-for")
        const realIp = headersList.get("x-real-ip")

        const ip = resolveTrustedClientIp({
            cloudFrontViewerAddress,
            forwardedFor,
            realIp,
            trustedProxyHops: env.RATE_LIMIT_TRUST_PROXY_HOPS,
        })

        return `ip:${ip}`
    } catch (error) {
        console.error('[RateLimit] Error getting client identifier:', error)
        return 'ip:unknown'
    }
}

/**
 * Check rate limit for a given identifier and type
 * Returns whether the request is allowed and remaining requests
 */
export async function checkRateLimit(
    identifier: string,
    type: RateLimitType = "api"
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    try {
        // Validate inputs
        if (!identifier || typeof identifier !== 'string') {
            console.error('[RateLimit] Invalid identifier')
            return { allowed: false, remaining: 0, resetIn: 60 }
        }

        if (!type || !(type in RATE_LIMITS)) {
            console.error('[RateLimit] Invalid rate limit type:', type)
            return { allowed: false, remaining: 0, resetIn: 60 }
        }

        const config = RATE_LIMITS[type]
        const key = RATE_LIMIT_KEY(type, identifier)

        // Increment counter and read TTL in a single round-trip
        const pipeline = redis.pipeline()
        pipeline.incr(key)
        pipeline.ttl(key)
        const [current, ttl] = await pipeline.exec<[number, number]>()

        // Validate counter value
        if (typeof current !== 'number' || current < 0) {
            console.error('[RateLimit] Invalid counter value from Redis:', current)
            return { allowed: true, remaining: config.requests, resetIn: config.windowSeconds }
        }

        // Set expiry on first request. TTL < 0 means the key has no expiry
        // (-1) — also covers a key whose EXPIRE previously failed, which the
        // old code left counting forever.
        if (typeof ttl !== 'number' || ttl < 0) {
            await redis.expire(key, config.windowSeconds)
        }

        const validTTL = typeof ttl === 'number' && ttl > 0 ? ttl : config.windowSeconds

        return {
            allowed: current <= config.requests,
            remaining: Math.max(0, config.requests - current),
            resetIn: validTTL
        }
    } catch (error: any) {
        const failClosed = FAIL_CLOSED_RATE_LIMITS.has(type)
        if (error.message?.includes('WRONGPASS') || error.message?.includes('unauthorized')) {
            console.warn(`[RateLimit] Redis authentication failed for ${type} limiter.`)
        } else {
            console.error("[RateLimit] Rate limit check failed:", error)
        }
        return failClosed
            ? { allowed: false, remaining: 0, resetIn: 60 }
            : { allowed: true, remaining: 0, resetIn: 0 }
    }
}

/**
 * Rate limit response with proper headers
 */
export function rateLimitResponse(resetIn: number): NextResponse {
    // Validate resetIn
    const validResetIn = typeof resetIn === 'number' && resetIn > 0 ? resetIn : 60

    return NextResponse.json(
        {
            error: "Too many requests. Please try again later.",
            retryAfter: validResetIn,
            message: `Please wait ${validResetIn} seconds before trying again.`
        },
        {
            status: 429,
            headers: {
                "Retry-After": String(validResetIn),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + validResetIn)
            }
        }
    )
}

/**
 * Middleware helper to check rate limits
 * Use at the start of API route handlers
 */
export async function withRateLimit(
    type: RateLimitType = "api",
    userId?: string
): Promise<NextResponse | null> {
    try {
        const identifier = await getClientIdentifier(userId)
        const { allowed, remaining, resetIn } = await checkRateLimit(identifier, type)

        if (!allowed) {
            console.warn(`[RateLimit] Rate limit exceeded for ${identifier} on ${type} endpoint`)
            return rateLimitResponse(resetIn)
        }

        return null
    } catch (error) {
        console.error('[RateLimit] Error in withRateLimit:', error)
        // Allow request on error to avoid false positives
        return null
    }
}

/**
 * Rate limit decorator for use in API routes
 * Returns headers to add to successful responses
 */
export function getRateLimitHeaders(remaining: number, resetIn: number): Record<string, string> {
    // Validate inputs
    const validRemaining = typeof remaining === 'number' && remaining >= 0 ? remaining : 0
    const validResetIn = typeof resetIn === 'number' && resetIn > 0 ? resetIn : 0

    return {
        "X-RateLimit-Remaining": String(validRemaining),
        "X-RateLimit-Reset": String(validResetIn),
        "X-RateLimit-Limit": String(RATE_LIMITS.api.requests) // Default to api limit
    }
}

/**
 * Reset rate limit for a specific identifier (admin function)
 */
export async function resetRateLimit(identifier: string, type: RateLimitType): Promise<boolean> {
    try {
        if (!identifier || !type) {
            console.error('[RateLimit] Invalid parameters for resetRateLimit')
            return false
        }

        const key = RATE_LIMIT_KEY(type, identifier)
        await redis.del(key)
        console.log(`[RateLimit] Reset rate limit for ${identifier} on ${type}`)
        return true
    } catch (error) {
        console.error('[RateLimit] Failed to reset rate limit:', error)
        return false
    }
}

/**
 * Get current rate limit status for an identifier
 */
export async function getRateLimitStatus(
    identifier: string,
    type: RateLimitType
): Promise<{ current: number; limit: number; resetIn: number } | null> {
    try {
        if (!identifier || !type) {
            return null
        }

        const key = RATE_LIMIT_KEY(type, identifier)
        const current = await redis.get(key)
        const ttl = await redis.ttl(key)
        const config = RATE_LIMITS[type]

        return {
            current: typeof current === 'number' ? current : 0,
            limit: config.requests,
            resetIn: typeof ttl === 'number' && ttl > 0 ? ttl : config.windowSeconds
        }
    } catch (error) {
        console.error('[RateLimit] Failed to get rate limit status:', error)
        return null
    }
}

import NextAuth from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIdentifier, resetRateLimit } from "@/lib/rate-limiter"
import { createHash } from "crypto"

const handler = NextAuth(authOptions)

function hashRateLimitPart(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

async function getLoginRateLimitIdentifier(req: NextRequest): Promise<string> {
    const clientIdentifier = await getClientIdentifier()

    try {
        const body = await req.clone().text()
        const username = new URLSearchParams(body).get("username")?.trim().toLowerCase()

        if (username) {
            return `${clientIdentifier}:username:${hashRateLimitPart(username)}`
        }
    } catch (error) {
        console.warn("[Auth] Unable to read login username for rate limiting:", error)
    }

    return clientIdentifier
}

function loginRateLimitResponse(req: NextRequest, resetIn: number): NextResponse {
    const validResetIn = typeof resetIn === "number" && resetIn > 0 ? resetIn : 60
    const message = `Too many login attempts. Please wait ${validResetIn} seconds before trying again.`
    const url = new URL("/login", req.url || "http://localhost")
    url.searchParams.set("error", message)

    return NextResponse.json(
        {
            url: url.toString(),
            error: message,
            retryAfter: validResetIn,
            message,
        },
        {
            status: 429,
            headers: {
                "Retry-After": String(validResetIn),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + validResetIn),
            },
        }
    )
}

async function getNextAuthCallbackError(response: Response): Promise<string | null> {
    try {
        const data = await response.clone().json() as { url?: string }
        if (!data?.url) return null

        return new URL(data.url).searchParams.get("error")
    } catch {
        return null
    }
}

function sanitizeAuthCallbackError(error: string | null): string | null {
    if (!error) return error

    const safeErrors = new Set([
        "CredentialsSignin",
        "MFA_REQUIRED",
        "ORGANIZATION_INACTIVE",
        "BRANCH_INACTIVE",
        "USER_INACTIVE",
    ])

    if (safeErrors.has(error)) return error

    const normalized = error.toLowerCase()
    const looksLikeInternalDbError =
        normalized.includes("failed query") ||
        normalized.includes("params:") ||
        normalized.includes("select ") ||
        normalized.includes("tenant/user") ||
        normalized.includes("database")

    return looksLikeInternalDbError ? "AUTH_DATABASE_ERROR" : error
}

async function sanitizeNextAuthCallbackResponse(response: Response): Promise<Response> {
    try {
        const data = await response.clone().json() as { url?: string }
        if (!data?.url) return response

        const url = new URL(data.url)
        const rawError = url.searchParams.get("error")
        const safeError = sanitizeAuthCallbackError(rawError)
        if (!rawError || safeError === rawError) return response

        url.searchParams.set("error", safeError || "AUTH_DATABASE_ERROR")
        return NextResponse.json(
            { ...data, url: url.toString() },
            { status: response.status }
        )
    } catch {
        return response
    }
}

// GET requests pass through (session checks, CSRF token)
export { handler as GET }

// POST requests (login attempts) are rate-limited
export async function POST(req: NextRequest, context: any) {
    // Only rate-limit actual credential login attempts, not signOut or CSRF requests
    const url = new URL(req.url || "http://localhost")
    const isSignIn = url.pathname.endsWith('/callback/credentials') ||
        url.pathname.endsWith('/callback/employee-credentials') ||
        url.pathname.endsWith('/callback/mfa-credentials') ||
        url.pathname.endsWith('/callback/employee-mfa-credentials')

    if (isSignIn) {
        // Rate limit failed login attempts per IP and username.
        const identifier = await getLoginRateLimitIdentifier(req)
        const { allowed, resetIn } = await checkRateLimit(identifier, "login")

        if (!allowed) {
            return loginRateLimitResponse(req, resetIn)
        }

        const response = await handler(req, context)
        const callbackError = await getNextAuthCallbackError(response)
        const sanitizedResponse = await sanitizeNextAuthCallbackResponse(response)

        // Valid credentials should not consume the brute-force login budget.
        // MFA_REQUIRED is a successful first factor and continues in the MFA flow.
        if ((response.ok && !callbackError) || (callbackError && sanitizeAuthCallbackError(callbackError) !== "CredentialsSignin")) {
            await resetRateLimit(identifier, "login")
        }

        return sanitizedResponse
    }

    return handler(req, context)
}

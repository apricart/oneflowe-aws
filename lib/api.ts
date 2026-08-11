import { NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth"
import type { Role } from "@/lib/rbac"
import { requireRole, isValidRole } from "@/lib/rbac"

/**
 * Return a successful JSON response
 */
export function ok<T>(data: T, init?: ResponseInit) {
  try {
    // Validate data can be serialized
    if (data === undefined) {
      console.warn('[API] ok() called with undefined data, using null')
      return NextResponse.json(null, init)
    }

    return NextResponse.json(data as any, init)
  } catch (error) {
    console.error('[API] Error creating response:', error)
    return NextResponse.json({ error: 'Failed to create response' }, { status: 500 })
  }
}

/**
 * Return a cached JSON response
 */
export function okCached<T>(data: T, seconds = 30) {
  try {
    // Validate seconds
    const validSeconds = typeof seconds === 'number' && seconds > 0 && seconds <= 31536000 // Max 1 year
      ? seconds
      : 30

    if (validSeconds !== seconds) {
      console.warn(`[API] Invalid cache seconds: ${seconds}, using ${validSeconds}`)
    }

    return NextResponse.json(data as any, {
      headers: {
        "Cache-Control": `public, max-age=${validSeconds}, stale-while-revalidate=${validSeconds * 10}`,
      },
    })
  } catch (error) {
    console.error('[API] Error creating cached response:', error)
    return NextResponse.json({ error: 'Failed to create response' }, { status: 500 })
  }
}

/**
 * Return an error response
 */
export function error(message: string, status = 400) {
  try {
    // Validate message
    if (!message || typeof message !== 'string') {
      message = 'An error occurred'
    }

    // Sanitize message for non-development environments to prevent information leakage
    // Always sanitize 5xx errors — bank-grade: never expose internals
    const isCritical = String(status).startsWith('5')
    if (isCritical) {
      console.error(`[API ERROR] Internal server error:`, message)
      message = "An unexpected error occurred. Please try again later."
    }

    // Validate status code
    const validStatus = typeof status === 'number' && status >= 400 && status <= 599
      ? status
      : 400

    if (validStatus !== status) {
      console.warn(`[API] Invalid error status: ${status}, using ${validStatus}`)
    }

    return NextResponse.json({ error: message }, { status: validStatus })
  } catch (err) {
    console.error('[API] Error creating error response:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// Alias for error function
export const err = error

/**
 * Safely read and parse JSON from request body
 */
export async function readJson<T = any>(req: Request): Promise<T | null> {
  try {
    // Check if request has a body
    if (!req.body) {
      console.warn('[API] readJson called on request without body')
      return null
    }

    // Check content type header
    const contentType = req.headers.get('content-type')
    if (contentType && !contentType.includes('application/json')) {
      console.warn(`[API] readJson called with non-JSON content-type: ${contentType}`)
    }

    const body = await req.json()

    // Validate parsed body
    if (body === undefined) {
      console.warn('[API] Parsed JSON body is undefined')
      return null
    }

    return body as T
  } catch (error: any) {
    // Different error handling based on error type
    if (error?.name === 'SyntaxError') {
      console.error('[API] JSON parsing error - invalid JSON syntax')
    } else {
      console.error('[API] Error reading request body:', error)
    }
    return null
  }
}

/**
 * Require specific role for API access
 */
export async function requireApiRole(allowed: Role[]) {
  try {
    // Validate allowed roles array
    if (!Array.isArray(allowed) || allowed.length === 0) {
      console.error('[API] requireApiRole called with invalid allowed roles')
      return NextResponse.json(
        { error: "Invalid server configuration" },
        { status: 500 }
      )
    }

    // Validate all roles are valid
    const invalidRoles = allowed.filter(role => !isValidRole(role))
    if (invalidRoles.length > 0) {
      console.error('[API] requireApiRole called with invalid roles:', invalidRoles)
      return NextResponse.json(
        { error: "Invalid server configuration" },
        { status: 500 }
      )
    }

    const current = await getCurrentUser()

    if (!current) {
      return NextResponse.json(
        { error: "Unauthorized", message: "Authentication required" },
        { status: 401 }
      )
    }

    // Block any API call while the user has a pending password change.
    // The change-password endpoint uses getCurrentUser() directly (not requireApiRole)
    // so it remains accessible; all other API routes are blocked here.
    if (current.mustChangePassword === true) {
      return NextResponse.json(
        { error: "Forbidden", message: "Password change required" },
        { status: 403 }
      )
    }

    // Validate current user has valid role
    if (!isValidRole(current.role)) {
      console.error('[API] Current user has invalid role:', current.role)
      return NextResponse.json(
        { error: "Forbidden", message: "Invalid user role" },
        { status: 403 }
      )
    }

    try {
      requireRole(current.role, allowed)
    } catch (roleError: any) {
      const errorMessage = roleError?.message || "Insufficient permissions"
      return NextResponse.json(
        {
          error: "Forbidden",
          message: "Insufficient permissions"
        },
        { status: 403 }
      )
    }

    return null
  } catch (error) {
    console.error('[API] Error in requireApiRole:', error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

/**
 * Validate and sanitize pagination parameters
 */
export function parsePaginationParams(searchParams: URLSearchParams): {
  page: number
  limit: number
  offset: number
} {
  const pageParam = searchParams.get('page')
  const limitParam = searchParams.get('limit')

  let page = 1
  let limit = 20

  // Parse and validate page
  if (pageParam) {
    const parsed = Number.parseInt(pageParam, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      page = Math.min(parsed, 10000) // Max page 10000
    } else {
      console.warn(`[API] Invalid page parameter: ${pageParam}`)
    }
  }

  // Parse and validate limit
  if (limitParam) {
    const parsed = Number.parseInt(limitParam, 10)
    if (!Number.isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, 100) // Max limit 100
    } else {
      console.warn(`[API] Invalid limit parameter: ${limitParam}`)
    }
  }

  const offset = (page - 1) * limit

  return { page, limit, offset }
}


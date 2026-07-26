import { getServerSession } from "next-auth"
import type { Role } from "./rbac"
import { db } from "@/lib/db"
import { sessions, users } from "@/db/schema"
import { and, eq } from "drizzle-orm"
import { authOptions } from "./auth-options"
import { logError } from "@/lib/global-logger"
import { env } from "@/lib/server/env"

const INACTIVITY_TIMEOUT_MIN = env.INACTIVITY_TIMEOUT_MINUTES

export type CurrentUser = {
  id: string
  email: string
  role: Role
  mustChangePassword: boolean
}

import { cookies, headers } from 'next/headers'
import type { Session } from "next-auth"

// ── Per-request memoization of session resolution ──
// Next.js returns the same headers() instance for every call within a single
// request and a fresh instance per request (verified empirically on this Next
// version), so it is a safe per-request WeakMap key; entries are garbage-
// collected with the request. React.cache() is deliberately NOT used here:
// it does not memoize inside route handlers, where all our API traffic lives.
const sessionPerRequest = new WeakMap<object, Promise<Session | null>>()
const scopePerRequest = new WeakMap<object, Promise<RequestScope | null>>()

async function requestMemoKey(): Promise<object | null> {
  try {
    return await headers()
  } catch {
    // Not inside a request scope (scripts, build time) — skip memoization
    return null
  }
}

/**
 * getServerSession(authOptions), resolved at most once per request.
 * Multiple helpers (requireApiRole, getRequestScope, route code) share the
 * same resolution instead of re-running the session callback each time.
 */
export async function getSharedServerSession(): Promise<Session | null> {
  const key = await requestMemoKey()
  if (!key) return getServerSession(authOptions)

  let pending = sessionPerRequest.get(key)
  if (!pending) {
    pending = getServerSession(authOptions).catch((err) => {
      // Never memoize failures — the next caller retries
      sessionPerRequest.delete(key)
      throw err
    })
    sessionPerRequest.set(key, pending)
  }
  return pending
}

/**
 * Get current authenticated user
 * @returns CurrentUser or null if not authenticated
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const session = await getSharedServerSession()

    if (!session?.user) {
      return null
    }

    // Validate session user data
    const userId = (session.user as any).id
    const email = session.user.email
    const role = (session.user as any).role

    if (!userId || typeof userId !== 'string') {
      console.error('[Auth] Invalid user ID in session')
      return null
    }

    if (!email || typeof email !== 'string') {
      console.error('[Auth] Invalid email in session')
      return null
    }

    if (!role || typeof role !== 'string') {
      console.error('[Auth] Invalid role in session')
      return null
    }

    return {
      id: userId,
      email: email,
      role: role as Role || "BRANCH_ADMIN",
      mustChangePassword: (session.user as any).mustChangePassword === true,
    }
  } catch (error) {
    logError(error, 'GET_CURRENT_USER')
    return null
  }
}

export type RequestScope = {
  role: Role
  userId: string
  organizationId: number | null
  branchId: number | null
}

/**
 * Get request scope with user context
 * @returns RequestScope or null if not authenticated
 *
 * Memoized per request (same mechanism as getSharedServerSession) so that
 * e.g. verifyResourceAccess + route code trigger the org/branch lookup once.
 * Callers receive a fresh shallow copy so shared state cannot be mutated.
 */
export async function getRequestScope(): Promise<RequestScope | null> {
  const key = await requestMemoKey()
  if (!key) return loadRequestScope()

  let pending = scopePerRequest.get(key)
  if (!pending) {
    pending = loadRequestScope()
    scopePerRequest.set(key, pending)
  }
  const scope = await pending
  return scope ? { ...scope } : null
}

async function loadRequestScope(): Promise<RequestScope | null> {
  try {
    const session = await getSharedServerSession()

    if (!session?.user) {
      return null
    }

    const userId = (session.user as any).id as string
    const role = ((session.user as any).role || "BRANCH_ADMIN") as Role

    // Validate user ID
    if (!userId || typeof userId !== 'string') {
      console.error('[Auth] Invalid user ID in session for request scope')
      return null
    }

    // Super Admin can see everything; avoid extra DB call
    if (role === "SUPER_ADMIN") {
      return { role, userId, organizationId: null, branchId: null }
    }

    // Fetch user's organization and branch with error handling
    try {
      const [row] = await db
        .select({ organizationId: users.organizationId, branchId: users.branchId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)

      if (!row) {
        console.warn(`[Auth] User ${userId} not found in database for request scope`)
        return { role, userId, organizationId: null, branchId: null }
      }

      return {
        role,
        userId,
        organizationId: (row?.organizationId ?? null) as any,
        branchId: (row?.branchId ?? null) as any,
      }
    } catch (dbError) {
      logError(dbError, 'GET_REQUEST_SCOPE_DB_QUERY', { userId, role })
      // Return partial scope rather than failing entirely
      return { role, userId, organizationId: null, branchId: null }
    }
  } catch (error) {
    logError(error, 'GET_REQUEST_SCOPE')
    return null
  }
}

/**
 * Touch session to update last activity timestamp
 * @param userId - User ID to update session for
 */
export async function touchSession(userId: string): Promise<void> {
  try {
    // Validate user ID
    if (!userId || typeof userId !== 'string') {
      console.error('[Auth] Invalid user ID for touch session')
      return
    }

    await db
      .update(sessions)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(sessions.userId, userId)))

  } catch (error) {
    logError(error, 'TOUCH_SESSION', { userId })
    // Don't throw - session touch failures shouldn't break the app
  }
}

/**
 * Check if session is inactive based on last activity
 * @param lastActivity - Last activity timestamp
 * @returns Promise<boolean> indicating if session is inactive
 */
export async function isSessionInactive(lastActivity: Date | null | undefined): Promise<boolean> {
  try {
    // Handle null or undefined input
    if (!lastActivity) {
      console.warn('[Auth] No last activity provided, considering session inactive')
      return true
    }

    // Validate last activity is a valid date
    if (!(lastActivity instanceof Date) || isNaN(lastActivity.getTime())) {
      console.error('[Auth] Invalid lastActivity date')
      return true
    }

    const now = Date.now()
    const lastActivityTime = lastActivity.getTime()

    // Validate we're not dealing with future dates (clock skew)
    if (lastActivityTime > now + 60000) { // Allow 1 minute clock skew
      console.warn('[Auth] Last activity is in the future, possible clock skew')
      return true
    }

    const diffMin = (now - lastActivityTime) / 60000
    const timeoutMin = Math.max(INACTIVITY_TIMEOUT_MIN, 1) // Minimum 1 minute

    return diffMin > timeoutMin
  } catch (error) {
    logError(error, 'IS_SESSION_INACTIVE', { lastActivity })
    // On error, consider session inactive for security
    return true
  }
}

/**
 * Validate role is a valid system role
 * @param role - Role string to validate
 * @returns boolean indicating if role is valid
 */
export function isValidRole(role: string | undefined | null): role is Role {
  if (!role || typeof role !== 'string') {
    return false
  }

  const validRoles: Role[] = ['SUPER_ADMIN', 'HEAD_OFFICE', 'BRANCH_ADMIN', 'ORDER_PORTAL']
  return validRoles.includes(role as Role)
}

/**
 * Safely get user role with fallback
 * @param session - Session object
 * @returns Valid role or default BRANCH_ADMIN
 */
export function getSafeUserRole(session: any): Role {
  try {
    const role = session?.user?.role

    if (isValidRole(role)) {
      return role
    }

    console.warn('[Auth] Invalid or missing role in session, using BRANCH_ADMIN as default')
    return 'BRANCH_ADMIN'
  } catch (error) {
    console.error('[Auth] Error getting user role:', error)
    return 'BRANCH_ADMIN'
  }
}

/**
 * Log error safely
 */
function logErrorOnly(error: any, context: string, meta?: any) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[Auth] Error in ${context}:`, { message, ...meta })
  } catch (e) {
    console.error(`[Auth] Error in ${context}`)
  }
}

/**
 * Verify if the current user has access to a specific resource scope (BOLA protection)
 * @returns boolean indicating if access is allowed
 */
export async function verifyResourceAccess(organizationId?: number | null, branchId?: number | null): Promise<boolean> {
  const scope = await getRequestScope()
  if (!scope) return false

  // Super Admin can access everything
  if (scope.role === "SUPER_ADMIN") return true

  // Check organization isolation
  if (organizationId !== undefined && organizationId !== null) {
    if (scope.organizationId !== organizationId) {
      console.warn(`[Security] BOLA Attempt: User ${scope.userId} (${scope.role}) tried to access Org ${organizationId} but belongs to Org ${scope.organizationId}`)
      return false
    }
  }

  // Check branch isolation
  if (branchId !== undefined && branchId !== null) {
    if (scope.branchId !== branchId) {
      // Note: HEAD_OFFICE users usually have access to all branches in their org
      if (scope.role === "HEAD_OFFICE") return true

      console.warn(`[Security] BOLA Attempt: User ${scope.userId} (${scope.role}) tried to access Branch ${branchId} but belongs to Branch ${scope.branchId}`)
      return false
    }
  }

  return true
}


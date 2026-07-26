import { redis } from "@/lib/redis"
import { env } from "@/lib/server/env"

/**
 * Short-lived Redis cache for the session-callback "is this user still valid"
 * DB check (user active/not deleted, sessionVersion match, org/branch active).
 *
 * Only POSITIVE results are cached — an invalid session is never served from
 * cache. TTL is intentionally short; set SESSION_VALIDATION_CACHE_TTL_SECONDS=0
 * to disable caching entirely and restore a DB check on every session read.
 *
 * Propagation guarantees:
 * - User-level changes (deactivate, delete, password reset) call
 *   invalidateSessionValidationCache() and take effect immediately.
 * - Org/branch-level deactivation is not proactively invalidated (it affects
 *   many users) and takes effect within the TTL window.
 */

export const SESSION_VALIDATION_CACHE_TTL = env.SESSION_VALIDATION_CACHE_TTL_SECONDS

// The exact tuple the session callback validated. A cached entry only counts
// as a hit when every field matches the incoming token, so a sessionVersion
// bump or org/branch reassignment can never be masked by a stale entry.
export type SessionValidationEntry = {
    sv: number | null
    org: number | null
    br: number | null
}

function cacheKey(userId: string): string {
    return `session-ok:${userId}`
}

export async function getSessionValidationCache(userId: string): Promise<SessionValidationEntry | null> {
    if (!SESSION_VALIDATION_CACHE_TTL) return null
    try {
        const data = await redis.get(cacheKey(userId))
        if (!data) return null
        // Upstash may return a parsed object or a JSON string
        if (typeof data === "object") return data as SessionValidationEntry
        if (typeof data === "string") return JSON.parse(data) as SessionValidationEntry
        return null
    } catch {
        // Redis unavailable — caller falls back to the DB check
        return null
    }
}

export async function setSessionValidationCache(userId: string, entry: SessionValidationEntry): Promise<void> {
    if (!SESSION_VALIDATION_CACHE_TTL) return
    try {
        await redis.setex(cacheKey(userId), SESSION_VALIDATION_CACHE_TTL, JSON.stringify(entry))
    } catch {
        // Non-fatal — next session read just hits the DB again
    }
}

/**
 * Call after any change that must log a user out immediately:
 * deactivation, deletion, password reset / sessionVersion bump.
 * For employees pass the token id form, e.g. `emp_123`.
 */
export async function invalidateSessionValidationCache(userId: string): Promise<void> {
    try {
        await redis.del(cacheKey(userId))
    } catch (err) {
        // Non-fatal: the entry still dies within the TTL window
        console.error("[SessionCache] Failed to invalidate session validation cache:", err)
    }
}

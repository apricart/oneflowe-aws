import "server-only"

import { and, eq } from "drizzle-orm"
import { organizationSettings } from "@/db/schema"
import { CACHE_TTL, getCached, scopedCacheKey } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import { normalizeSessionIdleTimeoutMinutes } from "@/lib/session-policy"
import { env } from "@/lib/server/env"

export const SESSION_TIMEOUT_SETTING_KEY = "session_timeout_minutes"

const globalIdleTimeoutMinutes = normalizeSessionIdleTimeoutMinutes(
  env.INACTIVITY_TIMEOUT_MINUTES,
)

type CachedSessionSetting = {
  value: unknown
}

// Security setting changes should converge quickly even if best-effort cache
// invalidation is unavailable on one instance.
const SESSION_POLICY_CACHE_TTL_SECONDS = 30

/**
 * Resolve a tenant's timeout strictly by the organization ID from its signed
 * token. The scoped cache key prevents values from ever crossing tenants.
 */
export async function resolveSessionIdleTimeoutMinutes(
  organizationId: unknown,
  fallback?: unknown,
): Promise<number> {
  const hasPriorSignedPolicy = fallback !== undefined
  const safeFallback = normalizeSessionIdleTimeoutMinutes(
    hasPriorSignedPolicy ? fallback : globalIdleTimeoutMinutes,
    globalIdleTimeoutMinutes,
  )

  if (
    typeof organizationId !== "number" ||
    !Number.isInteger(organizationId) ||
    organizationId <= 0
  ) {
    return safeFallback
  }

  try {
    const cacheKey = scopedCacheKey("settings-session-policy", {
      orgId: organizationId,
    })
    const setting = await getCached<CachedSessionSetting>(
      cacheKey,
      async () => {
        const [row] = await db
          .select({ value: organizationSettings.value })
          .from(organizationSettings)
          .where(
            and(
              eq(organizationSettings.organizationId, organizationId),
              eq(organizationSettings.key, SESSION_TIMEOUT_SETTING_KEY),
            ),
          )
          .limit(1)

        return { value: row?.value }
      },
      Math.min(CACHE_TTL.SETTINGS, SESSION_POLICY_CACHE_TTL_SECONDS),
    )

    return normalizeSessionIdleTimeoutMinutes(setting.value, safeFallback)
  } catch (error) {
    // A policy lookup failure must never lengthen the current signed policy.
    // Existing sessions retain their prior bounded value. A tenant login has
    // no prior policy to preserve, so it fails closed instead of silently
    // replacing a tenant's potentially stricter setting with the global value.
    console.error("[Auth] Unable to resolve tenant session timeout:", error)
    if (!hasPriorSignedPolicy) throw error
    return safeFallback
  }
}

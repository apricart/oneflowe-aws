import { and, eq } from "drizzle-orm"

import { organizationSettings } from "@/db/schema"
import { BUDGET_ALLOCATION_MODE_SETTING_KEY, parseBudgetAllocationMode } from "@/lib/budget-allocation-mode"
import { CACHE_TTL, getCached, scopedCacheKey } from "@/lib/cache-utils"
import { db } from "@/lib/db"

export async function getBudgetAllocationModeForOrganization(organizationId: number) {
  // The "o:<id>" segment of the cache key below is what keeps one tenant's mode
  // out of another tenant's read, and scopedCacheKey drops that segment for a
  // falsy id. Refusing a non-positive id here means an unscoped, tenant-less key
  // can never be written. Callers that pass an unusable id still get the default
  // mode, exactly as they did when the lookup queried and found no row.
  if (!Number.isFinite(organizationId) || organizationId <= 0) {
    return parseBudgetAllocationMode(undefined)
  }

  // Cached per organization, so one tenant can never read another tenant's
  // allocation mode. The raw setting row is what is cached; parsing stays below
  // so the stored value and the parsed mode cannot drift apart.
  //
  // The key sits under the "settings" prefix so the invalidateByPrefix("settings")
  // that already runs on every organization-settings write and delete clears it,
  // which keeps a mode change observable on the request after the change.
  const [setting] = await getCached(
    scopedCacheKey("settings:budget-allocation-mode", { orgId: organizationId }),
    () => db
      .select({ value: organizationSettings.value })
      .from(organizationSettings)
      .where(and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.key, BUDGET_ALLOCATION_MODE_SETTING_KEY),
      ))
      .limit(1),
    CACHE_TTL.SETTINGS,
  )

  return parseBudgetAllocationMode(setting?.value)
}

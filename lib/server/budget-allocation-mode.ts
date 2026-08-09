import { and, eq } from "drizzle-orm"

import { organizationSettings } from "@/db/schema"
import { BUDGET_ALLOCATION_MODE_SETTING_KEY, parseBudgetAllocationMode } from "@/lib/budget-allocation-mode"
import { coalesceInFlight, scopedCacheKey } from "@/lib/cache-utils"
import { db } from "@/lib/db"

export async function getBudgetAllocationModeForOrganization(organizationId: number) {
  const [setting] = await coalesceInFlight(
    scopedCacheKey("inflight:settings:budget-allocation-mode", { orgId: organizationId }),
    () => db
      .select({ value: organizationSettings.value })
      .from(organizationSettings)
      .where(and(
        eq(organizationSettings.organizationId, organizationId),
        eq(organizationSettings.key, BUDGET_ALLOCATION_MODE_SETTING_KEY),
      ))
      .limit(1),
  )

  return parseBudgetAllocationMode(setting?.value)
}

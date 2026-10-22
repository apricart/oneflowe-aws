import "server-only"

import { and, eq, type SQL } from "drizzle-orm"

import { branches, warehouseCityAssignments, warehouseCityOrganizations } from "@/db/schema"
import { branchCityKeySql } from "@/lib/server/branch-city-key"

/**
 * When a warehouse user's city rule reaches a branch: the branch's city key is
 * one of the user's cities **and** the branch's organization is one of the
 * user's chosen organizations. The two sets are intersected; an empty
 * organization set reaches nothing.
 *
 * Every reader joins the three tables the same way, with these two conditions:
 *
 * ```ts
 * .from(warehouseCityAssignments)
 * .innerJoin(branches, warehouseCityBranchOn())
 * .innerJoin(warehouseCityOrganizations, warehouseCityOrganizationOn())
 * ```
 *
 * `lib/warehouse-access.test.ts` lists the readers. See
 * plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */

/** The branch is in the rule's city — the key computed in SQL on the branch side. */
export function warehouseCityBranchOn(): SQL {
  return eq(branchCityKeySql(branches.city), warehouseCityAssignments.cityKey)
}

/** The same user has chosen the branch's organization. */
export function warehouseCityOrganizationOn(): SQL {
  return and(
    eq(warehouseCityOrganizations.userId, warehouseCityAssignments.userId),
    eq(warehouseCityOrganizations.organizationId, branches.organizationId),
  )!
}

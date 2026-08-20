import "server-only"

import { db } from "@/lib/db"
import { isMultiBranchAnalyticsRole } from "@/lib/server/analytics-scope"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * The assigned branch set behind every analytics read for a multi-branch role.
 *
 * Resolved from the caller's own assignments on the server, never from the
 * request, and returned as `null` for every other role so existing ladders keep
 * their current behaviour untouched. An empty array is a deny: callers must
 * refuse rather than fall through to an unfiltered query.
 */
export async function loadAnalyticsAssignedBranchIds(
  role: unknown,
  userId: unknown,
): Promise<number[] | null> {
  if (!isMultiBranchAnalyticsRole(role)) return null
  if (typeof userId !== "string" || userId.length === 0) return []
  return resolveScopedBranchIds(db, userId)
}

import "server-only"

import { and, asc, eq, inArray, sql } from "drizzle-orm"

import { branches, groups } from "@/db/schema"
import { db } from "@/lib/db"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * Group-centric view of a Group Order Portal user's reach.
 *
 * `lib/server/multi-branch-scope` answers "which branches may this user act
 * on"; this module answers "which groups may this user order for, and which of
 * their branches belong to each". The ordering flow is scoped to one group at a
 * time so a single submission always covers branches that share one catalogue.
 *
 * Every read here is pinned to the caller's own organization *and* to their
 * resolved branch scope. An empty scope means no access and is never widened
 * into "the whole tenant".
 */

/** Branches whose group assignment is missing are still reachable, under this bucket. */
export const UNGROUPED_BUCKET_ID = null
export const UNGROUPED_BUCKET_NAME = "Unassigned branches"

/** Bounds on one submission. Keeps a single request's work predictable. */
export const MAX_BRANCHES_PER_SUBMISSION = 100
export const MAX_ENTRIES_PER_SUBMISSION = 50
export const MAX_ITEMS_PER_BRANCH = 200

export type ScopedBranch = {
  id: number
  name: string
  city: string | null
  costCenterId: string | null
  groupId: number | null
}

export type ScopedGroup = {
  /** null for the bucket holding branches that carry no group. */
  id: number | null
  name: string
  branches: ScopedBranch[]
}

/**
 * The branches this user may order for, as they exist right now, restricted to
 * the user's own organization. Returns an empty array for any user without
 * assignments.
 */
export async function loadScopedBranches(
  userId: string,
  organizationId: number | null,
): Promise<ScopedBranch[]> {
  if (!organizationId) return []

  const scopedBranchIds = await resolveScopedBranchIds(db, userId)
  if (scopedBranchIds.length === 0) return []

  // Re-assert the tenant on the read itself, so an assignment row that somehow
  // referenced another tenant's branch cannot surface a foreign branch name.
  return db
    .select({
      id: branches.id,
      name: branches.name,
      city: branches.city,
      costCenterId: branches.costCenterId,
      groupId: branches.groupId,
    })
    .from(branches)
    .where(and(
      inArray(branches.id, scopedBranchIds),
      eq(branches.organizationId, organizationId),
      sql`${branches.status} IS DISTINCT FROM 'deleted'`,
    ))
    .orderBy(asc(branches.name))
}

/**
 * The scoped branches folded into the groups they belong to. Groups are named
 * from the `groups` table; a branch whose group was deleted, or which never had
 * one, falls into the ungrouped bucket rather than disappearing.
 */
export async function loadScopedGroups(
  userId: string,
  organizationId: number | null,
): Promise<ScopedGroup[]> {
  const scopedBranches = await loadScopedBranches(userId, organizationId)
  if (scopedBranches.length === 0) return []

  const groupIds = [...new Set(
    scopedBranches
      .map((branch) => branch.groupId)
      .filter((groupId): groupId is number => typeof groupId === "number"),
  )]

  const groupRows = groupIds.length > 0 && organizationId
    ? await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(and(
        inArray(groups.id, groupIds),
        eq(groups.organizationId, organizationId),
        sql`${groups.status} IS DISTINCT FROM 'deleted'`,
      ))
    : []

  const nameByGroupId = new Map(groupRows.map((group) => [group.id, group.name]))
  const buckets = new Map<number | null, ScopedGroup>()

  for (const branch of scopedBranches) {
    // A branch pointing at a group outside this tenant (or a deleted one) is
    // treated as ungrouped rather than trusted for its group identity.
    const groupId = branch.groupId !== null && nameByGroupId.has(branch.groupId)
      ? branch.groupId
      : UNGROUPED_BUCKET_ID
    const name = groupId === null
      ? UNGROUPED_BUCKET_NAME
      : nameByGroupId.get(groupId) as string

    const bucket = buckets.get(groupId) ?? { id: groupId, name, branches: [] }
    bucket.branches.push({ ...branch, groupId })
    buckets.set(groupId, bucket)
  }

  return [...buckets.values()].sort(compareGroupsForDisplay)
}

/** Named groups first, alphabetically; the ungrouped bucket always last. */
function compareGroupsForDisplay(left: ScopedGroup, right: ScopedGroup): number {
  if (left.id === null) return 1
  if (right.id === null) return -1
  return left.name.localeCompare(right.name)
}

export type GroupScopeFailure = { message: string; status: number }

export type ResolvedSubmissionScope = {
  group: ScopedGroup
  /** The requested branches, resolved to their current rows. */
  branches: ScopedBranch[]
}

/**
 * Authorize a submission against the user's live scope.
 *
 * Fails closed on every branch of the check: an unknown group, a branch outside
 * the user's assignments, and a branch belonging to a different group than the
 * one selected are all rejected. The caller persists nothing unless this
 * returns a scope.
 */
export async function resolveSubmissionScope({
  userId,
  organizationId,
  groupId,
  branchIds,
}: {
  userId: string
  organizationId: number | null
  groupId: number | null
  branchIds: number[]
}): Promise<{ scope: ResolvedSubmissionScope; failure?: undefined } | { scope?: undefined; failure: GroupScopeFailure }> {
  if (!organizationId) {
    return { failure: { message: "Organization context is required", status: 400 } }
  }
  const requestedBranchIds = [...new Set(branchIds)]
  if (requestedBranchIds.length === 0) {
    return { failure: { message: "Select at least one branch", status: 400 } }
  }
  if (requestedBranchIds.length > MAX_BRANCHES_PER_SUBMISSION) {
    return {
      failure: {
        message: `A group order can cover at most ${MAX_BRANCHES_PER_SUBMISSION} branches`,
        status: 400,
      },
    }
  }

  const scopedGroups = await loadScopedGroups(userId, organizationId)
  const group = scopedGroups.find((candidate) => candidate.id === groupId)
  if (!group) {
    return { failure: { message: "You do not have access to the selected group", status: 403 } }
  }

  const branchById = new Map(group.branches.map((branch) => [branch.id, branch]))
  const resolved: ScopedBranch[] = []
  for (const branchId of requestedBranchIds) {
    const branch = branchById.get(branchId)
    // Covers both "not in your scope" and "in your scope but in another group".
    if (!branch) {
      return {
        failure: {
          message: "One or more selected branches are not part of the selected group",
          status: 403,
        },
      }
    }
    resolved.push(branch)
  }

  return { scope: { group, branches: resolved } }
}

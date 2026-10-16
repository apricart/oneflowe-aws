import "server-only"

import type { NextResponse } from "next/server"

import { error } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import {
  canDecideBranchHeadCount,
  canRequestBranchHeadCount,
} from "@/lib/branch-head-count-access"
import { db } from "@/lib/db"
import { resolveScopedBranchIds, usesMultiBranchScope } from "@/lib/server/multi-branch-scope"

/**
 * The reach a head-count caller has, resolved from the session and nowhere
 * else — the same two shapes as `lib/server/delivery-address-scope.ts`. No
 * endpoint takes an `organizationId`, so there is no tenant to substitute.
 */

export type ResolvedHeadCountRequesterScope =
  | { ok: true; organizationId: number; actorUserId: string; role: string; branchIds: number[] }
  | { ok: false; response: NextResponse }

/**
 * A requester's branches: a Branch Admin's own branch, a Group User's resolved
 * assignment set. **An empty set is a refusal**, never "the whole tenant".
 */
export async function resolveHeadCountRequesterScope(): Promise<ResolvedHeadCountRequesterScope> {
  const scope = await getRequestScope()
  if (!scope?.userId) {
    return { ok: false, response: error("Invalid session", 401) }
  }
  if (!canRequestBranchHeadCount(scope.role)) {
    return { ok: false, response: error("Forbidden", 403) }
  }
  if (!scope.organizationId) {
    return { ok: false, response: error("Organization context required", 403) }
  }

  const branchIds = usesMultiBranchScope(scope.role)
    ? await resolveScopedBranchIds(db, scope.userId)
    : [Number(scope.branchId)].filter((id) => Number.isSafeInteger(id) && id > 0)

  if (branchIds.length === 0) {
    return { ok: false, response: error("No branch is assigned to this account", 403) }
  }

  return {
    ok: true,
    organizationId: Number(scope.organizationId),
    actorUserId: scope.userId,
    role: String(scope.role),
    branchIds,
  }
}

export type ResolvedHeadCountApproverScope =
  | { ok: true; organizationId: number; actorUserId: string; role: string }
  | { ok: false; response: NextResponse }

/** Head Office's tenant. A Head Office account with no organization is refused, never widened. */
export async function resolveHeadCountApproverScope(): Promise<ResolvedHeadCountApproverScope> {
  const scope = await getRequestScope()
  if (!scope?.userId) {
    return { ok: false, response: error("Invalid session", 401) }
  }
  if (!canDecideBranchHeadCount(scope.role)) {
    return { ok: false, response: error("Forbidden", 403) }
  }
  if (!scope.organizationId) {
    return { ok: false, response: error("Organization context required", 403) }
  }
  return {
    ok: true,
    organizationId: Number(scope.organizationId),
    actorUserId: scope.userId,
    role: String(scope.role),
  }
}

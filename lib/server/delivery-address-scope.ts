import "server-only"

import type { NextResponse } from "next/server"

import { error } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import {
  canDecideDeliveryAddress,
  canRequestDeliveryAddress,
} from "@/lib/delivery-address-access"
import { db } from "@/lib/db"
import { resolveScopedBranchIds, usesMultiBranchScope } from "@/lib/server/multi-branch-scope"

/**
 * The reach a delivery-address caller has, resolved from the session and from
 * nowhere else.
 *
 * Two shapes, because the feature has two authorities. A requester acts for a
 * set of branches; an approver acts for a tenant. Both are written once here so
 * neither the list route nor the create route nor the decision route can get
 * the fence subtly different.
 *
 * There is deliberately no `organizationId` parameter on any of the three
 * endpoints: the only tenant reachable is the caller's own, so there is no id
 * for a caller to substitute and no cross-tenant case for a handler to get
 * wrong.
 */

/**
 * A requester's branches.
 *
 * `ORDER_PORTAL` and `BRANCH_ADMIN` reach exactly the branch on their user row.
 * The two group roles reach the set their assignments resolve to, read live so
 * a group's membership change flows through without touching the user.
 *
 * **An empty set is a refusal, never "all branches".** A group account with no
 * assignment yet, or a single-branch account with no branch, gets 403 here
 * rather than being widened to its tenant — the failure mode of getting this
 * wrong is an address request filed against a branch the requester has nothing
 * to do with.
 */
export type ResolvedDeliveryAddressRequesterScope =
  | {
    ok: true
    organizationId: number
    actorUserId: string
    role: string
    branchIds: number[]
  }
  | { ok: false; response: NextResponse }

export async function resolveDeliveryAddressRequesterScope(): Promise<ResolvedDeliveryAddressRequesterScope> {
  const scope = await getRequestScope()
  if (!scope?.userId) {
    return { ok: false, response: error("Invalid session", 401) }
  }
  if (!canRequestDeliveryAddress(scope.role)) {
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

/**
 * An approver's tenant.
 *
 * Mirrors `resolveJoinManagementScope`, including its refusal of a Head Office
 * account with no organization: a null tenant must never widen to "all
 * tenants".
 */
export type ResolvedDeliveryAddressApproverScope =
  | { ok: true; organizationId: number; actorUserId: string }
  | { ok: false; response: NextResponse }

export async function resolveDeliveryAddressApproverScope(): Promise<ResolvedDeliveryAddressApproverScope> {
  const scope = await getRequestScope()
  if (!scope?.userId) {
    return { ok: false, response: error("Invalid session", 401) }
  }
  if (!canDecideDeliveryAddress(scope.role)) {
    return { ok: false, response: error("Forbidden", 403) }
  }
  if (!scope.organizationId) {
    return { ok: false, response: error("Organization context required", 403) }
  }
  return {
    ok: true,
    organizationId: Number(scope.organizationId),
    actorUserId: scope.userId,
  }
}

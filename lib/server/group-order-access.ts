import "server-only"

import { NextResponse } from "next/server"

import { error, requireApiRole } from "@/lib/api"
import { getRequestScope, type RequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import {
  GROUP_ORDER_PORTAL_ROLE,
  GROUP_USER_ROLE,
  resolveScopedBranchIds,
} from "@/lib/server/multi-branch-scope"

/**
 * The single gate in front of every Group Order Portal endpoint.
 *
 * The multi-branch *ordering* surface belongs to GROUP_ORDER_PORTAL alone.
 * GROUP_USER shares the branch-assignment mechanism but is an approver, not a
 * requester, so it is deliberately not on this allowlist — it keeps deciding
 * orders through the existing approve/reject routes and must not gain a way to
 * raise orders for its own branches here.
 *
 * Returning the scope rather than just a boolean means callers cannot forget to
 * read the tenant they are pinned to.
 */
export type GroupPortalActor = {
  scope: RequestScope
  organizationId: number
}

export async function requireGroupOrderPortal():
Promise<{ actor: GroupPortalActor; response?: undefined } | { actor?: undefined; response: NextResponse }> {
  const authError = await requireApiRole([GROUP_ORDER_PORTAL_ROLE])
  if (authError) return { response: authError }

  const scope = await getRequestScope()
  if (!scope) return { response: error("Unauthorized", 401) }

  // Fail closed: a group user without a tenant has no scope to act in, and the
  // absence of an organization must never be read as "every organization".
  if (!scope.organizationId) {
    return { response: error("Organization context is required", 403) }
  }

  return { actor: { scope, organizationId: scope.organizationId } }
}

/**
 * The mirror gate in front of every Group User approval endpoint.
 *
 * The approval surface belongs to GROUP_USER alone. GROUP_ORDER_PORTAL shares
 * the branch-assignment mechanism but is a requester, not an approver, so it is
 * deliberately not on this allowlist — it must not gain a way to decide the
 * orders it raises. BRANCH_ADMIN and HEAD_OFFICE are likewise excluded: they
 * keep deciding through the existing single-order routes, which are unchanged.
 *
 * The resolved branch scope is returned with the actor so no caller can forget
 * to restrict its query. An empty scope is a valid, access-denying result and
 * is never interpreted as organization-wide reach.
 */
export type GroupApproverActor = {
  scope: RequestScope
  organizationId: number
  scopedBranchIds: number[]
}

export async function requireGroupApprover():
Promise<{ actor: GroupApproverActor; response?: undefined } | { actor?: undefined; response: NextResponse }> {
  const authError = await requireApiRole([GROUP_USER_ROLE])
  if (authError) return { response: authError }

  const scope = await getRequestScope()
  if (!scope) return { response: error("Unauthorized", 401) }

  // Fail closed: without a tenant there is no scope to act in, and the absence
  // of an organization must never be read as "every organization".
  if (!scope.organizationId) {
    return { response: error("Organization context is required", 403) }
  }

  const scopedBranchIds = await resolveScopedBranchIds(db, scope.userId)

  return {
    actor: { scope, organizationId: scope.organizationId, scopedBranchIds },
  }
}

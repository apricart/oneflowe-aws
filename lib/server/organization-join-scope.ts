import "server-only"

import type { NextResponse } from "next/server"

import { error } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"

/**
 * The tenant a Head Office caller acts on, resolved from the session and from
 * nowhere else.
 *
 * Shared by all three managed join routes so the fence is written once. There is
 * deliberately no `organizationId` parameter on any of them: the only tenant
 * reachable is the caller's own, so there is no id for a caller to substitute
 * and no cross-tenant case for a handler to get wrong.
 *
 * A Head Office account with no organization is refused rather than treated as
 * global — a null tenant must never widen to "all tenants".
 */
export type ResolvedJoinScope =
  | { ok: true; organizationId: number; actorUserId: string }
  | { ok: false; response: NextResponse }

export async function resolveJoinManagementScope(): Promise<ResolvedJoinScope> {
  const scope = await getRequestScope()
  if (!scope?.userId) {
    return { ok: false, response: error("Invalid session", 401) }
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

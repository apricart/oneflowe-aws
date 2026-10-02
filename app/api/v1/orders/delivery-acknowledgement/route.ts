import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"

import { branches } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { readsAssignedBranchesOnly, resolveViewableBranch } from "@/lib/payment-control-access"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { resolveBranchDeliveryAcknowledgement } from "@/lib/server/unacknowledged-delivery-block"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * GET /api/v1/orders/delivery-acknowledgement?branchId=
 *
 * Whether a branch is blocked from ordering for delivered orders awaiting
 * acknowledgement (plans/OF-ORDERS-unacknowledged-delivery-ordering-block.md),
 * read by the Order Portal just before an order is attempted. Presentation
 * only: the order gate decides.
 *
 * Fenced exactly like GET /api/v1/payment-control: single-branch roles read
 * their own branch, group roles a branch in their resolved assignment set,
 * Head Office a branch of its tenant, Super Admin any. Returns the count and
 * the threshold only — no amounts and no order references, because an Order
 * Portal user may not see every order at their branch.
 */
export async function GET(req: NextRequest) {
  const denied = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope) return error("Unauthorized", 401)

    const requestedBranchId = new URL(req.url).searchParams.get("branchId")
    const assignedBranchIds = readsAssignedBranchesOnly(scope.role)
      ? await resolveScopedBranchIds(db, scope.userId)
      : null
    const access = resolveViewableBranch({
      role: scope.role,
      sessionBranchId: scope.branchId,
      assignedBranchIds,
      requestedBranchId,
    })
    if (!access.ok) return error(access.error, access.status)

    const [branch] = await db
      .select({ id: branches.id, organizationId: branches.organizationId })
      .from(branches)
      .where(eq(branches.id, access.branchId))
      .limit(1)
    if (!branch) return error("Branch not found", 404)
    if (scope.role !== "SUPER_ADMIN" && branch.organizationId !== scope.organizationId) return error("Branch not found", 404)

    const status = await resolveBranchDeliveryAcknowledgement(db, {
      organizationId: branch.organizationId,
      branchId: branch.id,
    })
    return ok({ branchId: branch.id, ...status }, NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "DELIVERY_ACKNOWLEDGEMENT_READ")
    return error("Unable to load delivery acknowledgement status", 500)
  }
}

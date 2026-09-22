import { NextRequest } from "next/server"
import { eq } from "drizzle-orm"

import { branches } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import {
  canManageExceptionForBranch,
  readsAssignedBranchesOnly,
  resolveViewableBranch,
} from "@/lib/payment-control-access"
import { presentPaymentControl } from "@/lib/payment-control-view"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { resolveBranchPaymentControl } from "@/lib/server/payment-control"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * GET /api/v1/payment-control?branchId=
 *
 * One branch's payment-control state, for the banner and the Head Office
 * panel. Every ordering or managing role may read the branches it may order
 * for or manage — nothing else (lib/payment-control-access.ts). The state is
 * computed on this read; nothing is written and nothing is audited.
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
      .select({ id: branches.id, organizationId: branches.organizationId, name: branches.name })
      .from(branches)
      .where(eq(branches.id, access.branchId))
      .limit(1)
    if (!branch) return error("Branch not found", 404)
    if (scope.role !== "SUPER_ADMIN" && branch.organizationId !== scope.organizationId) return error("Branch not found", 404)

    const status = await resolveBranchPaymentControl(db, { organizationId: branch.organizationId, branchId: branch.id })
    const canManage = canManageExceptionForBranch({
      role: scope.role,
      sessionOrganizationId: scope.organizationId,
      branchOrganizationId: branch.organizationId,
    })
    return ok(presentPaymentControl(status, { branch, canManage }), NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "PAYMENT_CONTROL_READ")
    return error("Unable to load payment control", 500)
  }
}

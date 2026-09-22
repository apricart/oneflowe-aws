import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"

import { branches } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { canManagePaymentControlExceptions } from "@/lib/payment-control-access"
import { presentPaymentControl, presentPaymentControlException } from "@/lib/payment-control-view"
import { paymentControlExceptionGrantSchema, validationMessage } from "@/lib/server/mutation-validation"
import { grantPaymentControlException, resolveBranchPaymentControl } from "@/lib/server/payment-control"
import { withRateLimit } from "@/lib/rate-limiter"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * POST /api/v1/payment-control/exceptions
 *
 * Grant a Head Office exception: the branch may keep ordering for the
 * policy's window (one month from now) although it is over the overdue
 * limit. Super Admin and Head Office only; Head Office inside its own
 * tenant, pinned from the session. The window is the policy's, never the
 * body's. One live exception per branch — a second is a 409. The grant and
 * its audit row commit together (lib/server/payment-control.ts).
 */
export async function POST(req: NextRequest) {
  const denied = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope || !canManagePaymentControlExceptions(scope.role)) return error("Forbidden", 403)
    if (scope.role === "HEAD_OFFICE" && !scope.organizationId) return error("Organization context required", 400)

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const body = await req.json().catch(() => null)
    const parsed = paymentControlExceptionGrantSchema.safeParse(body)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const now = new Date()
    const organizationId = scope.role === "SUPER_ADMIN" ? null : scope.organizationId
    const result = await db.transaction((tx) => grantPaymentControlException(tx, {
      branchId: parsed.data.branchId,
      organizationId,
      actor: { userId: scope.userId, role: scope.role },
      reason: parsed.data.reason ? parsed.data.reason : null,
      now,
    }))

    if (result.kind === "branch_not_found") return error("Branch not found", 404)
    if (result.kind === "conflict") {
      return NextResponse.json({
        error: "An exception is already in force for this branch",
        exception: presentPaymentControlException(result.exception, { canManage: true, now }),
      }, { status: 409, ...NO_STORE })
    }

    const [branch] = await db
      .select({ id: branches.id, organizationId: branches.organizationId, name: branches.name })
      .from(branches)
      .where(eq(branches.id, result.exception.branchId))
      .limit(1)
    const status = await resolveBranchPaymentControl(db, { organizationId: result.exception.organizationId, branchId: result.exception.branchId }, now)
    return ok(presentPaymentControl(status, { branch: branch ?? { id: result.exception.branchId, name: "" }, canManage: true }), { status: 201, ...NO_STORE })
  } catch (caughtError) {
    logError(caughtError, "PAYMENT_CONTROL_EXCEPTION_GRANT")
    return error("Unable to grant the exception", 500)
  }
}

import { NextRequest, NextResponse } from "next/server"
import { eq } from "drizzle-orm"

import { branches } from "@/db/schema"
import { error, ok, requireApiRole } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import { logError } from "@/lib/global-logger"
import { canManagePaymentControlExceptions } from "@/lib/payment-control-access"
import { presentPaymentControl, presentPaymentControlException } from "@/lib/payment-control-view"
import { paymentControlExceptionRevokeSchema, validationMessage } from "@/lib/server/mutation-validation"
import { resolveBranchPaymentControl, revokePaymentControlException } from "@/lib/server/payment-control"
import { withRateLimit } from "@/lib/rate-limiter"

const NO_STORE = { headers: { "Cache-Control": "private, no-store, max-age=0" } }

/**
 * POST /api/v1/payment-control/exceptions/[id]/revoke
 *
 * End a Head Office exception early. Same gate and tenant fence as the
 * grant. Only a live exception can be revoked; an expired one has already
 * stopped and an already-revoked one keeps its first revocation. Audited in
 * the same transaction. Whether Head Office may do this at all is an open
 * client question (plan, question 8) — remove this route if the answer is no.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (denied) return denied

  try {
    const scope = await getRequestScope()
    if (!scope || !canManagePaymentControlExceptions(scope.role)) return error("Forbidden", 403)
    if (scope.role === "HEAD_OFFICE" && !scope.organizationId) return error("Organization context required", 400)

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const { id } = await params
    const exceptionId = Number.parseInt(id, 10)
    if (!Number.isInteger(exceptionId) || exceptionId <= 0) return error("Invalid exception id", 400)

    const rawBody = req.headers.get("content-length") === "0" ? {} : await req.json().catch(() => null)
    const parsed = paymentControlExceptionRevokeSchema.safeParse(rawBody ?? {})
    if (!parsed.success) return error(validationMessage(parsed.error), 400)

    const now = new Date()
    const organizationId = scope.role === "SUPER_ADMIN" ? null : scope.organizationId
    const result = await db.transaction((tx) => revokePaymentControlException(tx, {
      exceptionId,
      organizationId,
      actor: { userId: scope.userId, role: scope.role },
      reason: parsed.data.reason ? parsed.data.reason : null,
      now,
    }))

    if (result.kind === "not_found") return error("Exception not found", 404)
    if (result.kind === "already_revoked" || result.kind === "already_expired") {
      return NextResponse.json({
        error: result.kind === "already_revoked" ? "This exception was already revoked" : "This exception has already expired",
        exception: presentPaymentControlException(result.exception, { canManage: true, now }),
      }, { status: 409, ...NO_STORE })
    }

    const [branch] = await db
      .select({ id: branches.id, organizationId: branches.organizationId, name: branches.name })
      .from(branches)
      .where(eq(branches.id, result.exception.branchId))
      .limit(1)
    const status = await resolveBranchPaymentControl(db, { organizationId: result.exception.organizationId, branchId: result.exception.branchId }, now)
    return ok(presentPaymentControl(status, { branch: branch ?? { id: result.exception.branchId, name: "" }, canManage: true }), NO_STORE)
  } catch (caughtError) {
    logError(caughtError, "PAYMENT_CONTROL_EXCEPTION_REVOKE")
    return error("Unable to revoke the exception", 500)
  }
}

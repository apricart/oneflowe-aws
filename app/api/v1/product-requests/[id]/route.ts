import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { logEvent } from "@/lib/global-logger"
import { productRequestReviewSchema } from "@/lib/product-request"
import { canReviewProductRequest } from "@/lib/product-request-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { auditActorFromSession } from "@/lib/server/activity-audit"
import { validationMessage } from "@/lib/server/mutation-validation"
import { reviewProductRequest } from "@/lib/server/product-requests"

/**
 * Super Admin's decision on a new-product request: approved or rejected, with
 * an optional note Head Office will read. A decision is final — a second one
 * gets 409 — and it creates no product and sets no price.
 */

function parseRequestId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const scope = await getRequestScope()
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!canReviewProductRequest(scope.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("write", scope.userId)
    if (rateLimit) return rateLimit

    const requestId = parseRequestId((await context.params).id)
    if (requestId === null) {
      return NextResponse.json({ error: "Product request not found" }, { status: 404 })
    }

    const body = await req.json().catch(() => null)
    const parsed = productRequestReviewSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    }

    const actor = auditActorFromSession(session)
    const result = await reviewProductRequest({
      reviewer: { ...actor, id: scope.userId, role: scope.role },
      requestId,
      review: parsed.data,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.failure.message }, { status: result.failure.status })
    }

    logEvent({
      event: "PRODUCT_REQUEST_REVIEWED",
      userId: scope.userId,
      userRole: scope.role,
      resourceId: String(result.id),
      result: "SUCCESS",
      details: { status: result.status },
    })

    return NextResponse.json({ id: result.id, status: result.status })
  } catch (error) {
    const handled = handleError(error, "PATCH /api/v1/product-requests/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

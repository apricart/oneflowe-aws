import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { logEvent } from "@/lib/global-logger"
import { parseProductRequestListQuery, productRequestCreateSchema } from "@/lib/product-request"
import {
  canOpenProductRequests,
  canRaiseProductRequest,
  productRequestVisibilityScope,
} from "@/lib/product-request-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { validationMessage } from "@/lib/server/mutation-validation"
import { createProductRequest, listProductRequests } from "@/lib/server/product-requests"
import { VIEWER_READ_REFUSED, viewerReadScope } from "@/lib/viewer-access"

/**
 * New-product requests: Head Office raises them, Super Admin reads them all.
 *
 * The tenant is never taken from the request. `getRequestScope()` re-reads the
 * caller's organization from their user row; the list is narrowed by
 * `productRequestVisibilityScope`, and only Super Admin's `organizationId`
 * filter is honoured — Head Office's is ignored, because its scope is already
 * its own organization. See `lib/product-request-access.ts`.
 */

const NO_STORE = { "Cache-Control": "private, no-store" }

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const scope = viewerReadScope(await getRequestScope())
    if (!scope) return NextResponse.json({ error: VIEWER_READ_REFUSED }, { status: 403 })
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!canOpenProductRequests(scope.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const visibility = productRequestVisibilityScope({
      role: scope.role,
      organizationId: scope.organizationId,
    })
    if (visibility.kind === "none") {
      // Head Office with no organization: refused rather than widened.
      return NextResponse.json({ error: "Organization context required" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("search", scope.userId)
    if (rateLimit) return rateLimit

    const query = parseProductRequestListQuery(req.nextUrl.searchParams)
    if (!query.ok) {
      return NextResponse.json({ error: query.error }, { status: 400 })
    }

    const result = await listProductRequests(visibility, query.value)
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/product-requests")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const scope = await getRequestScope()
    if (!scope) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if (!canRaiseProductRequest(scope.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    const organizationId = scope.organizationId
    if (organizationId === null || !Number.isSafeInteger(organizationId) || organizationId <= 0) {
      return NextResponse.json({ error: "Organization context required" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const body: unknown = await req.json().catch(() => null)
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 })
    }

    const parsed = productRequestCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    }

    const result = await createProductRequest({
      raiser: { userId: scope.userId, role: scope.role, organizationId },
      request: parsed.data,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.failure.message }, { status: result.failure.status })
    }

    logEvent({
      event: "PRODUCT_REQUEST_CREATED",
      userId: scope.userId,
      userRole: scope.role,
      organizationId,
      resourceId: String(result.id),
      result: "SUCCESS",
    })

    return NextResponse.json({ id: result.id }, { status: 201, headers: NO_STORE })
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/product-requests")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { logEvent } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import { canRaiseSupportThread, isSupportParticipantRole } from "@/lib/support-access"
import {
  isSupportCategory,
  isSupportStatus,
  parseSupportOrderSearch,
  parseSupportThreadReference,
} from "@/lib/support-thread"
import {
  supportThreadCreateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import {
  SUPPORT_THREAD_PAGE_SIZE_MAX,
  createSupportThread,
  listSupportThreads,
} from "@/lib/server/support-threads"
import { attemptImmediateEmailDelivery } from "@/lib/server/order-notifications"
import { resolveSupportAuthor, supportViewerFromSession } from "@/lib/server/support-session"

/**
 * The support thread directory.
 *
 * GET is scoped by `supportScopeCondition`, which derives the tenant predicate
 * from the session's role — there is no `organizationId` a caller can send to
 * widen it. Apricart alone may *narrow* to one tenant, and that is a filter on
 * top of an already-unrestricted scope, never a way into one.
 */

export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportViewerFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("search", viewer.userId)
    if (rateLimit) return rateLimit

    const params = req.nextUrl.searchParams
    const status = params.get("status")
    const category = params.get("category")
    const organizationId = Number(params.get("organizationId"))
    const orderId = Number(params.get("orderId"))
    const reference = parseSupportThreadReference(params.get("reference"))

    // The one free-text filter on this route. Refused outright when it is too
    // long to name an order, rather than quietly matching more than was typed.
    const orderSearch = parseSupportOrderSearch(params.get("orderSearch"))
    if (!orderSearch.ok) {
      return NextResponse.json({ error: orderSearch.reason }, { status: 400 })
    }

    const result = await listSupportThreads(viewer, {
      status: isSupportStatus(status) ? status : undefined,
      category: isSupportCategory(category) ? category : undefined,
      // Only Apricart reads across tenants, so only Apricart can narrow to one.
      // For everybody else the parameter is ignored rather than honoured, and
      // their own scope still applies underneath.
      organizationId:
        viewer.role === "SUPER_ADMIN" && Number.isInteger(organizationId) && organizationId > 0
          ? organizationId
          : undefined,
      orderId: Number.isInteger(orderId) && orderId > 0 ? orderId : undefined,
      orderSearch: orderSearch.term ?? undefined,
      threadId: reference ?? undefined,
      page: Number(params.get("page")) || 1,
      pageSize: Math.min(Number(params.get("pageSize")) || 20, SUPPORT_THREAD_PAGE_SIZE_MAX),
    })

    return NextResponse.json(result)
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/threads")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const author = await resolveSupportAuthor()
    if (!author || !canRaiseSupportThread(author.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("sensitive", author.userId)
    if (rateLimit) return rateLimit

    const body = await req.json().catch(() => null)
    const parsed = supportThreadCreateSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    }

    const result = await createSupportThread({
      author,
      subject: parsed.data.subject,
      category: parsed.data.category,
      priority: parsed.data.priority,
      orderId: parsed.data.orderId ?? null,
      productId: parsed.data.productId ?? null,
      body: parsed.data.message,
      attachmentIds: parsed.data.attachmentIds,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.failure.message }, { status: result.failure.status })
    }

    logEvent({
      event: "SUPPORT_THREAD_CREATED",
      userId: author.userId,
      userRole: author.role,
      organizationId: author.organizationId,
      branchId: author.branchId ?? undefined,
      resourceId: String(result.threadId),
      result: "SUCCESS",
      details: {
        category: parsed.data.category,
        priority: parsed.data.priority,
        orderId: parsed.data.orderId ?? null,
        productId: parsed.data.productId ?? null,
        notified: result.queued.recipientCount,
      },
    })

    // Delivery is outside the transaction on purpose: a mail provider being
    // down must never lose the request the user just raised.
    await attemptImmediateEmailDelivery(result.queued.eventKeys)

    return NextResponse.json(
      { id: result.threadId, reference: result.reference },
      { status: 201 },
    )
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/support/threads")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

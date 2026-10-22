import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { logEvent } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import { canPostSupportMessage, isSupportParticipantRole } from "@/lib/support-access"
import type { SupportStatus } from "@/lib/support-thread"
import { supportMessageCreateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { getSupportThreadForViewer, postSupportMessage } from "@/lib/server/support-threads"
import { attemptImmediateEmailDelivery } from "@/lib/server/order-notifications"
import { resolveSupportResponder, supportViewerFromSession, withSupportReach } from "@/lib/server/support-session"

/**
 * Posting a reply.
 *
 * Reading the thread is checked first and answers 404 when it fails, so a
 * caller cannot learn that a thread exists by being told they may not post to
 * it. Whether the thread is still open is re-decided under a row lock inside
 * `postSupportMessage`; the check here is the fast, friendly one.
 */
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = await withSupportReach(supportViewerFromSession(session))
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("write", viewer.userId)
    if (rateLimit) return rateLimit

    const threadId = Number((await context.params).id)
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const body = await req.json().catch(() => null)
    const parsed = supportMessageCreateSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    }

    const thread = await getSupportThreadForViewer(viewer, threadId)
    if (!thread) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const canPost = canPostSupportMessage({
      viewer,
      thread: {
        organizationId: thread.organizationId,
        branchId: thread.branchId,
        createdByUserId: thread.createdByUserId,
        orderBranchId: thread.orderBranchId,
        status: thread.status as SupportStatus,
      },
    })
    if (!canPost) {
      return NextResponse.json(
        { error: "This request is closed. Raise a new one to take it further." },
        { status: 409 },
      )
    }

    const author = await resolveSupportResponder(thread.organizationId)
    if (!author || author.userId !== viewer.userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const result = await postSupportMessage({
      author,
      threadId,
      body: parsed.data.message,
      attachmentIds: parsed.data.attachmentIds,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.failure.message }, { status: result.failure.status })
    }

    logEvent({
      event: "SUPPORT_MESSAGE_POSTED",
      userId: author.userId,
      userRole: author.role,
      organizationId: thread.organizationId,
      branchId: thread.branchId ?? undefined,
      resourceId: String(threadId),
      result: "SUCCESS",
      details: {
        messageId: result.messageId,
        status: result.status,
        attachments: parsed.data.attachmentIds.length,
        notified: result.queued.recipientCount,
      },
    })

    await attemptImmediateEmailDelivery(result.queued.eventKeys)

    return NextResponse.json(
      { id: result.messageId, status: result.status },
      { status: 201 },
    )
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/support/threads/[id]/messages")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

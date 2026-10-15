import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { logEvent } from "@/lib/global-logger"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  canManageSupportThread,
  canReadSupportThread,
  isSupportParticipantRole,
} from "@/lib/support-access"
import {
  canTransitionSupportStatus,
  supportSideForRole,
  type SupportStatus,
} from "@/lib/support-thread"
import { supportThreadUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  getSupportThreadForViewer,
  markSupportThreadRead,
  updateSupportThread,
} from "@/lib/server/support-threads"
import { attemptImmediateEmailDelivery } from "@/lib/server/order-notifications"
import { resolveSupportResponder, supportReaderFromSession, supportViewerFromSession } from "@/lib/server/support-session"

/**
 * One support thread.
 *
 * A thread the caller may not read answers **404**, never 403 — the two are
 * indistinguishable from outside, so a thread id cannot be probed to find out
 * whether it exists.
 */

function parseThreadId(value: string): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportReaderFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("api", viewer.userId)
    if (rateLimit) return rateLimit

    const threadId = parseThreadId((await context.params).id)
    if (threadId === null) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const thread = await getSupportThreadForViewer(viewer, threadId)
    if (!thread) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    // Opening a thread is what marks it read. Failing to record that must not
    // fail the read itself.
    await markSupportThreadRead(threadId, viewer.userId).catch(() => undefined)

    return NextResponse.json({
      thread,
      viewer: {
        side: supportSideForRole(viewer.role),
        canManage: canManageSupportThread(viewer.role),
        userId: viewer.userId,
      },
    })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/threads/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
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

    const viewer = supportViewerFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("write", viewer.userId)
    if (rateLimit) return rateLimit

    const threadId = parseThreadId((await context.params).id)
    if (threadId === null) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const body = await req.json().catch(() => null)
    const parsed = supportThreadUpdateSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return NextResponse.json({ error: validationMessage(parsed.error) }, { status: 400 })
    }

    // Ownership before anything else: the thread has to be one this caller can
    // read before its status can be argued about.
    const thread = await getSupportThreadForViewer(viewer, threadId)
    if (!thread) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const isTriage = parsed.data.priority !== undefined || parsed.data.assignedToUserId !== undefined
    if (isTriage && !canManageSupportThread(viewer.role)) {
      return NextResponse.json(
        { error: "Only the Apricart team can assign or prioritise a request." },
        { status: 403 },
      )
    }

    const responder = await resolveSupportResponder(thread.organizationId)
    if (!responder) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Belt and braces: the caller resolved through a second path, so confirm it
    // is still the same person and still a reader of this thread.
    const stillAllowed =
      responder.userId === viewer.userId &&
      canReadSupportThread({
        viewer: { ...viewer, role: responder.role },
        thread: {
          organizationId: thread.organizationId,
          branchId: thread.branchId,
          createdByUserId: thread.createdByUserId,
        },
      })
    if (!stillAllowed) {
      return NextResponse.json({ error: "Support request not found" }, { status: 404 })
    }

    const result = await updateSupportThread(
      {
        actor: responder,
        threadId,
        status: parsed.data.status,
        priority: parsed.data.priority,
        assignedToUserId: parsed.data.assignedToUserId,
      },
      (from: SupportStatus, to: SupportStatus, side) =>
        canTransitionSupportStatus({ from, to, side }),
    )

    if (!result.ok) {
      return NextResponse.json({ error: result.failure.message }, { status: result.failure.status })
    }

    logEvent({
      event: "SUPPORT_THREAD_UPDATED",
      userId: responder.userId,
      userRole: responder.role,
      organizationId: thread.organizationId,
      branchId: thread.branchId ?? undefined,
      resourceId: String(threadId),
      result: "SUCCESS",
      details: {
        status: parsed.data.status ?? null,
        priority: parsed.data.priority ?? null,
        assigned: parsed.data.assignedToUserId !== undefined,
        notified: result.queued.recipientCount,
      },
    })

    await attemptImmediateEmailDelivery(result.queued.eventKeys)

    return NextResponse.json({ id: threadId, status: result.status })
  } catch (error) {
    const handled = handleError(error, "PATCH /api/v1/support/threads/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

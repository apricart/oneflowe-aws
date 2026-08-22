import { type NextRequest } from "next/server"

import { error, ok, readJson } from "@/lib/api"
import { ADMIN_OPERATIONS_EMAIL } from "@/lib/email/recipients"
import { sendGroupRefundRequestEmail } from "@/lib/email"
import { withRateLimit } from "@/lib/rate-limiter"
import { getCurrentUser } from "@/lib/auth"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import {
  GROUP_REFUND_HISTORY_PAGE_SIZE_DEFAULT,
  GROUP_REFUND_HISTORY_PAGE_SIZE_MAX,
  type GroupRefundSubmission,
  createGroupRefundRequests,
  listGroupRefundHistory,
  publishGroupRefundNotice,
} from "@/lib/server/group-order-refunds"
import { groupRefundRequestSchema, validationMessage } from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

function parsePositiveInt(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * The refund requests this user has raised against their own group orders.
 *
 * `requireGroupOrderPortal` resolves the caller's tenant on the server; no
 * organization, branch, or user identifier from the query string is trusted
 * here, and the only tunable is the page.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const { searchParams } = new URL(req.url)
  const requestedLimit = parsePositiveInt(searchParams.get("limit")) ?? GROUP_REFUND_HISTORY_PAGE_SIZE_DEFAULT

  const history = await listGroupRefundHistory({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    page: parsePositiveInt(searchParams.get("page")) ?? 1,
    limit: Math.min(requestedLimit, GROUP_REFUND_HISTORY_PAGE_SIZE_MAX),
  })

  return ok(history)
}

/**
 * Raise one refund request covering many branch orders of a single group order.
 *
 * The requester asks; it never decides. Every branch order becomes an ordinary
 * PENDING `refunds` row that a Super Admin approves or rejects through the
 * routes that already exist, so this endpoint adds a way to *ask* for a refund
 * and no way at all to grant one.
 *
 * Branch orders are validated and written independently, so one branch failing
 * its re-check never discards the requests that succeeded elsewhere; the
 * response reports each branch's outcome.
 */
export async function POST(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const rateLimited = await withRateLimit("refund", actor.scope.userId)
  if (rateLimited) return rateLimited

  const parsed = groupRefundRequestSchema.safeParse(await readJson(req))
  if (!parsed.success) return error(validationMessage(parsed.error), 400)
  const { groupOrderId, orders, reason } = parsed.data

  const outcome = await createGroupRefundRequests({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    groupOrderId,
    reason,
    requestedOrders: orders.map((entry) => ({ orderId: entry.orderId, items: entry.items })),
  })

  if (!outcome.ok) return error(outcome.message, outcome.status)

  // The requests are already recorded; announcing them must not be able to turn
  // a successful submission into an error, so both channels swallow failures.
  await publishGroupRefundNotice(outcome.notice)
  await notifyAdminOperations(outcome.submission, actor.organizationId)

  const { submission } = outcome
  return ok({
    message: submission.skippedOrderCount === 0
      ? "Refund request submitted"
      : "Refund request submitted with some branches skipped",
    item: submission,
  }, { status: 201 })
}

/**
 * One summary email for the whole submission rather than one per branch order,
 * so a group refund covering fifty branches does not send fifty messages.
 */
async function notifyAdminOperations(
  submission: GroupRefundSubmission,
  organizationId: number,
): Promise<void> {
  if (!ADMIN_OPERATIONS_EMAIL) return

  try {
    const user = await getCurrentUser()
    await sendGroupRefundRequestEmail({
      to: ADMIN_OPERATIONS_EMAIL,
      reference: submission.reference,
      requestedBy: String(user?.email || "A group order portal user"),
      organizationId,
      totalAmountCents: submission.totalAmountCents,
      branches: submission.results
        .filter((result): result is Extract<typeof result, { status: "requested" }> => result.status === "requested")
        .map((result) => ({
          tid: result.tid,
          branchName: result.branchName,
          refundNumber: result.refundNumber,
          amountCents: result.amountCents,
          itemCount: result.itemCount,
        })),
    })
  } catch (emailError) {
    console.error("[GroupRefunds] Summary email failed after the requests were recorded", emailError)
  }
}

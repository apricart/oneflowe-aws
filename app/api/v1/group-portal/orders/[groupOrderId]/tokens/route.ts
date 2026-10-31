import { NextResponse } from "next/server"

import { error, ok } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { sendGroupOrderTokensEmail } from "@/lib/email"
import { ADMIN_OPERATIONS_EMAIL } from "@/lib/email/recipients"
import {
  GROUP_TOKENS_ALREADY_SENT_MESSAGE,
  TOKEN_ALREADY_SENT_CODE,
  TOKEN_SEND_IN_PROGRESS_CODE,
  TOKEN_SEND_IN_PROGRESS_MESSAGE,
  TOKEN_SETTLEMENT_FAILED_CODE,
  tokenHandoffMessage,
  tokenSettlementRetryMessage,
} from "@/lib/order-token-handoff"
import { withRateLimit } from "@/lib/rate-limiter"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import { retryTokenHandoffSettlements, settleOrdersAfterTokenHandoff } from "@/lib/server/order-fulfillment"
import { sendTokenEmailOncePerOrder } from "@/lib/server/order-token-handoff-store"
import {
  loadShareableGroupTokens,
  recordGroupTokenHandoff,
  recordGroupTokenSettlementRetry,
  type GroupOrderTokenBundle,
} from "@/lib/server/group-order-tokens"

export const dynamic = "force-dynamic"

/**
 * Hand every fulfilment token for one group order to admin operations at once.
 *
 * This is the group-scale form of `/api/v1/orders/[id]/send-token-email`, which
 * stays exactly as it was for every role that uses it. It grants no additional
 * reach: each token released here belongs to an approved order this same user
 * created, in their own tenant, at a branch still in their live assignments,
 * decided by the same `canViewFulfillmentToken` policy — this route simply
 * collects them rather than making the user send twenty separate emails.
 *
 * Each token is emailed once. A repeat send carries only the branch orders
 * whose token has not gone yet, and is refused when every one already has.
 *
 * The recipient is the configured admin operations mailbox and is never taken
 * from the request, so this cannot be used to send tokens anywhere else.
 */
export async function POST(
  _req: Request,
  props: { params: Promise<{ groupOrderId: string }> },
) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const rateLimited = await withRateLimit("email", actor.scope.userId)
  if (rateLimited) return rateLimited

  const { groupOrderId } = await props.params
  if (!/^\d+$/.test(groupOrderId)) return error("Invalid group order ID", 400)

  const parsedId = Number(groupOrderId)
  if (!Number.isSafeInteger(parsedId) || parsedId <= 0) return error("Invalid group order ID", 400)

  if (!ADMIN_OPERATIONS_EMAIL) {
    return error("No admin operations mailbox is configured for token hand-off", 400)
  }

  const shareable = await loadShareableGroupTokens({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    groupOrderId: parsedId,
  })
  if (!shareable) return error("Group order not found", 404)

  if (shareable.entries.length === 0) {
    return error("No approved order in this group order has a fulfilment token to share", 400)
  }

  const user = await getCurrentUser()

  // Each token is emailed once: the message carries only the orders whose token
  // has not reached the administrator yet, and the bundle below is narrowed to
  // the same set so the settlement and the trail describe exactly what went.
  const sendOutcome = await sendTokenEmailOncePerOrder(
    shareable.entries.map((entry) => ({
      orderId: entry.orderId,
      organizationId: shareable.organizationId,
      branchId: entry.branchId,
    })),
    actor.scope.userId,
    async (unsentOrderIds) => {
      try {
        await sendGroupOrderTokensEmail({
          to: ADMIN_OPERATIONS_EMAIL,
          reference: shareable.reference,
          groupName: shareable.groupName,
          sharedBy: String(user?.email || "A Group Order Initiator"),
          entries: shareable.entries
            .filter((entry) => unsentOrderIds.has(entry.orderId))
            .map((entry) => ({
              tid: entry.tid,
              branchName: entry.branchName,
              token: entry.token,
              items: entry.items,
            })),
        })
        return { delivered: true }
      } catch (emailError) {
        const reason = emailError instanceof Error
          ? `${emailError.name}: ${emailError.message}`
          : String(emailError)
        return { delivered: false, reason }
      }
    },
  )

  if (sendOutcome.outcome === "already-sent") {
    // Every token has gone, but a delivered branch order whose settlement
    // failed is still waiting on it: settle those again, emailing nothing.
    return (await retryGroupTokenSettlements(shareable, actor.scope.userId))
      ?? NextResponse.json({ error: GROUP_TOKENS_ALREADY_SENT_MESSAGE, code: TOKEN_ALREADY_SENT_CODE }, { status: 409 })
  }
  if (sendOutcome.outcome === "in-progress") {
    return NextResponse.json({ error: TOKEN_SEND_IN_PROGRESS_MESSAGE, code: TOKEN_SEND_IN_PROGRESS_CODE }, { status: 409 })
  }
  if (sendOutcome.outcome === "failed") {
    return error(`Failed to send token email through AWS SES: ${sendOutcome.reason}`, 400)
  }

  const bundle = {
    ...shareable,
    entries: shareable.entries.filter((entry) => sendOutcome.orderIds.has(entry.orderId)),
  }

  // Every token in this message has now reached the administrator, so each
  // hand-off is recorded against its branch order — and settles that order if
  // it has already been delivered. This is the same rule the single-order
  // hand-off applies, run once per branch order inside its own transactions.
  const settlement = await settleOrdersAfterTokenHandoff(bundle.entries.map((entry) => ({
    orderId: entry.orderId,
    organizationId: bundle.organizationId,
    branchId: entry.branchId,
    status: entry.status,
    handedOffByUserId: actor.scope.userId,
  })))

  await recordGroupTokenHandoff({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    bundle,
    recipient: ADMIN_OPERATIONS_EMAIL,
    fulfilledOrderIds: settlement.fulfilledOrderIds,
    awaitingDeliveryOrderIds: settlement.awaitingDeliveryOrderIds,
    failedOrderIds: settlement.failedOrderIds,
  })

  const failedCount = settlement.failedOrderIds.size
  return ok({
    message: tokenHandoffMessage({
      sentCount: bundle.entries.length,
      fulfilledCount: settlement.fulfilledOrderIds.size,
      awaitingDeliveryCount: settlement.awaitingDeliveryOrderIds.size,
      failedCount,
    }),
    recipient: ADMIN_OPERATIONS_EMAIL,
    sentCount: bundle.entries.length,
    fulfilledCount: settlement.fulfilledOrderIds.size,
    awaitingDeliveryCount: settlement.awaitingDeliveryOrderIds.size,
    // The email did leave, so this stays a 200; the count is what tells the
    // caller some orders still are not fulfilled and the send should be retried.
    failedCount,
    settlementFailed: failedCount > 0,
    ...(failedCount > 0 ? { code: TOKEN_SETTLEMENT_FAILED_CODE } : {}),
  })
}

/**
 * Settle again the branch orders of this group order whose token already
 * reached the admin but whose settlement failed. Null when none is waiting on
 * one, so the caller answers "already sent" exactly as before. Only orders the
 * loader admitted are considered — the same scope the send itself had.
 */
async function retryGroupTokenSettlements(bundle: GroupOrderTokenBundle, userId: string) {
  const settlement = await retryTokenHandoffSettlements(bundle.entries.map((entry) => ({
    orderId: entry.orderId,
    organizationId: bundle.organizationId,
    branchId: entry.branchId,
  })))
  const fulfilledCount = settlement.fulfilledOrderIds.size
  const failedCount = settlement.failedOrderIds.size
  if (fulfilledCount === 0 && failedCount === 0) return null

  await recordGroupTokenSettlementRetry({
    userId,
    organizationId: bundle.organizationId,
    bundle,
    fulfilledOrderIds: settlement.fulfilledOrderIds,
    failedOrderIds: settlement.failedOrderIds,
  })

  const message = tokenSettlementRetryMessage({ fulfilledCount, failedCount })
  if (fulfilledCount === 0) {
    return NextResponse.json({
      error: message,
      code: TOKEN_SETTLEMENT_FAILED_CODE,
      retried: true,
      failedCount,
    }, { status: 503 })
  }
  return ok({
    message,
    recipient: ADMIN_OPERATIONS_EMAIL,
    sentCount: 0,
    fulfilledCount,
    awaitingDeliveryCount: 0,
    failedCount,
    settlementFailed: failedCount > 0,
    retried: true,
    ...(failedCount > 0 ? { code: TOKEN_SETTLEMENT_FAILED_CODE } : {}),
  })
}

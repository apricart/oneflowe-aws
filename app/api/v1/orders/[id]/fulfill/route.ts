import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { orders } from "@/db/schema"
import { eq } from "drizzle-orm"
import { getCurrentUser } from "@/lib/auth"
import { verifyApprovalToken } from "@/lib/approval-token"
import { logFulfillmentAttempt } from "@/lib/global-logger"
import { orderSelectColumns } from "@/lib/order-select"
import { fulfillApprovedOrder, type OrderFulfillmentOutcome } from "@/lib/server/order-fulfillment"
import { fulfillmentSchema, validationMessage } from "@/lib/server/mutation-validation"

function fulfillmentOutcomeResponse(outcome: OrderFulfillmentOutcome) {
  if (outcome === "conflict") {
    return error("Order was already fulfilled or otherwise changed", 409)
  }
  if (outcome === "ledger-conflict") {
    return error("Order budget hold is inconsistent; fulfilment was not applied", 409)
  }
  if (outcome === "migration-missing") {
    return error("Fulfillment progress migration has not been applied", 503)
  }
  return null
}

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  // Order fulfillment remains a Super Admin-only responsibility.
  const err = await requireApiRole(["SUPER_ADMIN"])
  if (err) return err

  const params = await props.params
  const orderId = Number(params.id)
  if (!Number.isInteger(orderId) || orderId <= 0) return error("Invalid order ID", 400)
  const user = await getCurrentUser()
  const rawBody = await readJson<unknown>(req)
  const parsedBody = fulfillmentSchema.safeParse(rawBody)

  if (!user) return error("Unauthorized", 401)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const input = parsedBody.data

  // Fetch order
  const [ord] = await db.select(orderSelectColumns).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!ord) return error("Order not found", 404)

  // BOLA
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(ord.organizationId, ord.branchId)
  if (!hasAccess) return error("Forbidden", 403)

  if (ord.status.toUpperCase() !== "APPROVED") {
    return error(`Cannot fulfill order in ${ord.status} state`, 400)
  }

  if (!ord.approvalTokenHash) {
    return error("Order has no approval token - cannot fulfill", 400)
  }

  const isValid = await verifyApprovalToken(input.approvalToken, ord.approvalTokenHash)

  if (!isValid) {
    logFulfillmentAttempt(
      orderId,
      ord.tid,
      user.id,
      user.email || "unknown",
      user.role,
      false,
      "Invalid token provided"
    )
    return error("Invalid approval token - fulfillment denied", 403)
  }

  const outcome = await fulfillApprovedOrder({
    orderId,
    organizationId: ord.organizationId,
    branchId: ord.branchId,
    fulfilledByUserId: user.id,
  })

  const failure = fulfillmentOutcomeResponse(outcome)
  if (failure) return failure

  return ok({ message: "Order fulfilled successfully" })
}

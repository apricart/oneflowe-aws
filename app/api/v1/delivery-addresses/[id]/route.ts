import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import { DELIVERY_ADDRESS_DECISION_ROLES } from "@/lib/delivery-address-access"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { writeDeliveryAddressAudit } from "@/lib/server/delivery-address-audit"
import { resolveDeliveryAddressApproverScope } from "@/lib/server/delivery-address-scope"
import { decideDeliveryAddressRequest } from "@/lib/server/delivery-addresses"
import {
  deliveryAddressDecisionSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

/**
 * PATCH /api/v1/delivery-addresses/[id] — approve or reject one request.
 *
 * **The only route in the application that makes a delivery address usable.**
 * Without a call to this, the row stays pending and no order can name it: the
 * order-creation guard reads `status = 'approved'` and nothing else can write
 * that status.
 *
 * It admits Head Office alone (`DELIVERY_ADDRESS_DECISION_ROLES`). The four
 * requester roles are refused here although they may raise a request, which is
 * the whole shape of the feature — a branch may say where it needs goods, and
 * cannot decide it.
 *
 * The fence is the pair `(id, organizationId-from-session)` in the `WHERE` of
 * the `FOR UPDATE` lock inside `decideDeliveryAddressRequest`. An address
 * belonging to another tenant is therefore *not found* rather than forbidden —
 * the same answer as one that does not exist, so the id space cannot be
 * enumerated.
 *
 * Replay is that same lock plus the status check: two administrators deciding
 * at once produce one decision and one 409, and a retried approval of an
 * already-decided address is a 409 rather than a second approval.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const authError = await requireApiRole(DELIVERY_ADDRESS_DECISION_ROLES)
    if (authError) return authError

    const scope = await resolveDeliveryAddressApproverScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const { id } = await params
    // Digits only, before parsing. `Number.parseInt` would read "1.5" and
    // "1abc" as 1 and go on to decide address 1 — a different row than the
    // caller named, on an endpoint that opens a delivery destination.
    if (!/^\d+$/.test(id)) return error("Invalid delivery address id", 400)
    const addressId = Number.parseInt(id, 10)
    if (!Number.isSafeInteger(addressId) || addressId <= 0) {
      return error("Invalid delivery address id", 400)
    }

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsed = deliveryAddressDecisionSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    const outcome = await decideDeliveryAddressRequest({
      addressId,
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      decision: input.decision,
      reason: input.reason ?? null,
    })

    if (!outcome.ok) return error(outcome.message, outcome.status)

    await writeDeliveryAddressAudit({
      action: outcome.status === "approved"
        ? "APPROVE_BRANCH_DELIVERY_ADDRESS"
        : "REJECT_BRANCH_DELIVERY_ADDRESS",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      actorRole: "HEAD_OFFICE",
      entityId: String(outcome.addressId),
      metadata: {
        branchId: outcome.branchId,
        label: outcome.label,
        requestedByUserId: outcome.requestedByUserId,
        reasonGiven: Boolean(input.reason),
      },
    })

    return ok({ id: outcome.addressId, status: outcome.status })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "decide delivery address")
    return error(message, status)
  }
}

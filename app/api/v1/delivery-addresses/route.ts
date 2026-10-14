import { getRequestScope } from "@/lib/auth"
import { isOrganizationViewer } from "@/lib/viewer-access"
import type { NextRequest } from "next/server"

import { error, ok, readJson, requireApiRole } from "@/lib/api"
import {
  MAX_DELIVERY_ADDRESS_PAGE,
  isDeliveryAddressStatus,
} from "@/lib/delivery-address"
import {
  DELIVERY_ADDRESS_READ_ROLES,
  DELIVERY_ADDRESS_REQUEST_ROLES,
} from "@/lib/delivery-address-access"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { writeDeliveryAddressAudit } from "@/lib/server/delivery-address-audit"
import {
  resolveDeliveryAddressApproverScope,
  resolveDeliveryAddressRequesterScope,
} from "@/lib/server/delivery-address-scope"
import {
  countPendingDeliveryAddresses,
  createDeliveryAddressRequest,
  listDeliveryAddresses,
  listRequestableBranches,
  type DeliveryAddressListScope,
} from "@/lib/server/delivery-addresses"
import {
  deliveryAddressCreateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"

export const dynamic = "force-dynamic"

type ReadableScope = {
  ok: true
  organizationId: number
  actorUserId: string
  branches: DeliveryAddressListScope
  /** The branches this caller may raise a request for — empty for the decider. */
  requestableBranchIds: number[]
  canDecide: boolean
}

/**
 * What this caller may read, resolved from the session.
 *
 * Head Office reads its whole tenant because it decides for the whole tenant;
 * every other admitted role reads only the branches it is assigned to. A
 * `branchId` on the query string **narrows** that and can never widen it: for a
 * requester it is intersected with the resolved set, so naming another tenant's
 * branch yields an empty list rather than that branch's addresses; for Head
 * Office it narrows within a tenant predicate that is still applied.
 */
async function resolveReadableScope(
  branchIdParam: string | null,
): Promise<ReadableScope | { ok: false; response: Response }> {
  let requested: number | null = null
  if (branchIdParam !== null) {
    if (!/^\d+$/.test(branchIdParam)) {
      return { ok: false, response: error("Invalid branch id", 400) }
    }
    requested = Number.parseInt(branchIdParam, 10)
    if (!Number.isSafeInteger(requested) || requested <= 0) {
      return { ok: false, response: error("Invalid branch id", 400) }
    }
  }

  // An organization-wide Viewer reads the tenant's list as Head Office does,
  // and decides nothing: `canDecide` stays false, and the decision handler
  // refuses the role regardless.
  const caller = await getRequestScope()
  if (caller && isOrganizationViewer(caller)) {
    return {
      ok: true,
      organizationId: Number(caller.organizationId),
      actorUserId: caller.userId,
      branches: requested === null
        ? { scope: "tenant" }
        : { scope: "branches", branchIds: [requested] },
      requestableBranchIds: [],
      canDecide: false,
    }
  }

  const approver = await resolveDeliveryAddressApproverScope()
  if (approver.ok) {
    return {
      ok: true,
      organizationId: approver.organizationId,
      actorUserId: approver.actorUserId,
      branches: requested === null
        ? { scope: "tenant" }
        : { scope: "branches", branchIds: [requested] },
      // Head Office decides requests; it does not raise them, so it is offered
      // no branch to raise one for.
      requestableBranchIds: [],
      canDecide: true,
    }
  }

  const requester = await resolveDeliveryAddressRequesterScope()
  if (!requester.ok) return requester

  return {
    ok: true,
    organizationId: requester.organizationId,
    actorUserId: requester.actorUserId,
    branches: {
      scope: "branches",
      branchIds: requested === null
        ? requester.branchIds
        : requester.branchIds.filter((id) => id === requested),
    },
    // Unfiltered by the query string: narrowing what is *listed* must not
    // narrow what the requester may raise a request for.
    requestableBranchIds: requester.branchIds,
    canDecide: false,
  }
}

/**
 * GET /api/v1/delivery-addresses — the addresses at the branches this caller
 * reaches, whatever their status.
 *
 * A requester sees its own branches' addresses including the ones still
 * pending, because the point of a queue is that the branch can see it is
 * waiting. Head Office sees the tenant's.
 *
 * `status` is validated against `DELIVERY_ADDRESS_STATUSES` rather than
 * reaching SQL as a string, and the page is bounded at
 * `MAX_DELIVERY_ADDRESS_PAGE` whatever `limit` asks for.
 */
export async function GET(req: NextRequest) {
  try {
    const authError = await requireApiRole(DELIVERY_ADDRESS_READ_ROLES, { viewerReadsAsHeadOffice: true })
    if (authError) return authError

    const { searchParams } = new URL(req.url)
    const scope = await resolveReadableScope(searchParams.get("branchId"))
    if (!scope.ok) return scope.response

    const statusParam = searchParams.get("status")
    if (statusParam !== null && !isDeliveryAddressStatus(statusParam)) {
      return error("Unknown status filter", 400)
    }

    const limitParam = Number(searchParams.get("limit"))
    const limit = Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_DELIVERY_ADDRESS_PAGE)
      : MAX_DELIVERY_ADDRESS_PAGE

    const [items, requestableBranches] = await Promise.all([
      listDeliveryAddresses({
        organizationId: scope.organizationId,
        branches: scope.branches,
        status: statusParam ?? undefined,
        limit,
      }),
      listRequestableBranches({
        organizationId: scope.organizationId,
        branchIds: scope.requestableBranchIds,
      }),
    ])

    // For the decider, counted separately rather than from `items`, which a
    // status filter or the page bound can make an undercount — the badge must
    // not go stale silently. A requester's count is over what it can see.
    const pendingCount = scope.canDecide
      ? await countPendingDeliveryAddresses(scope.organizationId)
      : items.filter((item) => item.status === "pending").length

    return ok({ items, pendingCount, requestableBranches, canDecide: scope.canDecide })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "list delivery addresses")
    return error(message, status)
  }
}

/**
 * POST /api/v1/delivery-addresses — ask for an extra delivery address.
 *
 * Admits the four requester roles and **not** Head Office: the decider does not
 * raise its own requests, so an approval always has two parties on it.
 *
 * The branch named in the body is checked against the caller's own resolved set
 * before anything is written. That set comes from the session — a single-branch
 * role's own branch, a group role's assignments — and an empty set was already
 * refused by the scope resolver rather than widened to the tenant.
 *
 * The row is always created `pending`; `deliveryAddressCreateSchema` has no
 * field that could make it anything else.
 */
export async function POST(req: NextRequest) {
  try {
    const authError = await requireApiRole(DELIVERY_ADDRESS_REQUEST_ROLES)
    if (authError) return authError

    const scope = await resolveDeliveryAddressRequesterScope()
    if (!scope.ok) return scope.response

    const rateLimit = await withRateLimit("sensitive", scope.actorUserId)
    if (rateLimit) return rateLimit

    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsed = deliveryAddressCreateSchema.safeParse(rawBody)
    if (!parsed.success) return error(validationMessage(parsed.error), 400)
    const input = parsed.data

    if (!scope.branchIds.includes(input.branchId)) {
      return error("You are not assigned to that branch", 403)
    }

    const outcome = await createDeliveryAddressRequest({
      organizationId: scope.organizationId,
      branchId: input.branchId,
      requestedByUserId: scope.actorUserId,
      // Picked field by field rather than spread, so a future schema addition
      // cannot become a written column by accident.
      label: input.label,
      address: input.address,
      city: input.city ?? null,
      province: input.province ?? null,
      contactPerson: input.contactPerson ?? null,
      contactPhone: input.contactPhone ?? null,
      requestReason: input.reason ?? null,
    })

    if (!outcome.ok) return error(outcome.message, outcome.status)

    await writeDeliveryAddressAudit({
      action: "REQUEST_BRANCH_DELIVERY_ADDRESS",
      organizationId: scope.organizationId,
      actorUserId: scope.actorUserId,
      actorRole: scope.role,
      entityId: String(outcome.address.id),
      metadata: {
        branchId: outcome.address.branchId,
        label: outcome.address.label,
        reasonGiven: Boolean(input.reason),
      },
    })

    return ok({ address: outcome.address }, { status: 201 })
  } catch (caughtError) {
    const { message, status } = handleError(caughtError, "request delivery address")
    return error(message, status)
  }
}

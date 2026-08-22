import { type NextRequest } from "next/server"

import { ok } from "@/lib/api"
import { requireGroupApprover } from "@/lib/server/group-order-access"
import {
  APPROVAL_PAGE_SIZE_DEFAULT,
  APPROVAL_PAGE_SIZE_MAX,
  type ApprovalFilter,
  getApprovalQueueSummary,
  listApprovalQueue,
} from "@/lib/server/group-order-approvals"

export const dynamic = "force-dynamic"

function parsePositiveInt(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseFilter(value: string | null): ApprovalFilter {
  return value === "all" ? "all" : "pending"
}

/**
 * The group orders this approver is responsible for, newest first, each grouped
 * under its group order reference and carrying only the branch orders inside
 * the approver's own scope.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupApprover()
  if (response) return response

  const { searchParams } = new URL(req.url)
  const requestedLimit = parsePositiveInt(searchParams.get("limit")) ?? APPROVAL_PAGE_SIZE_DEFAULT

  const [queue, summary] = await Promise.all([
    listApprovalQueue({
      organizationId: actor.organizationId,
      scopedBranchIds: actor.scopedBranchIds,
      page: parsePositiveInt(searchParams.get("page")) ?? 1,
      limit: Math.min(requestedLimit, APPROVAL_PAGE_SIZE_MAX),
      filter: parseFilter(searchParams.get("filter")),
    }),
    getApprovalQueueSummary(actor.organizationId, actor.scopedBranchIds),
  ])

  return ok({ ...queue, summary })
}

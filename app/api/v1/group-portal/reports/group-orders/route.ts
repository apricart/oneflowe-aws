import { type NextRequest } from "next/server"

import { error, ok } from "@/lib/api"
import { parseEndDateParam, parseStartDateParam } from "@/lib/date-range-params"
import { requireGroupApprover } from "@/lib/server/group-order-access"
import {
  GROUP_ORDER_REFERENCE_MAX_LENGTH,
  parseGroupFilterIds,
  parseGroupOrderReportStatus,
  parsePositiveInt,
  parseReportPageSize,
} from "@/lib/server/group-order-report-filters"
import {
  type GroupOrderReportFilters,
  getGroupOrderReportSummary,
  listGroupOrderReport,
  summarizeGroupOrdersByGroup,
} from "@/lib/server/group-order-reporting"

export const dynamic = "force-dynamic"

/**
 * The Group User's group order report.
 *
 * `view=groups` returns the same filtered set rolled up by group; anything else
 * returns the paginated group order rows plus the headline totals. Both are
 * scoped by `requireGroupApprover`, which resolves the caller's assigned
 * branches on the server — no branch, organization, or user identifier from the
 * query string is ever trusted here, and the filters below can only narrow what
 * that scope already allows.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupApprover()
  if (response) return response

  const { searchParams } = new URL(req.url)

  const reference = searchParams.get("reference")?.trim() ?? ""
  if (reference.length > GROUP_ORDER_REFERENCE_MAX_LENGTH) {
    return error(`Group order ID must be at most ${GROUP_ORDER_REFERENCE_MAX_LENGTH} characters`, 400)
  }

  const startDate = parseStartDateParam(searchParams.get("startDate"))
  const endDate = parseEndDateParam(searchParams.get("endDate"))
  if (startDate && endDate && startDate > endDate) {
    return error("startDate must not be after endDate", 400)
  }

  const filters: GroupOrderReportFilters = {
    reference,
    groupIds: parseGroupFilterIds(searchParams.get("groupIds")),
    status: parseGroupOrderReportStatus(searchParams.get("status")),
    startDate,
    endDate,
  }

  const scope = {
    organizationId: actor.organizationId,
    scopedBranchIds: actor.scopedBranchIds,
  }

  if (searchParams.get("view") === "groups") {
    const [byGroup, summary] = await Promise.all([
      summarizeGroupOrdersByGroup({ ...scope, filters }),
      getGroupOrderReportSummary({ ...scope, filters }),
    ])
    return ok({ byGroup, summary })
  }

  const [report, summary] = await Promise.all([
    listGroupOrderReport({
      ...scope,
      page: parsePositiveInt(searchParams.get("page")) ?? 1,
      limit: parseReportPageSize(searchParams.get("limit")),
      filters,
    }),
    getGroupOrderReportSummary({ ...scope, filters }),
  ])

  return ok({ ...report, summary })
}

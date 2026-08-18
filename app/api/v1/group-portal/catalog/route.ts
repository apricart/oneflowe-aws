import { type NextRequest } from "next/server"

import { error, ok } from "@/lib/api"
import { requireGroupOrderPortal } from "@/lib/server/group-order-access"
import {
  CATALOG_PAGE_SIZE_DEFAULT,
  CATALOG_PAGE_SIZE_MAX,
  loadGroupCatalog,
} from "@/lib/server/group-order-catalog"
import { resolveSubmissionScope } from "@/lib/server/group-order-portal"

export const dynamic = "force-dynamic"

const MAX_SEARCH_LENGTH = 100

function parsePositiveInt(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** `branchIds=1,2,3`. Anything non-numeric is dropped rather than coerced. */
function parseBranchIds(value: string | null): number[] {
  if (!value) return []
  return [...new Set(
    value
      .split(",")
      .map((part) => parsePositiveInt(part.trim()))
      .filter((id): id is number => id !== undefined),
  )]
}

/** `groupId=null` (or omitted) selects the ungrouped bucket. */
function parseGroupId(value: string | null): number | null {
  return parsePositiveInt(value) ?? null
}

/**
 * Products orderable for a chosen set of branches within one group.
 *
 * The branch set is authorized against the caller's live assignments before a
 * single catalogue row is read, so this endpoint cannot be used to enumerate
 * inventory for branches the user was not given.
 */
export async function GET(req: NextRequest) {
  const { actor, response } = await requireGroupOrderPortal()
  if (response) return response

  const { searchParams } = new URL(req.url)
  const branchIds = parseBranchIds(searchParams.get("branchIds"))

  const { scope, failure } = await resolveSubmissionScope({
    userId: actor.scope.userId,
    organizationId: actor.organizationId,
    groupId: parseGroupId(searchParams.get("groupId")),
    branchIds,
  })
  if (failure) return error(failure.message, failure.status)

  const search = (searchParams.get("search") || "").slice(0, MAX_SEARCH_LENGTH)
  const requestedLimit = parsePositiveInt(searchParams.get("limit")) ?? CATALOG_PAGE_SIZE_DEFAULT

  const catalog = await loadGroupCatalog({
    organizationId: actor.organizationId,
    branchIds: scope.branches.map((branch) => branch.id),
    search,
    categoryId: parsePositiveInt(searchParams.get("category")),
    subCategoryId: parsePositiveInt(searchParams.get("subCategory")),
    page: parsePositiveInt(searchParams.get("page")) ?? 1,
    limit: Math.min(requestedLimit, CATALOG_PAGE_SIZE_MAX),
  })

  return ok(catalog)
}

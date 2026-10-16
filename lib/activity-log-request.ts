import { z } from "zod"

import {
  ACTIVITY_ACTION_MAX_LENGTH,
  ACTIVITY_ACTOR_ROLES,
  ACTIVITY_CATEGORIES,
  ACTIVITY_OPERATIONS,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  ACTIVITY_SEARCH_MAX_LENGTH,
  ACTIVITY_SOURCES,
  clampPageSize,
  decodeActivityCursor,
  resolveWindow,
  type ActivityRequestFilters,
  type ActivitySource,
} from "@/lib/activity-log"

/**
 * The activity log's query string, validated into `ActivityRequestFilters`.
 *
 * What this returns is what the caller *asked for*. It carries no reach: whose
 * trail may be read is decided from the caller's account in
 * `lib/activity-log-access.ts`, and only that turns these into the
 * `ActivityFilters` a query can be built from.
 *
 * Kept out of the route handler and free of any database import so the whole
 * parse — every bound, every allowlist, every refusal — is unit-testable
 * without Postgres. The route's job is to call this and respond.
 *
 * Unknown parameters are refused rather than ignored: a caller who misspells
 * `organizationId` should be told, not handed an unfiltered page of a
 * cross-tenant trail.
 */

const trimmedString = (max: number) => z.string().trim().max(max)

const isoDate = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "must be an ISO date" })
  .transform((value) => new Date(value))

const sourceList = trimmedString(64).transform((value, ctx) => {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return null
  const out: ActivitySource[] = []
  for (const part of parts) {
    if (!(ACTIVITY_SOURCES as readonly string[]).includes(part)) {
      ctx.addIssue({ code: "custom", message: `source must be one of ${ACTIVITY_SOURCES.join(", ")}` })
      return z.NEVER
    }
    if (!out.includes(part as ActivitySource)) out.push(part as ActivitySource)
  }
  return out
})

export const activityLogQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_SIZE_MAX).optional(),
    cursor: trimmedString(256).optional(),
    source: sourceList.optional(),
    operation: z.enum(ACTIVITY_OPERATIONS).optional(),
    category: z.enum(ACTIVITY_CATEGORIES).optional(),
    action: trimmedString(ACTIVITY_ACTION_MAX_LENGTH).optional(),
    organizationId: z.coerce.number().int().positive().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    actorId: trimmedString(128).optional(),
    actorRole: z.enum(ACTIVITY_ACTOR_ROLES).optional(),
    // Only ever the two literals, so a typo cannot silently mean "all".
    outcome: z.enum(["success", "failure"]).optional(),
    search: trimmedString(ACTIVITY_SEARCH_MAX_LENGTH).optional(),
  })
  .strict()

export type ActivityLogQuery = z.infer<typeof activityLogQuerySchema>

export type ActivityRequestResult =
  | { ok: true; filters: ActivityRequestFilters }
  | { ok: false; error: string; field?: string }

/** The first issue, named by its field, so a 400 says which parameter was wrong. */
function firstIssue(error: z.ZodError): { error: string; field?: string } {
  const issue = error.issues[0]
  const field = issue?.path.join(".") || undefined
  return { error: field ? `${field}: ${issue.message}` : issue?.message ?? "Invalid query", field }
}

export function parseActivityLogRequest(
  searchParams: URLSearchParams,
  now: Date = new Date(),
): ActivityRequestResult {
  const raw: Record<string, string> = {}
  for (const [key, value] of searchParams.entries()) {
    // An empty parameter is how a cleared filter arrives from a form; treat it
    // as absent rather than as a value that fails validation.
    if (value.trim().length === 0) continue
    raw[key] = value
  }

  const parsed = activityLogQuerySchema.safeParse(raw)
  if (!parsed.success) return { ok: false, ...firstIssue(parsed.error) }

  const query = parsed.data

  const window = resolveWindow(query.from ?? null, query.to ?? null, now)
  if ("error" in window) return { ok: false, error: window.error, field: "from" }

  let cursor = null
  if (query.cursor !== undefined) {
    cursor = decodeActivityCursor(query.cursor)
    if (cursor === null) {
      // Never silently restart at page one: a caller paging through a trail
      // would read the repeat as new activity.
      return { ok: false, error: "cursor is not a valid pagination cursor", field: "cursor" }
    }
  }

  let outcome: boolean | null = null
  if (query.outcome === "success") outcome = true
  if (query.outcome === "failure") outcome = false

  return {
    ok: true,
    filters: {
      from: window.window.from,
      to: window.window.to,
      limit: clampPageSize(query.limit ?? ACTIVITY_PAGE_SIZE_DEFAULT),
      cursor,
      sources: query.source ?? null,
      operation: query.operation ?? null,
      category: query.category ?? null,
      action: query.action ?? null,
      organizationId: query.organizationId ?? null,
      branchId: query.branchId ?? null,
      actorId: query.actorId ?? null,
      actorRole: query.actorRole ?? null,
      success: outcome,
      search: query.search ?? null,
    },
  }
}

import "server-only"

import { sql, type AnyColumn, type SQL } from "drizzle-orm"

import type { SortDirection } from "@/lib/table-sort"

/**
 * One ORDER BY term for an allowlisted sort. The direction is one of two
 * literal fragments rather than request text, and blanks sort last in both
 * directions to match `compareSortValues` on the client.
 */
export function orderBySortSql(expression: SQL | AnyColumn, direction: SortDirection): SQL {
  return direction === "asc"
    ? sql`${expression} ASC NULLS LAST`
    : sql`${expression} DESC NULLS LAST`
}

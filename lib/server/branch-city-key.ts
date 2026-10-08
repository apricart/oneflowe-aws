import "server-only"

import { sql, type SQL, type SQLWrapper } from "drizzle-orm"

/**
 * The key a free-text city is grouped and matched by: whitespace runs collapsed
 * to one space, trimmed, lower-cased — so "Karachi", " karachi " and "KARACHI"
 * are one city. Blank or NULL gives "" or NULL, which is never a city.
 *
 * Computed only in SQL, on both sides of every comparison (the branch column
 * and the city Super Admin names), so a JavaScript/Postgres difference in case
 * folding or whitespace can never split one city into two. The
 * `branches_city_key_idx` expression index is this exact expression over
 * `branches.city`; change one and the other must follow.
 * See plans/OF-WAREHOUSE-city-assignments.md.
 */
export function branchCityKeySql(value: SQLWrapper | string): SQL<string | null> {
  return sql<string | null>`lower(btrim(regexp_replace(${value}, '\\s+', ' ', 'g')))`
}

/** The display form of a city: whitespace collapsed and trimmed, case kept. */
export function branchCityLabelSql(value: SQLWrapper | string): SQL<string | null> {
  return sql<string | null>`btrim(regexp_replace(${value}, '\\s+', ' ', 'g'))`
}

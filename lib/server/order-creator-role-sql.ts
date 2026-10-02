import "server-only"

import { and, eq, exists, inArray, isNull, or, sql } from "drizzle-orm"

import { orders, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { ORDER_CREATOR_ROLES } from "@/lib/group-order-visibility"

/**
 * The role an order's creator held when they raised it.
 *
 * Attribution reports group orders by the *requester role*. Read live from
 * `users` → `roles`, that role is whatever the person is today, so promoting an
 * `ORDER_PORTAL` user to `BRANCH_ADMIN` silently removes every order they ever
 * raised from the reports an administrator relies on — and demoting one adds
 * orders that were never a requester's. `orders.created_by_role` pins it at
 * creation instead, exactly as `status_at_refund` pins the status a refund was
 * taken against.
 *
 * Every reader goes through this module rather than writing its own COALESCE,
 * so the fallback rule is stated once. `lib/server/order-creator-role.test.ts`
 * lists the readers; a new one goes on that list or it is free to drift.
 *
 * ## The fallback
 *
 * The column is nullable and rows written before it existed carry NULL. For
 * those, and only those, the live join is consulted — which reproduces exactly
 * the behaviour every one of these reports had before this change. Once
 * `npm run backfill:order-creator-roles` has run the fallback matches nothing,
 * but it is kept for a release so that a re-run, a restore, or an order written
 * by a path we missed cannot produce a silently unattributed row.
 *
 * The fallback is deliberately *not* "treat NULL as not-a-requester". That
 * would drop the entire pre-migration history out of every attribution report
 * the moment this shipped.
 */

/**
 * `COALESCE(orders.created_by_role, roles.name)` — the effective creator role.
 *
 * Requires the query to have joined `users` and `roles` to `orders`. Use
 * `orderCreatedByRoleMatches` instead where no such join exists.
 */
export const effectiveCreatorRoleSql = sql<string>`COALESCE(${orders.createdByRole}, ${roles.name})`

/** `('A', 'B')` — a role list as a parameterized SQL tuple. */
function roleTuple(roleNames: readonly string[]) {
  return sql.join(roleNames.map((roleName) => sql`${roleName}`), sql`, `)
}

/**
 * True for an order raised by one of the requester roles.
 *
 * Requires `users` and `roles` joined to `orders`.
 */
export const isRequesterCreatedOrderSql = sql<boolean>`${effectiveCreatorRoleSql} IN (${roleTuple(ORDER_CREATOR_ROLES)})`

/**
 * One creator role for a **group of orders**, for an aggregate that must emit
 * exactly one row per person.
 *
 * Why this is not just `effectiveCreatorRoleSql`: that is per row, and once a
 * user's role can change, one person's orders in a single window can carry two
 * different recorded roles. Putting a per-row expression in a `GROUP BY` then
 * splits that person into two rows — and the budget-burn panel keys creators on
 * `userId:branchId` (`creatorKey`), so the split either lists the same person
 * twice with their spend divided, or, in `unionCreators`, silently drops the
 * second row and understates what they consumed. Both misreport the money.
 *
 * So the role collapses to one value per group: a **requester role if the person
 * raised any order in the window under one**, otherwise whatever else they were.
 * A mid-window promotion therefore stays a single row carrying that person's
 * whole consumption, which is what a burn watchlist is asking about, and the
 * branch denominator is unaffected either way because it sums every row.
 *
 * Requires `users` and `roles` joined to `orders`, and must be used with a
 * `GROUP BY` that does **not** mention the role.
 */
export const aggregatedRequesterRoleSql = sql<string>`COALESCE(
  MAX(CASE WHEN ${effectiveCreatorRoleSql} IN (${roleTuple(ORDER_CREATOR_ROLES)})
           THEN ${effectiveCreatorRoleSql} END),
  MAX(${effectiveCreatorRoleSql})
)`

/**
 * A predicate selecting orders whose creator held `creatorRole` when they
 * raised them, for a query that has **not** joined `users`/`roles`.
 *
 * The recorded value answers directly; a row that predates the column falls
 * back to an EXISTS over the creator's current role. Written as an OR rather
 * than a join so it can be dropped into an existing condition list without
 * changing the shape of the surrounding query.
 */
export function orderCreatedByRoleMatches(creatorRole: string) {
  return or(
    eq(orders.createdByRole, creatorRole),
    and(
      isNull(orders.createdByRole),
      exists(
        db
          .select({ one: sql`1` })
          .from(users)
          .innerJoin(roles, eq(users.roleId, roles.id))
          .where(and(
            eq(users.id, orders.createdByUserId),
            eq(roles.name, creatorRole),
          )),
      ),
    ),
  )
}

/**
 * The same predicate for "any requester role", used where a report lists the
 * people who raise orders rather than one specific role.
 */
export function orderCreatedByAnyRequesterRole() {
  return or(...ORDER_CREATOR_ROLES.map((roleName) => orderCreatedByRoleMatches(roleName)))
}

/**
 * Has this person ever raised an order *as a requester*?
 *
 * Correlated to `users.id`, for a query selecting from `users`. The requester
 * filter list uses it as one arm of a union with the person's current role:
 * current role alone drops a requester who has since been moved to another
 * role — taking their whole history out of reach of the filter meant to find
 * it — and this alone drops someone who has not raised an order yet.
 *
 * Deliberately reads `created_by_role` directly rather than through the
 * COALESCE fallback above. For a row predating the column the fallback resolves
 * to the creator's *current* role, which is exactly what the other arm of that
 * union already covers, so consulting it here would widen nothing and cost a
 * second join.
 */
export const hasRaisedOrderAsRequesterSql = exists(
  db
    .select({ one: sql`1` })
    .from(orders)
    .where(and(
      eq(orders.createdByUserId, users.id),
      inArray(orders.createdByRole, [...ORDER_CREATOR_ROLES]),
    )),
)

/**
 * Did this person raise an order **at one of these branches**, as a requester?
 *
 * The branch half of the same question, and the reason it exists is the group
 * roles. A `GROUP_ORDER_PORTAL` user has no `users.branch_id`; it reaches
 * branches through `user_branch_assignments`/`user_group_assignments`, which
 * `resolveUsersScopedToBranches` reads. Those rows are **deleted** when the
 * user moves off a group role (`resolveNextScope` → `action: "clear"`), so
 * after the switch nothing connects that person to the branches they spent a
 * year ordering for: their orders stay in the branch's totals while the person
 * vanishes from the filter meant to select them.
 *
 * `orders.branch_id` does not move and `orders.created_by_role` does not
 * change, so this answers from the orders themselves and is immune to both the
 * role change and the assignment clear.
 *
 * An empty `branchIds` matches nothing — never everything.
 */
export function raisedOrderAtBranchesSql(branchIds: number[]) {
  if (branchIds.length === 0) return sql`false`
  return exists(
    db
      .select({ one: sql`1` })
      .from(orders)
      .where(and(
        eq(orders.createdByUserId, users.id),
        inArray(orders.branchId, branchIds),
        inArray(orders.createdByRole, [...ORDER_CREATOR_ROLES]),
      )),
  )
}

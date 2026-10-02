import type { Role } from "@/lib/rbac"

/**
 * Who may ask for an extra delivery address, and who may grant one.
 *
 * Two separate lists, because they are two separate authorities and the whole
 * point of the feature is that they do not overlap: raising a request confers
 * nothing, and a requester approving its own request would make the approval
 * ceremonial.
 *
 * These are role allowlists rather than `Permission` entries, following
 * `lib/organization-join-access.ts` and `lib/user-management-access.ts`, for
 * two reasons a permission cannot meet: `ROLE_TEMPLATES.SUPER_ADMIN` is
 * `Object.values(Permission)`, so any new permission is granted to Super Admin
 * by construction; and `rolePermissions` rows exist only after `db:seed` has
 * run, so a fresh environment would have the check pass or fail depending on
 * seeding rather than on the rule.
 */

/**
 * The roles that may raise a request, for a branch they are assigned to.
 *
 * The same four roles that act for a branch: two pinned to one branch, two
 * acting across an assigned set. This mirrors `ORDER_WRITE_ROLES` in
 * `lib/order-write-access.ts` and its reasoning — **the branch owns the
 * request, not its author**. Whoever at a branch discovers that goods need to
 * go somewhere else may say so; nobody at the branch can decide it.
 *
 * `HEAD_OFFICE` is absent because it decides, and `SUPER_ADMIN` and `VIEWER`
 * because neither acts for a branch. The branch set itself is always resolved
 * server-side from the session — this list says *which roles*, never *which
 * branches*.
 */
export const DELIVERY_ADDRESS_REQUEST_ROLES: Role[] = [
  "ORDER_PORTAL",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "GROUP_USER",
]

/**
 * The roles that may approve or reject one.
 *
 * **Head Office alone**, and only ever in its own organization. Where a
 * tenant's goods may be sent is the tenant's own arrangement, so the decision
 * belongs to the tenant's own administrator — the same reasoning that makes
 * Head Office the sole decider of who joins the tenant at all.
 *
 * `SUPER_ADMIN` is deliberately absent. It can already edit a branch's own
 * address through branch administration, which is a separate and separately
 * audited act; what it cannot do is quietly add a delivery destination to a
 * tenant through that tenant's own approval queue. Admitting it later is one
 * entry in this array and one row in the access test.
 */
export const DELIVERY_ADDRESS_DECISION_ROLES: Role[] = ["HEAD_OFFICE"]

export function canRequestDeliveryAddress(role: unknown): role is Role {
  return (
    typeof role === "string" &&
    DELIVERY_ADDRESS_REQUEST_ROLES.includes(role as Role)
  )
}

export function canDecideDeliveryAddress(role: unknown): role is Role {
  return (
    typeof role === "string" &&
    DELIVERY_ADDRESS_DECISION_ROLES.includes(role as Role)
  )
}

/**
 * The roles that may *read* a branch's delivery addresses: everyone who may
 * request one, plus the Head Office that decides them.
 *
 * Derived rather than listed, so a role added to either authority cannot end
 * up able to act on a list it is not allowed to see.
 */
export const DELIVERY_ADDRESS_READ_ROLES: Role[] = [
  ...DELIVERY_ADDRESS_REQUEST_ROLES,
  ...DELIVERY_ADDRESS_DECISION_ROLES,
]

export function canReadDeliveryAddresses(role: unknown): role is Role {
  return (
    typeof role === "string" &&
    DELIVERY_ADDRESS_READ_ROLES.includes(role as Role)
  )
}

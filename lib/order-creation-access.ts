/**
 * Who may create a single-branch order through `POST /api/v1/orders`.
 *
 * The route had no role check at all, so any authenticated session with a
 * branch on it could raise an order — including a branch-pinned read-only
 * `VIEWER` (`tests/e2e/viewer-role.spec.ts`). This list keeps every role that
 * places an order through that route today and refuses the rest:
 *
 *   * `ORDER_PORTAL` and the synthesized `EMPLOYEE` login — the shop;
 *   * `BRANCH_ADMIN` — its own branch, from the session;
 *   * `HEAD_OFFICE` and `SUPER_ADMIN` — a branch they name, fenced to the
 *     tenant by the route;
 *   * `ORDER_DESK` — a branch it names, fenced by `lib/order-desk-access.ts`.
 *
 * The group roles order through `/api/v1/group-portal/orders` and never had a
 * branch on their session to order here with, so refusing them changes
 * nothing they can do.
 */
export const ORDER_CREATION_ROLES = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "ORDER_PORTAL",
  "EMPLOYEE",
  "ORDER_DESK",
] as const

export function mayCreateOrder(role: unknown): boolean {
  return typeof role === "string" && (ORDER_CREATION_ROLES as readonly string[]).includes(role)
}

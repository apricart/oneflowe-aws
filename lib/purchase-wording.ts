/**
 * Which word a role reads for the money its orders carry.
 *
 * Apricart sells; every tenant role buys. The same figure is "Revenue" to the
 * Super Admin and "Purchased" to a Head Office, Branch Admin, Group User,
 * Viewer, or either ordering portal. The rule is stated as the one seller role
 * rather than as a list of buyers, so a role added later reads purchase wording
 * until someone decides otherwise — a client must never be told about revenue.
 *
 * Wording only: this grants and withholds nothing. Price visibility is
 * `lib/price-visibility.ts`; access is `lib/permissions.ts`.
 */

const SELLER_ROLE = "SUPER_ADMIN"

export function usesPurchaseWording(role: unknown): boolean {
  return role !== SELLER_ROLE
}

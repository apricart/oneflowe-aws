import type { Role } from "@/lib/rbac"

/**
 * Who manages Apricart's per-warehouse stock: Super Admin alone, on the
 * Warehouse Stock page. `proxy.ts` gates the page; the layout and every
 * endpoint behind it check the role again.
 * See plans/OF-STOCK-per-warehouse-stock.md.
 */

export const WAREHOUSE_STOCK_AREA = "/warehouse-stock"

export const WAREHOUSE_STOCK_MANAGER_ROLES: readonly Role[] = ["SUPER_ADMIN"]

export function canManageWarehouseStock(role: string | null | undefined): boolean {
  return typeof role === "string" && (WAREHOUSE_STOCK_MANAGER_ROLES as readonly string[]).includes(role)
}

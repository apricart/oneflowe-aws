/**
 * Who may do what in purchasing, in one place.
 * See plans/OF-PROCUREMENT-purchasing.md.
 *
 * Separation of duties is a set of capabilities, each a role allowlist —
 * deliberately not `Permission` keys, since `ROLE_TEMPLATES.SUPER_ADMIN` holds
 * every key by construction. One person may hold two capabilities when their
 * role holds both: Super Admin approves and may also receive.
 *
 * The Procurement role, modelled on Finance and Apricart Support:
 *
 *   * **No organization and no branch.** Purchasing is Apricart's own.
 *   * **Only Super Admin creates or manages one** (`ROLE_LEVEL` 7).
 *   * **Confined to `/procurement` and `PROCUREMENT_API_RULES`.** `proxy.ts`
 *     refuses every other API call before a handler runs; each listed handler
 *     checks the capability itself.
 */

import type { Role } from "@/lib/rbac"

export const PROCUREMENT_ROLE = "PROCUREMENT" as const
export const PROCUREMENT_LABEL = "Procurement"

export const PROCUREMENT_HOME = "/procurement"
export const PROCUREMENT_AREAS: readonly string[] = [PROCUREMENT_HOME]

export function isProcurementRole(role: unknown): role is typeof PROCUREMENT_ROLE {
  return role === PROCUREMENT_ROLE
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Who opens `/procurement` and reads POs with their costs. Finance reads only. */
export const PROCUREMENT_READ_ROLES: readonly Role[] = ["SUPER_ADMIN", PROCUREMENT_ROLE, "FINANCE"]
/** Suppliers; creating, editing, submitting, cancelling and closing POs; requisition decisions; shortages. */
export const PROCUREMENT_MANAGE_ROLES: readonly Role[] = ["SUPER_ADMIN", PROCUREMENT_ROLE]
/** Only Super Admin approves or rejects a PO. */
export const PURCHASE_ORDER_APPROVER_ROLES: readonly Role[] = ["SUPER_ADMIN"]
/** Recording a goods receipt on the procurement routes. The warehouse has its own routes. */
export const GOODS_RECEIPT_ADMIN_ROLES: readonly Role[] = ["SUPER_ADMIN"]
/** Recording a supplier invoice. */
export const SUPPLIER_INVOICE_RECORD_ROLES: readonly Role[] = ["SUPER_ADMIN", PROCUREMENT_ROLE, "FINANCE"]
/** Approving a matched invoice, rejecting one, marking one paid. */
export const SUPPLIER_INVOICE_DECIDE_ROLES: readonly Role[] = ["SUPER_ADMIN", "FINANCE"]
/** Approving an invoice that does not match. */
export const SUPPLIER_INVOICE_EXCEPTION_ROLES: readonly Role[] = ["SUPER_ADMIN"]
/** Customer returns on the procurement routes (any warehouse). The warehouse and executive have their own. */
export const CUSTOMER_RETURN_ADMIN_ROLES: readonly Role[] = ["SUPER_ADMIN"]
/** The over-delivery tolerance. */
export const PROCUREMENT_SETTINGS_ROLES: readonly Role[] = ["SUPER_ADMIN"]

function holds(roles: readonly Role[], role: unknown): boolean {
  return typeof role === "string" && (roles as readonly string[]).includes(role)
}

export const canReadProcurement = (role: unknown): boolean => holds(PROCUREMENT_READ_ROLES, role)
export const canManageProcurement = (role: unknown): boolean => holds(PROCUREMENT_MANAGE_ROLES, role)
export const canApprovePurchaseOrders = (role: unknown): boolean => holds(PURCHASE_ORDER_APPROVER_ROLES, role)
export const canRecordGoodsReceiptAsAdmin = (role: unknown): boolean => holds(GOODS_RECEIPT_ADMIN_ROLES, role)
export const canRecordSupplierInvoices = (role: unknown): boolean => holds(SUPPLIER_INVOICE_RECORD_ROLES, role)
export const canDecideSupplierInvoices = (role: unknown): boolean => holds(SUPPLIER_INVOICE_DECIDE_ROLES, role)
export const canApproveInvoiceExceptions = (role: unknown): boolean => holds(SUPPLIER_INVOICE_EXCEPTION_ROLES, role)
export const canAdministerCustomerReturns = (role: unknown): boolean => holds(CUSTOMER_RETURN_ADMIN_ROLES, role)
export const canChangeProcurementSettings = (role: unknown): boolean => holds(PROCUREMENT_SETTINGS_ROLES, role)

// ---------------------------------------------------------------------------
// The API allowlists
// ---------------------------------------------------------------------------

export type ProcurementApiRule = {
  /** The handler file, so a contract test can check it really admits the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

const ID = String.raw`\d+`

function rule(route: string, pattern: string, methods: readonly string[]): ProcurementApiRule {
  return { route: `app/api/v1/${route}/route.ts`, methods, pattern: new RegExp(`^/api/v1/${pattern}$`) }
}

const OWN_ACCOUNT_RULES: readonly ProcurementApiRule[] = [
  "users/me/change-password",
  "users/me/email-verification/send",
  "users/me/email-verification/verify",
].map((path) => rule(path, path, ["POST"]))

/** Every API request a Procurement session may make. */
export const PROCUREMENT_API_RULES: readonly ProcurementApiRule[] = [
  rule("procurement/suppliers", "procurement/suppliers", ["GET", "POST"]),
  rule("procurement/suppliers/[id]", `procurement/suppliers/${ID}`, ["PATCH"]),
  rule("procurement/warehouses", "procurement/warehouses", ["GET"]),
  rule("procurement/products", "procurement/products", ["GET"]),
  rule("procurement/requisitions", "procurement/requisitions", ["GET", "POST"]),
  rule("procurement/requisitions/[id]", `procurement/requisitions/${ID}`, ["PATCH"]),
  rule("procurement/purchase-orders", "procurement/purchase-orders", ["GET", "POST"]),
  rule("procurement/purchase-orders/[id]", `procurement/purchase-orders/${ID}`, ["GET", "PATCH"]),
  rule("procurement/supplier-invoices", "procurement/supplier-invoices", ["GET", "POST"]),
  rule("procurement/shortages", "procurement/shortages", ["GET"]),
  rule("procurement/settings", "procurement/settings", ["GET"]),
  ...OWN_ACCOUNT_RULES,
]

/**
 * What Finance may call in purchasing, on top of `FINANCE_API_RULES`: read the
 * POs with their costs, and record and decide supplier invoices. Purchasing is
 * Apricart's own, so none of it is fenced to Finance's organizations.
 */
export const FINANCE_PROCUREMENT_API_RULES: readonly ProcurementApiRule[] = [
  rule("procurement/suppliers", "procurement/suppliers", ["GET"]),
  rule("procurement/warehouses", "procurement/warehouses", ["GET"]),
  rule("procurement/purchase-orders", "procurement/purchase-orders", ["GET"]),
  rule("procurement/purchase-orders/[id]", `procurement/purchase-orders/${ID}`, ["GET"]),
  rule("procurement/supplier-invoices", "procurement/supplier-invoices", ["GET", "POST"]),
  rule("procurement/supplier-invoices/[id]", `procurement/supplier-invoices/${ID}`, ["PATCH"]),
  rule("procurement/settings", "procurement/settings", ["GET"]),
]

/**
 * The warehouse's own purchasing routes, folded into `WAREHOUSE_API_RULES`.
 * None of them selects a cost column.
 */
export const WAREHOUSE_PROCUREMENT_API_RULES: readonly ProcurementApiRule[] = [
  rule("warehouse/procurement/warehouses", "warehouse/procurement/warehouses", ["GET"]),
  rule("warehouse/procurement/products", "warehouse/procurement/products", ["GET"]),
  rule("warehouse/procurement/requisitions", "warehouse/procurement/requisitions", ["GET", "POST"]),
  rule("warehouse/procurement/requisitions/[id]", `warehouse/procurement/requisitions/${ID}`, ["PATCH"]),
  rule("warehouse/procurement/purchase-orders", "warehouse/procurement/purchase-orders", ["GET"]),
  rule("warehouse/procurement/purchase-orders/[id]", `warehouse/procurement/purchase-orders/${ID}`, ["GET"]),
  rule(
    "warehouse/procurement/purchase-orders/[id]/receipts",
    `warehouse/procurement/purchase-orders/${ID}/receipts`,
    ["POST"],
  ),
  rule("warehouse/procurement/returns", "warehouse/procurement/returns", ["GET", "POST"]),
]

/** The executive's customer-return approvals, folded into `APRICART_EXECUTIVE_API_RULES`. */
export const EXECUTIVE_RETURN_API_RULES: readonly ProcurementApiRule[] = [
  rule("executive/returns", "executive/returns", ["GET"]),
  rule("executive/returns/[id]", `executive/returns/${ID}`, ["PATCH"]),
]

function allowedBy(rules: readonly ProcurementApiRule[], method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  return rules.some((entry) => entry.methods.includes(verb) && entry.pattern.test(normalized))
}

/** Exact match after trailing-slash normalisation — never a prefix. */
export function isProcurementApiRequestAllowed(method: string, pathname: string): boolean {
  return allowedBy(PROCUREMENT_API_RULES, method, pathname)
}

export function isFinanceProcurementApiRequestAllowed(method: string, pathname: string): boolean {
  return allowedBy(FINANCE_PROCUREMENT_API_RULES, method, pathname)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function procurementUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Procurement accounts buy for every Apricart warehouse and are not assigned an organization or branch"
    : null
}

/**
 * The only access changes a Procurement account accepts through the
 * user-access route are activation and MFA: never into or out of the role, and
 * it has no reach to edit.
 */
export function procurementAccessChangeError(
  targetRole: string,
  input: {
    role?: string
    organizationId?: number | null
    branchId?: number | null
    groupIds?: number[]
    branchIds?: number[]
    budgetAllocationEnabled?: boolean
  },
): string | null {
  const nextRole = input.role ?? targetRole
  if (!isProcurementRole(targetRole) && !isProcurementRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Procurement; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "Procurement accounts buy for every Apricart warehouse and have no organization or branch to change"
  }
  return null
}

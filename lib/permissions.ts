/**
 * Comprehensive Permission System for Super Admin Control
 */

import { ROLE_DISPLAY_NAMES } from "@/lib/role-display-names"

export enum PermissionCategory {
  SYSTEM = "System Administration",
  ORGANIZATION = "Organization Management",
  USER = "User Management",
  INVENTORY = "Inventory Management",
  ORDER = "Order Management",
  FINANCIAL = "Financial Operations",
  REPORTS = "Reports & Analytics",
  SETTINGS = "Settings & Configuration",
  GROUP = "Group Management",
  SUPPORT = "Support & Communication",
}

export enum Permission {
  // System Administration
  SYSTEM_FULL_ACCESS = "system:full_access",
  SYSTEM_VIEW_AUDIT_LOGS = "system:view_audit_logs",
  SYSTEM_MANAGE_ROLES = "system:manage_roles",
  SYSTEM_MANAGE_PERMISSIONS = "system:manage_permissions",
  SYSTEM_VIEW_SYSTEM_HEALTH = "system:view_health",

  // Organization Management
  ORG_CREATE = "org:create",
  ORG_VIEW = "org:view",
  ORG_EDIT = "org:edit",
  ORG_DELETE = "org:delete",
  ORG_MANAGE_SETTINGS = "org:manage_settings",
  ORG_MANAGE_BRANCHES = "org:manage_branches",
  ORG_VIEW_METRICS = "org:view_metrics",
  // The activity log narrowed to one tenant. Distinct from
  // SYSTEM_VIEW_AUDIT_LOGS, which is the whole platform's trail and stays
  // Super Admin's alone. Enforced through `lib/activity-log-access.ts`.
  ORG_VIEW_AUDIT_LOGS = "org:view_audit_logs",

  // User Management
  USER_CREATE = "user:create",
  USER_VIEW = "user:view",
  USER_EDIT = "user:edit",
  USER_DELETE = "user:delete",
  USER_MANAGE_ROLES = "user:manage_roles",
  USER_RESET_PASSWORD = "user:reset_password",
  USER_MANAGE_MFA = "user:manage_mfa",
  USER_VIEW_SESSIONS = "user:view_sessions",

  // Inventory Management
  INVENTORY_CREATE = "inventory:create",
  INVENTORY_VIEW = "inventory:view",
  INVENTORY_EDIT = "inventory:edit",
  INVENTORY_DELETE = "inventory:delete",
  INVENTORY_ADJUST = "inventory:adjust",
  INVENTORY_TRANSFER = "inventory:transfer",
  INVENTORY_MANAGE_SUPPLIERS = "inventory:manage_suppliers",

  // Order Management
  ORDER_CREATE = "order:create",
  ORDER_VIEW = "order:view",
  ORDER_EDIT = "order:edit",
  ORDER_DELETE = "order:delete",
  ORDER_APPROVE = "order:approve",
  ORDER_REJECT = "order:reject",
  ORDER_CANCEL = "order:cancel",
  ORDER_VIEW_ALL = "order:view_all",

  // Financial Operations
  FINANCE_VIEW_BUDGETS = "finance:view_budgets",
  FINANCE_MANAGE_BUDGETS = "finance:manage_budgets",
  FINANCE_VIEW_REPORTS = "finance:view_reports",
  FINANCE_APPROVE_EXPENSES = "finance:approve_expenses",

  // Reports & Analytics
  REPORTS_VIEW_ALL = "reports:view_all",
  REPORTS_VIEW_ORGANIZATION = "reports:view_organization",
  REPORTS_VIEW_BRANCH = "reports:view_branch",
  REPORTS_EXPORT = "reports:export",
  REPORTS_SCHEDULE = "reports:schedule",

  // Settings & Configuration
  SETTINGS_VIEW = "settings:view",
  SETTINGS_EDIT = "settings:edit",
  SETTINGS_MANAGE_CATEGORIES = "settings:manage_categories",
  SETTINGS_MANAGE_PRODUCTS = "settings:manage_products",

  // Group Management
  GROUP_CREATE = "group:create",
  GROUP_VIEW = "group:view",
  GROUP_EDIT = "group:edit",
  GROUP_DELETE = "group:delete",
  GROUP_ASSIGN_BRANCH = "group:assign_branch",

  // Pricing — its own authority, held by Super Admin alone. Deliberately not
  // folded into the inventory, organization, or group sets: administering a
  // catalogue, a tenant, or a group must not carry the right to change what
  // anyone is charged. Enforced through `lib/pricing-access.ts`.
  PRICING_MANAGE = "pricing:manage",

  // Support & Communication — the direct channel between a client organization
  // and Apricart. View/create/reply belong to every role that can hold a
  // conversation; SUPPORT_MANAGE is Apricart's view of its own queue and is
  // held by the Apricart side alone — Super Admin and Apricart Support
  // (`SUPPORT_APRICART_ROLES`). Enforced through `lib/support-access.ts`.
  SUPPORT_VIEW = "support:view",
  SUPPORT_CREATE = "support:create",
  SUPPORT_REPLY = "support:reply",
  SUPPORT_MANAGE = "support:manage",
}

export interface PermissionInfo {
  key: Permission
  label: string
  description: string
  category: PermissionCategory
  isHighRisk?: boolean
}

export const PERMISSION_DEFINITIONS: PermissionInfo[] = [
  // System Administration
  {
    key: Permission.SYSTEM_FULL_ACCESS,
    label: "Full System Access",
    description: "Complete control over all system functions",
    category: PermissionCategory.SYSTEM,
    isHighRisk: true,
  },
  {
    key: Permission.SYSTEM_VIEW_AUDIT_LOGS,
    label: "View Audit Logs",
    description: "Access to system audit logs and activity tracking",
    category: PermissionCategory.SYSTEM,
  },
  {
    key: Permission.SYSTEM_MANAGE_ROLES,
    label: "Manage Roles",
    description: "Create, edit, and delete user roles",
    category: PermissionCategory.SYSTEM,
    isHighRisk: true,
  },
  {
    key: Permission.SYSTEM_MANAGE_PERMISSIONS,
    label: "Manage Permissions",
    description: "Assign and revoke permissions for roles",
    category: PermissionCategory.SYSTEM,
    isHighRisk: true,
  },
  {
    key: Permission.SYSTEM_VIEW_SYSTEM_HEALTH,
    label: "View System Health",
    description: "Monitor system health and performance metrics",
    category: PermissionCategory.SYSTEM,
  },

  // Organization Management
  {
    key: Permission.ORG_CREATE,
    label: "Create Organizations",
    description: "Create new organizations in the system",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_VIEW,
    label: "View Organizations",
    description: "View organization details and information",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_EDIT,
    label: "Edit Organizations",
    description: "Modify organization settings and details",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_DELETE,
    label: "Delete Organizations",
    description: "Remove organizations from the system",
    category: PermissionCategory.ORGANIZATION,
    isHighRisk: true,
  },
  {
    key: Permission.ORG_MANAGE_SETTINGS,
    label: "Manage Organization Settings",
    description: "Configure organization-specific settings",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_MANAGE_BRANCHES,
    label: "Manage Branches",
    description: "Create, edit, and manage organization branches",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_VIEW_METRICS,
    label: "View Organization Metrics",
    description: "Access organization performance metrics",
    category: PermissionCategory.ORGANIZATION,
  },
  {
    key: Permission.ORG_VIEW_AUDIT_LOGS,
    label: "View Organization Activity Log",
    description:
      "Read the activity log of the caller's own organization. Actions by people outside it are anonymised",
    category: PermissionCategory.ORGANIZATION,
  },

  // User Management
  {
    key: Permission.USER_CREATE,
    label: "Create Users",
    description: "Add new users to the system",
    category: PermissionCategory.USER,
  },
  {
    key: Permission.USER_VIEW,
    label: "View Users",
    description: "View user profiles and information",
    category: PermissionCategory.USER,
  },
  {
    key: Permission.USER_EDIT,
    label: "Edit Users",
    description: "Modify user details and settings",
    category: PermissionCategory.USER,
  },
  {
    key: Permission.USER_DELETE,
    label: "Delete Users",
    description: "Remove users from the system",
    category: PermissionCategory.USER,
    isHighRisk: true,
  },
  {
    key: Permission.USER_MANAGE_ROLES,
    label: "Manage User Roles",
    description: "Assign and change user roles",
    category: PermissionCategory.USER,
    isHighRisk: true,
  },
  {
    key: Permission.USER_RESET_PASSWORD,
    label: "Reset User Passwords",
    description: "Reset passwords for user accounts",
    category: PermissionCategory.USER,
  },
  {
    key: Permission.USER_MANAGE_MFA,
    label: "Manage MFA Settings",
    description: "Configure multi-factor authentication for users",
    category: PermissionCategory.USER,
  },
  {
    key: Permission.USER_VIEW_SESSIONS,
    label: "View User Sessions",
    description: "Monitor active user sessions",
    category: PermissionCategory.USER,
  },

  // Inventory Management
  {
    key: Permission.INVENTORY_CREATE,
    label: "Create Inventory Items",
    description: "Add new items to inventory",
    category: PermissionCategory.INVENTORY,
  },
  {
    key: Permission.INVENTORY_VIEW,
    label: "View Inventory",
    description: "Access inventory information",
    category: PermissionCategory.INVENTORY,
  },
  {
    key: Permission.INVENTORY_EDIT,
    label: "Edit Inventory",
    description: "Modify inventory item details",
    category: PermissionCategory.INVENTORY,
  },
  {
    key: Permission.INVENTORY_DELETE,
    label: "Delete Inventory Items",
    description: "Remove items from inventory",
    category: PermissionCategory.INVENTORY,
    isHighRisk: true,
  },
  {
    key: Permission.INVENTORY_ADJUST,
    label: "Adjust Inventory Levels",
    description: "Modify inventory quantities",
    category: PermissionCategory.INVENTORY,
  },
  {
    key: Permission.INVENTORY_TRANSFER,
    label: "Transfer Inventory",
    description: "Move inventory between branches",
    category: PermissionCategory.INVENTORY,
  },
  {
    key: Permission.INVENTORY_MANAGE_SUPPLIERS,
    label: "Manage Suppliers",
    description: "Create and manage supplier relationships",
    category: PermissionCategory.INVENTORY,
  },

  // Order Management
  {
    key: Permission.ORDER_CREATE,
    label: "Create Orders",
    description: "Create new orders in the system",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_VIEW,
    label: "View Orders",
    description: "Access order information",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_EDIT,
    label: "Edit Orders",
    description: "Modify order details",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_DELETE,
    label: "Delete Orders",
    description: "Remove orders from the system",
    category: PermissionCategory.ORDER,
    isHighRisk: true,
  },
  {
    key: Permission.ORDER_APPROVE,
    label: "Approve Orders",
    description: "Approve pending orders",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_REJECT,
    label: "Reject Orders",
    description: "Reject pending orders",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_CANCEL,
    label: "Cancel Orders",
    description: "Cancel existing orders",
    category: PermissionCategory.ORDER,
  },
  {
    key: Permission.ORDER_VIEW_ALL,
    label: "View All Orders",
    description: "Access all orders across organizations",
    category: PermissionCategory.ORDER,
  },

  // Financial Operations
  {
    key: Permission.FINANCE_VIEW_BUDGETS,
    label: "View Budgets",
    description: "Access budget information",
    category: PermissionCategory.FINANCIAL,
  },
  {
    key: Permission.FINANCE_MANAGE_BUDGETS,
    label: "Manage Budgets",
    description: "Create and modify budgets",
    category: PermissionCategory.FINANCIAL,
  },
  {
    key: Permission.FINANCE_VIEW_REPORTS,
    label: "View Financial Reports",
    description: "Access financial reports and analytics",
    category: PermissionCategory.FINANCIAL,
  },
  {
    key: Permission.FINANCE_APPROVE_EXPENSES,
    label: "Approve Expenses",
    description: "Approve expense requests",
    category: PermissionCategory.FINANCIAL,
  },

  // Reports & Analytics
  {
    key: Permission.REPORTS_VIEW_ALL,
    label: "View All Reports",
    description: "Access all system reports",
    category: PermissionCategory.REPORTS,
  },
  {
    key: Permission.REPORTS_VIEW_ORGANIZATION,
    label: "View Organization Reports",
    description: "Access organization-level reports",
    category: PermissionCategory.REPORTS,
  },
  {
    key: Permission.REPORTS_VIEW_BRANCH,
    label: "View Branch Reports",
    description: "Access branch-level reports",
    category: PermissionCategory.REPORTS,
  },
  {
    key: Permission.REPORTS_EXPORT,
    label: "Export Reports",
    description: "Export reports to various formats",
    category: PermissionCategory.REPORTS,
  },
  {
    key: Permission.REPORTS_SCHEDULE,
    label: "Schedule Reports",
    description: "Set up automated report generation",
    category: PermissionCategory.REPORTS,
  },

  // Settings & Configuration
  {
    key: Permission.SETTINGS_VIEW,
    label: "View Settings",
    description: "Access system settings",
    category: PermissionCategory.SETTINGS,
  },
  {
    key: Permission.SETTINGS_EDIT,
    label: "Edit Settings",
    description: "Modify system configurations",
    category: PermissionCategory.SETTINGS,
  },
  {
    key: Permission.SETTINGS_MANAGE_CATEGORIES,
    label: "Manage Categories",
    description: "Create and manage product categories",
    category: PermissionCategory.SETTINGS,
  },
  {
    key: Permission.SETTINGS_MANAGE_PRODUCTS,
    label: "Manage Products",
    description: "Create and configure products",
    category: PermissionCategory.SETTINGS,
  },

  // Group Management
  {
    key: Permission.GROUP_CREATE,
    label: "Create Groups",
    description: "Create new branch groups",
    category: PermissionCategory.GROUP,
  },
  {
    key: Permission.GROUP_VIEW,
    label: "View Groups",
    description: "View branch groups",
    category: PermissionCategory.GROUP,
  },
  {
    key: Permission.GROUP_EDIT,
    label: "Edit Groups",
    description: "Modify group details",
    category: PermissionCategory.GROUP,
  },
  {
    key: Permission.GROUP_DELETE,
    label: "Delete Groups",
    description: "Remove branch groups",
    category: PermissionCategory.GROUP,
    isHighRisk: true,
  },
  {
    key: Permission.GROUP_ASSIGN_BRANCH,
    label: "Assign Branches",
    description: "Assign branches to groups",
    category: PermissionCategory.GROUP,
  },
  {
    key: Permission.PRICING_MANAGE,
    label: "Change Prices",
    description:
      "Set or clear a price at any tier: global base, organization, or group. Super Admin only.",
    category: PermissionCategory.FINANCIAL,
    isHighRisk: true,
  },

  // Support & Communication
  {
    key: Permission.SUPPORT_VIEW,
    label: "View Support Requests",
    description: "Read support conversations within the caller's own scope",
    category: PermissionCategory.SUPPORT,
  },
  {
    key: Permission.SUPPORT_CREATE,
    label: "Raise Support Requests",
    description: "Open a query or complaint with the Apricart team",
    category: PermissionCategory.SUPPORT,
  },
  {
    key: Permission.SUPPORT_REPLY,
    label: "Reply to Support Requests",
    description: "Post a message to a support conversation",
    category: PermissionCategory.SUPPORT,
  },
  {
    key: Permission.SUPPORT_MANAGE,
    label: "Manage the Support Queue",
    description:
      "Assign, prioritise and close support requests across every organization. Apricart only.",
    category: PermissionCategory.SUPPORT,
    isHighRisk: true,
  },
]

export function getPermissionsByCategory() {
  const grouped = new Map<PermissionCategory, PermissionInfo[]>()

  for (const perm of PERMISSION_DEFINITIONS) {
    const existing = grouped.get(perm.category) || []
    existing.push(perm)
    grouped.set(perm.category, existing)
  }

  return grouped
}

export function getPermissionInfo(key: Permission): PermissionInfo | undefined {
  return PERMISSION_DEFINITIONS.find((p) => p.key === key)
}

// Predefined role templates
export const ROLE_TEMPLATES = {
  SUPER_ADMIN: {
    name: "Super Admin",
    description: "Full system access with all permissions",
    permissions: Object.values(Permission),
  },
  HEAD_OFFICE: {
    name: "Head Office",
    description: "Organization-level management and oversight",
    permissions: [
      Permission.ORG_VIEW,
      Permission.ORG_EDIT,
      Permission.ORG_MANAGE_SETTINGS,
      Permission.ORG_MANAGE_BRANCHES,
      Permission.ORG_VIEW_METRICS,
      // Its own organization's trail only — never SYSTEM_VIEW_AUDIT_LOGS. See
      // lib/activity-log-access.ts.
      Permission.ORG_VIEW_AUDIT_LOGS,
      Permission.USER_VIEW,
      Permission.USER_CREATE,
      Permission.USER_EDIT,
      Permission.USER_MANAGE_ROLES,
      Permission.INVENTORY_VIEW,
      Permission.ORDER_VIEW,
      Permission.ORDER_APPROVE,
      Permission.ORDER_REJECT,
      Permission.ORDER_VIEW_ALL,
      Permission.FINANCE_VIEW_BUDGETS,
      Permission.FINANCE_MANAGE_BUDGETS,
      Permission.FINANCE_VIEW_REPORTS,
      Permission.FINANCE_APPROVE_EXPENSES,
      Permission.REPORTS_VIEW_ALL,
      Permission.REPORTS_VIEW_ORGANIZATION,
      Permission.REPORTS_EXPORT,
      Permission.SETTINGS_VIEW,
      Permission.SETTINGS_EDIT,
      Permission.GROUP_VIEW,
      // Every client role holds a direct channel to Apricart. SUPPORT_MANAGE
      // is deliberately absent: triaging the queue is Apricart's own.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_CREATE,
      Permission.SUPPORT_REPLY,
      // Deliberately no PRICING_MANAGE: Head Office administers groups and
      // branches but may never change what they are charged. See
      // lib/pricing-access.ts.
    ],
  },
  BRANCH_ADMIN: {
    name: ROLE_DISPLAY_NAMES.BRANCH_ADMIN,
    description: "Branch-level operations and management",
    permissions: [
      Permission.INVENTORY_CREATE,
      Permission.INVENTORY_VIEW,
      Permission.INVENTORY_EDIT,
      Permission.INVENTORY_ADJUST,
      Permission.INVENTORY_MANAGE_SUPPLIERS,
      Permission.ORDER_CREATE,
      Permission.ORDER_VIEW,
      Permission.ORDER_EDIT,
      Permission.ORDER_APPROVE,
      Permission.ORDER_REJECT,
      Permission.FINANCE_VIEW_BUDGETS,
      Permission.REPORTS_VIEW_BRANCH,
      Permission.REPORTS_EXPORT,
      Permission.SETTINGS_VIEW,
      // Every client role holds a direct channel to Apricart. SUPPORT_MANAGE
      // is deliberately absent: triaging the queue is Apricart's own.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_CREATE,
      Permission.SUPPORT_REPLY,
    ],
  },
  GROUP_USER: {
    name: ROLE_DISPLAY_NAMES.GROUP_USER,
    description: "Approves and manages orders on behalf of multiple branches",
    permissions: [
      Permission.INVENTORY_VIEW,
      Permission.ORDER_CREATE,
      Permission.ORDER_VIEW,
      Permission.ORDER_APPROVE,
      Permission.ORDER_REJECT,
      Permission.FINANCE_VIEW_BUDGETS,
      Permission.REPORTS_VIEW_BRANCH,
      Permission.GROUP_VIEW,
      // Every client role holds a direct channel to Apricart. SUPPORT_MANAGE
      // is deliberately absent: triaging the queue is Apricart's own.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_CREATE,
      Permission.SUPPORT_REPLY,
    ],
  },
  GROUP_ORDER_PORTAL: {
    name: ROLE_DISPLAY_NAMES.GROUP_ORDER_PORTAL,
    description: "Places and manages orders on behalf of multiple branches",
    permissions: [
      Permission.INVENTORY_VIEW,
      Permission.ORDER_CREATE,
      Permission.ORDER_VIEW,
      Permission.FINANCE_VIEW_BUDGETS,
      Permission.GROUP_VIEW,
      // Every client role holds a direct channel to Apricart. SUPPORT_MANAGE
      // is deliberately absent: triaging the queue is Apricart's own.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_CREATE,
      Permission.SUPPORT_REPLY,
    ],
  },
  VIEWER: {
    name: "Viewer",
    description: "Read-only access to its organization: what Head Office sees, and nothing it may change",
    permissions: [
      // Every key here is a read. The role holds no *_CREATE, *_EDIT, *_DELETE,
      // *_APPROVE or *_MANAGE key of any kind, and that is the whole point of
      // it — see `plans/OF-VIEWER-readonly-dashboard-role.md` and
      // `plans/OF-VIEWER-head-office-read-only-menu.md`. They are Head Office's
      // read keys; a branch-pinned Viewer still reaches its dashboard alone,
      // which `lib/viewer-access.ts` decides, not these keys.
      //
      // Authorization in this codebase is still role-name matching rather than
      // permission evaluation (see
      // `plans/OF-CUSTOM-ROLES-rbac-permission-engine.md`), so what actually
      // keeps this role read-only is its absence from every mutating route's
      // allowlist. These keys describe the role; they do not enforce it.
      Permission.ORG_VIEW,
      Permission.ORG_VIEW_METRICS,
      Permission.ORG_VIEW_AUDIT_LOGS,
      Permission.USER_VIEW,
      Permission.ORDER_VIEW,
      Permission.ORDER_VIEW_ALL,
      Permission.INVENTORY_VIEW,
      Permission.GROUP_VIEW,
      Permission.FINANCE_VIEW_BUDGETS,
      Permission.FINANCE_VIEW_REPORTS,
      Permission.REPORTS_VIEW_ORGANIZATION,
      Permission.REPORTS_VIEW_BRANCH,
      Permission.SETTINGS_VIEW,
      // Reads its organization's threads; SUPPORT_CREATE and SUPPORT_REPLY are
      // deliberately absent — it raises and answers nothing.
      Permission.SUPPORT_VIEW,
    ],
  },
  ORDER_PORTAL: {
    name: ROLE_DISPLAY_NAMES.ORDER_PORTAL,
    description: "Restricted access for placing orders only",
    permissions: [
      Permission.INVENTORY_VIEW,
      Permission.ORDER_CREATE,
      Permission.ORDER_VIEW,
      Permission.FINANCE_VIEW_BUDGETS,
      // Every client role holds a direct channel to Apricart. SUPPORT_MANAGE
      // is deliberately absent: triaging the queue is Apricart's own.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_CREATE,
      Permission.SUPPORT_REPLY,
    ],
  },
  ORDER_DESK: {
    name: "Order Desk (Apricart)",
    description: "Apricart staff who key in and fulfil orders for the managed organizations assigned to them",
    permissions: [
      // Descriptive only, like every template here: what confines this role is
      // `lib/order-desk-access.ts` (its reach and its API allowlist) and each
      // handler's own check. Deliberately no PRICING_MANAGE, ORDER_APPROVE,
      // USER_* or ORG_* key — it enters orders and settles its own, nothing more.
      Permission.INVENTORY_VIEW,
      Permission.ORDER_CREATE,
      Permission.ORDER_VIEW,
    ],
  },
  APRICART_EXECUTIVE: {
    name: "Apricart Executive",
    description: "Apricart management: read-only delivery monitoring across every organization",
    permissions: [
      // Descriptive only, like every template here. What confines this role is
      // `lib/apricart-executive-access.ts` — one page area and a two-route read
      // allowlist enforced in `proxy.ts` — and each handler's own role check.
      // Every key is a read; no *_CREATE, *_EDIT, *_APPROVE or *_MANAGE.
      Permission.ORDER_VIEW,
    ],
  },
  WAREHOUSE: {
    name: "Warehouse (Apricart)",
    description: "Apricart warehouse: picks, dispatches and delivers approved orders for the branches assigned to it",
    permissions: [
      // Descriptive only, like every template here. What confines this role is
      // `lib/warehouse-access.ts` — one page area and an API allowlist enforced
      // in `proxy.ts` — and each handler's own role and branch-reach check.
      // Deliberately no ORDER_APPROVE, ORDER_CREATE, PRICING_MANAGE, USER_* or
      // ORG_* key: it moves a delivery forward and reads, nothing more.
      Permission.INVENTORY_VIEW,
      Permission.ORDER_VIEW,
    ],
  },
  APRICART_SUPPORT: {
    name: "Apricart Support",
    description: "Apricart support agents: answer and triage every organization's support requests, nothing else",
    permissions: [
      // Descriptive only, like every template here. What confines this role is
      // `lib/apricart-support-access.ts` — the /support area and an API
      // allowlist enforced in `proxy.ts` — and `lib/support-access.ts` on each
      // handler. It is the Apricart side of the queue, so it triages
      // (SUPPORT_MANAGE) as Super Admin does; SUPPORT_CREATE is absent because
      // Apricart raises no thread.
      Permission.SUPPORT_VIEW,
      Permission.SUPPORT_REPLY,
      Permission.SUPPORT_MANAGE,
    ],
  },
  FINANCE: {
    name: "Finance",
    description: "Apricart finance: reads orders and reports for its assigned organizations, marks orders paid or unpaid",
    permissions: [
      // Descriptive only, like every template here. What confines this role is
      // `lib/finance-access.ts` — its page areas and an API allowlist enforced
      // in `proxy.ts` — and each handler's own role and organization fence.
      // Every key is a read; the one change it makes (Paid / Unpaid) is
      // admitted by the payment-status route itself. No *_CREATE, *_EDIT,
      // *_APPROVE, *_MANAGE, PRICING_MANAGE or REPORTS_SCHEDULE.
      Permission.ORDER_VIEW,
      Permission.FINANCE_VIEW_REPORTS,
      Permission.REPORTS_EXPORT,
    ],
  },
}


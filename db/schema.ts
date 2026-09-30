import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
  uniqueIndex,
  bigint,
  numeric,
  check,
} from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const organizations = pgTable(
  "organizations",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    code: varchar("code", { length: 64 }),
    // Optional tax identifier. Nullable so every existing organization stays
    // valid without one, and so an operator can clear a wrong value.
    ntnNumber: varchar("ntn_number", { length: 32 }),
    status: varchar("status", { length: 32 }).default("active"),
    orderApproverRole: varchar("order_approver_role", { length: 32 })
      .notNull()
      .default("BRANCH_ADMIN"),
    // Existing tenants retain the approval workflow. A Super Admin may opt a
    // tenant into immediate approval for orders created after the change.
    orderApprovalRequired: boolean("order_approval_required")
      .notNull()
      .default(true),
    // When enabled, members of this tenant may only authenticate from an
    // address in organizationAllowedIps. Defaults to false so every existing
    // organization keeps unrestricted login until a Super Admin opts in.
    privateNetworkLoginEnabled: boolean("private_network_login_enabled")
      .notNull()
      .default(false),
    logoUrl: varchar("logo_url", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("org_name_idx").on(t.name),
    uniqueIndex("org_code_idx").on(t.code),
    index("org_status_idx").on(t.status),
    check(
      "organizations_order_approver_role_ck",
      sql`${t.orderApproverRole} IN ('BRANCH_ADMIN', 'HEAD_OFFICE')`,
    ),
  ],
)

export const branches = pgTable(
  "branches",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    province: varchar("province", { length: 100 }),
    city: varchar("city", { length: 100 }),
    address: text("address"),
    costCenterId: varchar("cost_center_id", { length: 128 }),
    // Avoid circular type init between users <-> branches; store admin user id without FK
    adminUserId: uuid("admin_user_id"),
    code: varchar("code", { length: 64 }),
    // Optional stable identity for branches imported from an external system.
    // Ordinary UI-created branches leave both fields null and retain the
    // existing case-insensitive tenant-name uniqueness behavior.
    externalSource: varchar("external_source", { length: 64 }),
    externalId: varchar("external_id", { length: 128 }),
    status: varchar("status", { length: 32 }).default("active"),
    // Group assignment for reporting and analytics
    groupId: integer("group_id"),
    // Base budget for "Add-on" calculation
    baselineBudgetCents: bigint("baseline_budget_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("branches_org_idx").on(t.organizationId),
    index("branches_name_idx").on(t.name),
    index("branches_cost_center_idx").on(t.costCenterId),
    uniqueIndex("branches_org_external_identity_uq")
      .on(t.organizationId, t.externalSource, t.externalId)
      .where(sql`${t.externalSource} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
    index("branches_status_idx").on(t.status),
    index("branches_group_idx").on(t.groupId),
    check(
      "branches_external_identity_pair_ck",
      sql`(${t.externalSource} IS NULL) = (${t.externalId} IS NULL)
        AND (${t.externalSource} IS NULL OR (btrim(${t.externalSource}) <> '' AND btrim(${t.externalId}) <> ''))`,
    ),
  ],
)

export const roles = pgTable(
  "roles",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 64 }).notNull(), // SUPER_ADMIN | HEAD_OFFICE | BRANCH_ADMIN
    description: text("description"),
    permissions: jsonb("permissions").$type<Record<string, boolean>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("roles_name_idx").on(t.name),
  ],
)

export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    roleId: integer("role_id").references(() => roles.id).notNull(),
    permissionKey: varchar("permission_key", { length: 128 }).notNull(),
    allowed: boolean("allowed").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("role_permissions_role_idx").on(t.roleId),
  ],
)

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    roleId: integer("role_id")
      .references(() => roles.id)
      .notNull(),
    isActive: boolean("is_active").notNull().default(true),
    budgetAllocationEnabled: boolean("budget_allocation_enabled").notNull().default(false),
    fullName: varchar("full_name", { length: 255 }),
    firstName: varchar("first_name", { length: 100 }),
    lastName: varchar("last_name", { length: 100 }),
    phone: varchar("phone", { length: 32 }),
    employeeId: varchar("employee_id", { length: 64 }),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    organizationId: integer("organization_id").references(() => organizations.id),
    // Avoid circular type init; store branch id without FK
    branchId: integer("branch_id"),
    imprestHolder: varchar("imprest_holder", { length: 255 }),
    contactPerson: varchar("contact_person", { length: 255 }),
    location: varchar("location", { length: 255 }),
    address: text("address"),
    // Optional stable identity for accounts mirrored from an external system,
    // matching the same pair on `branches`. Accounts created through the portal
    // leave both null, and only those accounts may sign in with an email
    // address: a mirrored person holds one account per role behind a single
    // shared email, so an email alone cannot say which portal they meant.
    externalSource: varchar("external_source", { length: 64 }),
    externalId: varchar("external_id", { length: 128 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    sessionVersion: integer("session_version").notNull().default(1),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    // When the address on this row was last proven to reach the person (an
    // emailed code entered back), and when the person last set their own
    // password. A `must_change_password` cleared by an administrator is not a
    // rotation; `password_changed_at` is what says one happened.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    // Per-account brute-force lockout. Keyed on the account rather than the
    // client address, so rotating source addresses cannot reset the budget.
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
    lockoutUntil: timestamp("lockout_until", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("users_username_idx").on(t.username),
    index("users_email_idx").on(t.email),
    index("users_role_idx").on(t.roleId),
    index("users_active_idx").on(t.isActive),
    index("users_org_idx").on(t.organizationId),
    index("users_branch_idx").on(t.branchId),
    index("users_employee_id_idx").on(t.employeeId),
    // One account per source person *per role* — a mirrored person is two rows
    // (one to place orders, one to approve them) sharing an external identity.
    uniqueIndex("users_org_external_identity_role_uq")
      .on(t.organizationId, t.externalSource, t.externalId, t.roleId)
      .where(sql`${t.externalSource} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
    index("users_external_identity_idx").on(t.externalSource, t.externalId),
    check(
      "users_external_identity_pair_ck",
      sql`(${t.externalSource} IS NULL) = (${t.externalId} IS NULL)
        AND (${t.externalSource} IS NULL OR (btrim(${t.externalSource}) <> '' AND btrim(${t.externalId}) <> ''))`,
    ),
  ],
)

export const mfaCodes = pgTable(
  "mfa_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    code: varchar("code", { length: 6 }).notNull(),
    type: varchar("type", { length: 20 }).notNull(), // 'LOGIN', 'VERIFY_EMAIL', 'RESET_PASSWORD'
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    isUsed: boolean("is_used").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("mfa_codes_user_idx").on(t.userId),
    index("mfa_codes_code_idx").on(t.code),
    index("mfa_codes_expires_idx").on(t.expiresAt),
    index("mfa_codes_type_idx").on(t.type),
  ],
)

export const categories = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    name: varchar("name", { length: 255 }).notNull(),
    parentId: integer("parent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("categories_name_idx").on(t.name),
    index("categories_org_idx").on(t.organizationId),
  ],
)

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    name: varchar("name", { length: 255 }).notNull(),
    categoryId: integer("category_id")
      .references(() => categories.id)
      .notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("products_category_idx").on(t.categoryId),
    index("products_name_idx").on(t.name),
    index("products_org_idx").on(t.organizationId),
  ],
)

export const skus = pgTable(
  "skus",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    productId: integer("product_id")
      .references(() => products.id)
      .notNull(),
    sku: varchar("sku", { length: 128 }).notNull(),
    unit: varchar("unit", { length: 64 }).notNull(), // e.g. 'box', 'kg'
    priceCents: integer("price_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("skus_product_idx").on(t.productId),
    uniqueIndex("skus_sku_idx").on(t.sku),
    index("skus_org_idx").on(t.organizationId),
  ],
)

export const inventory = pgTable(
  "inventory",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    skuId: integer("sku_id")
      .references(() => skus.id)
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("inventory_branch_sku_uq").on(t.branchId, t.skuId),
    index("inventory_branch_idx").on(t.branchId),
    index("inventory_org_idx").on(t.organizationId),
    index("inventory_org_branch_sku_idx").on(t.organizationId, t.branchId, t.skuId),
  ],
)

export const headOffices = pgTable(
  "head_offices",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    contactEmail: varchar("contact_email", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("head_offices_org_idx").on(t.organizationId),
  ],
)

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    address: text("address"),
    contact: varchar("contact", { length: 255 }),
    email: varchar("email", { length: 255 }),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("suppliers_org_idx").on(t.organizationId),
    index("suppliers_branch_idx").on(t.branchId),
    index("suppliers_name_idx").on(t.name),
  ],
)

export const budgets = pgTable(
  "budgets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    period: varchar("period", { length: 16 }).notNull(), // e.g. '2025-10'
    amountAllocatedCents: bigint("amount_allocated_cents", { mode: "number" }).notNull().default(0),
    amountSpentCents: bigint("amount_spent_cents", { mode: "number" }).notNull().default(0),
    amountHeldCents: bigint("amount_held_cents", { mode: "number" }).notNull().default(0),
    amountCreditedCents: bigint("amount_credited_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("budgets_branch_period_uq").on(t.branchId, t.period),
    index("budgets_org_idx").on(t.organizationId),
    index("budgets_branch_idx").on(t.branchId),
    check("budgets_values_valid_ck", sql`${t.amountAllocatedCents} >= 0 AND ${t.amountSpentCents} >= 0 AND ${t.amountHeldCents} >= 0 AND ${t.amountCreditedCents} >= 0 AND (${t.amountAllocatedCents} + ${t.amountCreditedCents}) >= (${t.amountSpentCents} + ${t.amountHeldCents})`),
  ],
)

/**
 * One row per one-time add-on ever credited to a monthly budget row. The
 * credit itself lives in budgets.amount_credited_cents; this is its history.
 *
 * An add-on carries a validity: valid_until is the instant it stops being
 * available (end of the chosen day, Asia/Karachi). When that passes, the
 * settlement in lib/server/budget-addon-expiry.ts withdraws the unspent part
 * from the budget row and records it here as forfeited_cents with expired_at.
 * A NULL valid_until is an add-on granted before validity existed: it lasts
 * the month, as it always did, and is never settled.
 */
export const budgetAddons = pgTable(
  "budget_addons",
  {
    id: serial("id").primaryKey(),
    budgetId: integer("budget_id")
      .references(() => budgets.id, { onDelete: "cascade" })
      .notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    reason: text("reason"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    forfeitedCents: bigint("forfeited_cents", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    index("budget_addons_budget_idx").on(t.budgetId),
    index("budget_addons_open_expiry_idx").on(t.validUntil).where(sql`${t.expiredAt} IS NULL`),
    // GREATEST(amount_cents, 0) mirrors the floor planAddonSettlement applies
    // before it forfeits anything, so a compensating reversal row (negative
    // amount) can only ever forfeit zero rather than being unsatisfiable.
    // See drizzle/20260926120000_fix_budget_addon_forfeit_bounds.sql.
    check("budget_addons_forfeit_bounds_ck", sql`${t.forfeitedCents} >= 0 AND ${t.forfeitedCents} <= GREATEST(${t.amountCents}, 0)`),
  ],
)

/**
 * A Head Office exception that lets a branch keep ordering while it is over
 * the overdue-payment limit (plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md).
 *
 * This is the only fact the payment-control feature persists. Whether the
 * exception is in force is never stored: it is `revoked_at IS NULL AND
 * start_at <= now < expires_at`, computed on every read and inside the order
 * transaction, so an expiry takes effect at the instant without a job.
 * expires_at is NOT NULL because an exception is never permanent. A branch
 * has at most one live exception at a time; a later grant is a new row, and
 * the old one stays as history.
 */
export const paymentControlExceptions = pgTable(
  "payment_control_exceptions",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id).notNull(),
    reason: text("reason"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => users.id),
    revokeReason: text("revoke_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("payment_control_exceptions_org_idx").on(t.organizationId),
    index("payment_control_exceptions_live_branch_idx").on(t.branchId, t.expiresAt).where(sql`${t.revokedAt} IS NULL`),
    check("payment_control_exceptions_window_ck", sql`${t.expiresAt} > ${t.startAt}`),
  ],
)

export const organizationSettings = pgTable(
  "organization_settings",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    value: jsonb("value"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("org_settings_org_idx").on(t.organizationId),
    uniqueIndex("organization_settings_org_key_uq").on(t.organizationId, t.key),
    check(
      "organization_settings_session_timeout_bounds_ck",
      sql`${t.key} <> 'session_timeout_minutes' OR CASE WHEN jsonb_typeof(${t.value}) = 'number' AND (${t.value} #>> '{}') ~ '^[0-9]+$' THEN (${t.value} #>> '{}')::numeric BETWEEN 1 AND 15 ELSE FALSE END`,
    ),
  ],
)

/**
 * Addresses and CIDR ranges a tenant may authenticate from, used only when
 * organizations.private_network_login_enabled is true. Rows are stored already
 * masked to their network address with an explicit prefix length, so login
 * matching is a pure prefix comparison and one network cannot be recorded
 * under two different spellings.
 */
export const organizationAllowedIps = pgTable(
  "organization_allowed_ips",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    // Wide enough for a full uncompressed IPv6 address.
    ipAddress: varchar("ip_address", { length: 45 }).notNull(),
    prefixLength: integer("prefix_length").notNull(),
    label: varchar("label", { length: 120 }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("organization_allowed_ips_org_idx").on(t.organizationId),
    uniqueIndex("organization_allowed_ips_org_network_uq").on(
      t.organizationId,
      t.ipAddress,
      t.prefixLength,
    ),
    check(
      "organization_allowed_ips_prefix_length_ck",
      sql`${t.prefixLength} >= 0 AND ${t.prefixLength} <= 128`,
    ),
    check(
      "organization_allowed_ips_address_nonempty_ck",
      sql`length(trim(${t.ipAddress})) > 0`,
    ),
  ],
)

export const orgMetrics = pgTable(
  "org_metrics",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    month: varchar("month", { length: 16 }),
    totalOrders: integer("total_orders"),
    totalSpendCents: integer("total_spend_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("org_metrics_org_idx").on(t.organizationId),
  ],
)

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    organizationId: integer("organization_id")
      .primaryKey()
      .references(() => organizations.id)
      .notNull(),
    lastValue: integer("last_value").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    check("invoice_sequences_range_ck", sql`${t.lastValue} >= 0 AND ${t.lastValue} <= 999999`),
  ],
)

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    tid: varchar("tid", { length: 26 }).notNull().unique(), // Transaction ID
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }),
    organizationId: integer("organization_id").references(() => organizations.id),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"), // PENDING/APPROVED/REJECTED/FULFILLED/REFUNDED
    fulfillmentStatus: varchar("fulfillment_status", { length: 32 }).notNull().default("NOT_STARTED"), // NOT_STARTED/IN_PROCESS/OUT_FOR_DELIVERY/DELIVERED
    paymentStatus: varchar("payment_status", { length: 16 }).notNull().default("UNPAID"), // UNPAID/PAID — toggled by SUPER_ADMIN only
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByUserId: uuid("paid_by_user_id").references(() => users.id),
    subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
    notes: text("notes"),
    // Buyer-supplied purchase order reference, recorded against the order.
    // Optional: orders may be raised without one.
    poNumber: varchar("po_number", { length: 64 }),
    // Set only for orders created through the Group Order Portal's multi-branch
    // submission, which records one ordinary order per branch under a shared
    // envelope. NULL for every order created by any other role or flow, so no
    // existing behaviour reads or depends on it.
    groupOrderId: integer("group_order_id").references(() => groupOrders.id),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Approval tracking fields
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedByUserId: uuid("rejected_by_user_id").references(() => users.id),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    // Secure approval token for fulfillment verification
    approvalToken: varchar("approval_token", { length: 16 }), // Plaintext - shown only to approver
    approvalTokenHash: varchar("approval_token_hash", { length: 255 }), // Hash for verification
    approvalTokenCreatedAt: timestamp("approval_token_created_at", { withTimezone: true }),
    fulfilledByUserId: uuid("fulfilled_by_user_id").references(() => users.id),
    // Fulfilment token hand-off tracking.
    //
    // Handing the token to admin operations no longer settles the order on its
    // own: the goods still have to arrive. These columns remember a hand-off
    // that happened before delivery, so the order can be settled the moment its
    // delivery status reaches DELIVERED. Both are nullable, so every order that
    // never had a token handed over keeps exactly the data it has today.
    tokenHandoffAt: timestamp("token_handoff_at", { withTimezone: true }),
    tokenHandoffByUserId: uuid("token_handoff_by_user_id").references(() => users.id),
    // Refund tracking fields
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundedByUserId: uuid("refunded_by_user_id").references(() => users.id),
    statusAtRefund: varchar("status_at_refund", { length: 32 }), // Status before refund (e.g., "APPROVED", "FULFILLED")
    refundAmountCents: bigint("refund_amount_cents", { mode: "number" }), // Total refund amount
    refundReason: text("refund_reason"),
    // Receipt data - complete snapshot for historical accuracy
    receiptData: jsonb("receipt_data").$type<{
      invoiceNumber: string
      /** Buyer's purchase order reference as supplied when the order was placed. */
      poNumber?: string
      date: string
      buyerName: string
      buyerAddress: string
      buyerPhone?: string
      organizationName: string
      organizationContact?: string
      items: Array<{
        categoryName: string
        items: Array<{
          id: number
          description: string
          quantity: number
          rate: number
          tax: number
          total: number
          unit: string
        }>
        subtotal: number
      }>
      subtotal: number
      discount: number
      tax: number
      deliveryCharges: number
      refund: number
      totalAmount: number
    }>(),
  },
  (t) => [
    uniqueIndex("orders_tid_idx").on(t.tid),
    index("orders_branch_idx").on(t.branchId),
    index("orders_status_idx").on(t.status),
    index("orders_fulfillment_status_idx").on(t.fulfillmentStatus),
    index("orders_payment_status_idx").on(t.paymentStatus),
    index("orders_created_idx").on(t.createdAt),
    index("orders_org_idx").on(t.organizationId),
    index("orders_org_branch_status_idx").on(t.organizationId, t.branchId, t.status),
    index("orders_branch_status_created_idx").on(t.branchId, t.status, t.createdAt),
    index("orders_org_created_idx").on(t.organizationId, t.createdAt),
    // Partial: only group-portal orders carry the column, so the index stays the
    // size of that feature rather than the size of the orders table.
    index("orders_group_order_idx")
      .on(t.groupOrderId)
      .where(sql`${t.groupOrderId} IS NOT NULL`),
    uniqueIndex("orders_creator_idempotency_uq").on(t.createdByUserId, t.idempotencyKey),
    check("orders_amounts_nonnegative_ck", sql`${t.subtotalCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.totalCents} >= 0 AND COALESCE(${t.refundAmountCents}, 0) >= 0 AND COALESCE(${t.refundAmountCents}, 0) <= ${t.totalCents}`),
    check("orders_idempotency_pair_ck", sql`(${t.idempotencyKey} IS NULL AND ${t.requestFingerprint} IS NULL) OR (${t.idempotencyKey} IS NOT NULL AND ${t.requestFingerprint} IS NOT NULL)`),
  ],
)

export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    // Snapshot the organization inventory item used for branch quantity budget tracking.
    organizationInventoryId: integer("organization_inventory_id"),
    orderId: integer("order_id")
      .references(() => orders.id)
      .notNull(),
    globalProductId: integer("global_product_id")
      .references(() => globalProducts.id)
      .notNull(),
    // Product snapshot - store at time of order for historical accuracy
    productName: varchar("product_name", { length: 255 }).notNull(),
    productCode: varchar("product_code", { length: 128 }),
    unit: varchar("unit", { length: 64 }).notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(), // Price at time of order
    // Tax snapshot. priceCents is gross (tax-inclusive), and taxCents is the
    // portion of this line's gross amount that is tax at taxRateBp. Recorded at
    // sale time rather than derived on read, so changing a rate later cannot
    // restate invoices that have already been issued.
    taxRateBp: integer("tax_rate_bp"),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    index("order_items_org_idx").on(t.organizationId),
    index("order_items_organization_inventory_idx").on(t.organizationInventoryId),
    index("order_items_product_idx").on(t.globalProductId),
    index("order_items_product_order_idx").on(t.globalProductId, t.orderId),
    check("order_items_values_valid_ck", sql`${t.quantity} > 0 AND ${t.quantity} <= 1000000 AND ${t.priceCents} >= 0`),
    check("order_items_tax_valid_ck", sql`${t.taxCents} >= 0 AND (${t.taxRateBp} IS NULL OR (${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000))`),
  ],
)

export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    orderId: integer("order_id")
      .references(() => orders.id)
      .notNull(),
    // Gross refund used by existing reports/filters (item refund + refunded tax).
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    // Additive breakdown field. Existing and application-created refunds remain 0.
    taxRefundCents: bigint("tax_refund_cents", { mode: "number" }).notNull().default(0),
    reason: varchar("reason", { length: 255 }),
    // New workflow: support pending refund requests
    status: varchar("status", { length: 16 }).notNull().default("PENDING"), // PENDING, APPROVED
    refundNumber: varchar("refund_number", { length: 20 }).unique(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    processedByUserId: uuid("processed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("refunds_order_idx").on(t.orderId),
    index("refunds_org_idx").on(t.organizationId),
    index("refunds_processed_by_idx").on(t.processedByUserId),
    check("refunds_amount_positive_ck", sql`${t.amountCents} > 0`),
    check("refunds_tax_refund_valid_ck", sql`${t.taxRefundCents} >= 0 AND ${t.taxRefundCents} <= ${t.amountCents}`),
  ],
)

export const refundItems = pgTable(
  "refund_items",
  {
    id: serial("id").primaryKey(),
    refundId: integer("refund_id")
      .references(() => refunds.id, { onDelete: "cascade" })
      .notNull(),
    orderItemId: integer("order_item_id")
      .references(() => orderItems.id)
      .notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("refund_items_refund_idx").on(t.refundId),
    index("refund_items_order_item_idx").on(t.orderItemId),
    check("refund_items_values_valid_ck", sql`${t.quantity} > 0 AND ${t.quantity} <= 1000000 AND ${t.amountCents} >= 0`),
  ],
)


export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    organizationId: integer("organization_id").references(() => organizations.id),
    branchId: integer("branch_id").references(() => branches.id),
    type: varchar("type", { length: 64 }).notNull(),
    targetRole: varchar("target_role", { length: 64 }),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }),
    // The support thread this notification points at, when it is about one.
    // Null for every notification type that predates support threads, so the
    // column changes nothing about the rows already in this table.
    supportThreadId: integer("support_thread_id").references(() => supportThreads.id, {
      onDelete: "cascade",
    }),
    eventKey: varchar("event_key", { length: 255 }),
    message: text("message").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId),
    index("notifications_type_idx").on(t.type),
    index("notifications_org_idx").on(t.organizationId),
    index("notifications_branch_idx").on(t.branchId),
    index("notifications_order_idx").on(t.orderId),
    index("notifications_support_thread_idx").on(t.supportThreadId),
    uniqueIndex("notifications_event_key_uq").on(t.eventKey),
  ],
)

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: serial("id").primaryKey(),
    eventKey: varchar("event_key", { length: 255 }).notNull(),
    recipientUserId: uuid("recipient_user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    recipientEmail: varchar("recipient_email", { length: 255 }).notNull(),
    recipientRole: varchar("recipient_role", { length: 64 }).notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    // Nullable since support threads joined the outbox: a Head Office raiser
    // has no branch, and a support notification has no order. Every order
    // lifecycle row still carries both, and `deliverClaimedOrderEmail` refuses
    // an order row that does not.
    branchId: integer("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }),
    supportThreadId: integer("support_thread_id").references(() => supportThreads.id, {
      onDelete: "cascade",
    }),
    template: varchar("template", { length: 64 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow(),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("email_outbox_event_key_uq").on(t.eventKey),
    index("email_outbox_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    index("email_outbox_recipient_idx").on(t.recipientUserId),
    index("email_outbox_org_idx").on(t.organizationId),
    index("email_outbox_branch_idx").on(t.branchId),
    index("email_outbox_order_idx").on(t.orderId),
    index("email_outbox_support_thread_idx").on(t.supportThreadId),
    check("email_outbox_attempts_nonnegative_ck", sql`${t.attempts} >= 0`),
    check("email_outbox_status_valid_ck", sql`${t.status} IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED')`),
  ],
)

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id),
    organizationId: integer("organization_id").references(() => organizations.id),
    branchId: integer("branch_id").references(() => branches.id),
    action: varchar("action", { length: 128 }).notNull(),
    entity: varchar("entity", { length: 128 }).notNull(),
    entityId: varchar("entity_id", { length: 128 }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("audit_user_idx").on(t.userId),
    index("audit_entity_idx").on(t.entity),
    index("audit_org_idx").on(t.organizationId),
    index("audit_branch_idx").on(t.branchId),
    index("audit_created_action_idx").on(t.createdAt, t.action),
    // One record's trail: the invoice reads an order's token hand-off from here.
    index("audit_entity_lookup_idx").on(t.entity, t.entityId, t.action, t.createdAt),
  ],
)

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id)
      .notNull(),
    organizationId: integer("organization_id").references(() => organizations.id),
    refreshTokenHash: varchar("refresh_token_hash", { length: 255 }).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expires_idx").on(t.expiresAt),
    index("sessions_org_idx").on(t.organizationId),
  ],
)

// Server-side registry for JWT-backed browser sessions. Unlike the legacy
// refresh-token table above, the subject is a string so both UUID users and
// employee principals (`emp_<id>`) receive independent, revocable sessions.
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    subjectId: varchar("subject_id", { length: 128 }).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Proof that this session entered an emailed code, consumed by the
    // password change it authorises (`lib/server/password-change.ts`). Bound
    // to the session so a code entered on one device cannot authorise a
    // change from another.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("auth_sessions_subject_idx").on(t.subjectId),
    index("auth_sessions_org_idx").on(t.organizationId),
    index("auth_sessions_absolute_expiry_idx").on(t.absoluteExpiresAt),
    check("auth_sessions_subject_nonempty_ck", sql`length(trim(${t.subjectId})) > 0`),
    check(
      "auth_sessions_time_order_ck",
      sql`${t.startedAt} <= ${t.lastActivityAt} AND ${t.lastActivityAt} <= ${t.absoluteExpiresAt}`,
    ),
  ],
)

// ========================================
// ENHANCED INVENTORY MANAGEMENT SYSTEM
// ========================================

// Global Products - Master inventory managed by Super Admin
export const globalProducts = pgTable(
  "global_products",
  {
    id: serial("id").primaryKey(),
    productCode: varchar("product_code", { length: 128 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    categoryId: integer("category_id").references(() => categories.id),
    imageUrl: text("image_url"),
    basePrice: integer("base_price_cents").notNull().default(0),
    // Sales-tax rate in basis points (1800 = 18%). Prices above are entered
    // inclusive of this rate. NULL means the product follows the organization's
    // tax_rate setting, so changing that default moves every product that has
    // not been given an explicit rate of its own.
    taxRateBp: integer("tax_rate_bp"),
    // Global discount configuration
    discountType: varchar("discount_type", { length: 16 }), // percent | flat
    discountValue: integer("discount_value_cents"), // cents for flat, basis points for percent? we will store percent as integer 0-10000 basis points
    discountStartAt: timestamp("discount_start_at", { withTimezone: true }),
    discountEndAt: timestamp("discount_end_at", { withTimezone: true }),
    discountActive: boolean("discount_active").default(false),
    unit: varchar("unit", { length: 64 }).notNull().default("unit"), // kg, box, piece, etc.
    status: varchar("status", { length: 32 }).notNull().default("active"), // active, inactive
    // Single source of truth for stock across the system
    stockQuantity: numeric("stock_quantity", { precision: 12, scale: 3, mode: "number" }).notNull().default(0),
    allowDecimalQuantity: boolean("allow_decimal_quantity").notNull().default(false),
    quantityStep: numeric("quantity_step", { precision: 12, scale: 3, mode: "number" }).notNull().default(1),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("global_products_code_idx").on(t.productCode),
    index("global_products_name_idx").on(t.name),
    index("global_products_category_idx").on(t.categoryId),
    index("global_products_status_idx").on(t.status),
    index("global_products_cat_status_idx").on(t.categoryId, t.status),
    index("global_products_status_created_idx").on(t.status, t.createdAt),
    check("global_products_values_valid_ck", sql`${t.basePrice} >= 0 AND ${t.stockQuantity} >= 0 AND ${t.quantityStep} > 0 AND COALESCE(${t.discountValue}, 0) >= 0`),
    check("global_products_tax_rate_valid_ck", sql`${t.taxRateBp} IS NULL OR (${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000)`),
  ],
)

// Organization Products - Head Office shortlisting and customization
export const organizationProducts = pgTable(
  "organization_products",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true), // Head Office can disable products
    customName: varchar("custom_name", { length: 255 }), // Override product name
    customDescription: text("custom_description"), // Override description
    customPrice: integer("custom_price_cents"), // Override pricing
    customImageUrl: text("custom_image_url"),
    tags: jsonb("tags").$type<string[]>().default([]),
    priority: integer("priority").default(0), // For sorting/featuring
    overrideLevel: varchar("override_level", { length: 32 }).default("super_admin"), // super_admin/head_office/branch
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("org_products_org_product_uq").on(t.organizationId, t.globalProductId),
    index("org_products_org_idx").on(t.organizationId),
    index("org_products_global_idx").on(t.globalProductId),
    index("org_products_enabled_idx").on(t.isEnabled),
    check("organization_products_price_valid_ck", sql`${t.customPrice} IS NULL OR ${t.customPrice} >= 0`),
  ],
)

// Branch Products - Branch-level stock, availability, and settings
export const branchProducts = pgTable(
  "branch_products",
  {
    id: serial("id").primaryKey(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    organizationProductId: integer("organization_product_id").references(() => organizationProducts.id, { onDelete: "cascade" }),
    isVisible: boolean("is_visible").notNull().default(true), // Branch can toggle visibility
    isAvailable: boolean("is_available").notNull().default(true), // Branch can mark unavailable
    customNotes: text("custom_notes"), // Branch-specific notes
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("branch_products_branch_product_uq").on(t.branchId, t.globalProductId),
    index("branch_products_branch_idx").on(t.branchId),
    index("branch_products_org_idx").on(t.organizationId),
    index("branch_products_global_idx").on(t.globalProductId),
    index("branch_products_org_product_idx").on(t.organizationProductId),
    index("branch_products_visible_idx").on(t.isVisible),
    index("branch_products_available_idx").on(t.isAvailable),
  ],
)

// Product Assignment History - Track cascading changes
export const productAssignments = pgTable(
  "product_assignments",
  {
    id: serial("id").primaryKey(),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    assignedToType: varchar("assigned_to_type", { length: 32 }).notNull(), // organization or branch
    assignedToId: integer("assigned_to_id").notNull(), // organizationId or branchId
    action: varchar("action", { length: 32 }).notNull(), // assigned, unassigned, forced
    performedByUserId: uuid("performed_by_user_id").references(() => users.id).notNull(),
    performedByRole: varchar("performed_by_role", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("product_assignments_product_idx").on(t.globalProductId),
    index("product_assignments_assigned_to_idx").on(t.assignedToType, t.assignedToId),
    index("product_assignments_user_idx").on(t.performedByUserId),
  ],
)

// Restock Requests - Branch can request restocking
export const restockRequests = pgTable(
  "restock_requests",
  {
    id: serial("id").primaryKey(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    requestedQuantity: numeric("requested_quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    currentStock: numeric("current_stock", { precision: 12, scale: 3, mode: "number" }).notNull(),
    reason: text("reason"),
    status: varchar("status", { length: 32 }).notNull().default("pending"), // pending, approved, rejected, fulfilled
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id).notNull(),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("restock_requests_branch_idx").on(t.branchId),
    index("restock_requests_org_idx").on(t.organizationId),
    index("restock_requests_product_idx").on(t.globalProductId),
    index("restock_requests_status_idx").on(t.status),
    index("restock_requests_requested_by_idx").on(t.requestedByUserId),
  ],
)

// Inventory Sync Log - Track synchronization between levels
export const inventorySyncLogs = pgTable(
  "inventory_sync_logs",
  {
    id: serial("id").primaryKey(),
    syncType: varchar("sync_type", { length: 64 }).notNull(), // full_sync, partial_sync, cascade_update
    triggerLevel: varchar("trigger_level", { length: 32 }).notNull(), // super_admin, head_office, branch
    targetType: varchar("target_type", { length: 32 }).notNull(), // organization, branch, all
    targetId: integer("target_id"), // organizationId or branchId (null for all)
    affectedProducts: jsonb("affected_products").$type<number[]>().default([]),
    changesCount: integer("changes_count").notNull().default(0),
    status: varchar("status", { length: 32 }).notNull().default("pending"), // pending, in_progress, completed, failed
    errorMessage: text("error_message"),
    performedByUserId: uuid("performed_by_user_id").references(() => users.id).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
  },
  (t) => [
    index("inventory_sync_logs_type_idx").on(t.syncType),
    index("inventory_sync_logs_target_idx").on(t.targetType, t.targetId),
    index("inventory_sync_logs_status_idx").on(t.status),
    index("inventory_sync_logs_user_idx").on(t.performedByUserId),
    index("inventory_sync_logs_started_at_idx").on(t.startedAt),
  ],
)

// Product Import Batches - Track CSV uploads and bulk imports
export const productImportBatches = pgTable(
  "product_import_batches",
  {
    id: serial("id").primaryKey(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id).notNull(),
    totalRows: integer("total_rows").notNull().default(0),
    successfulRows: integer("successful_rows").notNull().default(0),
    failedRows: integer("failed_rows").notNull().default(0),
    status: varchar("status", { length: 32 }).notNull().default("processing"), // processing, completed, failed, partial
    validationErrors: jsonb("validation_errors").$type<Array<{ row: number, errors: string[] }>>().default([]),
    importedProductIds: jsonb("imported_product_ids").$type<number[]>().default([]),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("product_import_batches_user_idx").on(t.uploadedByUserId),
    index("product_import_batches_status_idx").on(t.status),
    index("product_import_batches_created_at_idx").on(t.createdAt),
  ],
)

// ========================================
// PRODUCT MANAGEMENT SYSTEM
// ========================================

// Modifiers - Product variants like sizes, units, packaging
export const modifiers = pgTable(
  "modifiers",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    type: varchar("type", { length: 64 }).notNull().default("unit"), // unit, size, packaging, etc.
    status: varchar("status", { length: 32 }).notNull().default("active"), // active, inactive
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("modifiers_name_idx").on(t.name),
    index("modifiers_type_idx").on(t.type),
    index("modifiers_status_idx").on(t.status),
    index("modifiers_user_idx").on(t.createdByUserId),
  ],
)

// Product Modifiers - Junction table linking products to their modifiers
export const productModifiers = pgTable(
  "product_modifiers",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").references(() => globalProducts.id).notNull(),
    modifierId: integer("modifier_id").references(() => modifiers.id).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("product_modifiers_product_idx").on(t.productId),
    index("product_modifiers_modifier_idx").on(t.modifierId),
    uniqueIndex("product_modifiers_product_modifier_idx").on(t.productId, t.modifierId),
  ],
)

// Organization Inventory - Products assigned to organizations
export const organizationInventory = pgTable(
  "organization_inventory",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    customName: varchar("custom_name", { length: 255 }),
    customPrice: integer("custom_price_cents"),
    customDescription: text("custom_description"),
    customImageUrl: text("custom_image_url"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("org_inventory_org_product_uq").on(t.organizationId, t.globalProductId),
    index("org_inventory_org_idx").on(t.organizationId),
    index("org_inventory_global_product_idx").on(t.globalProductId),
    index("org_inventory_assigned_by_idx").on(t.assignedByUserId),
    index("org_inventory_active_idx").on(t.isActive),
    index("org_inventory_deleted_at_idx").on(t.deletedAt),
    check("organization_inventory_price_valid_ck", sql`${t.customPrice} IS NULL OR ${t.customPrice} >= 0`),
  ],
)

// Branch Inventory - Products assigned to branches
export const branchInventory = pgTable(
  "branch_inventory",
  {
    id: serial("id").primaryKey(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    organizationInventoryId: integer("organization_inventory_id").references(() => organizationInventory.id, { onDelete: "cascade" }).notNull(),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id).notNull(),
    isVisible: boolean("is_visible").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("branch_inventory_branch_org_inventory_uq").on(t.branchId, t.organizationInventoryId),
    index("branch_inventory_branch_idx").on(t.branchId),
    index("branch_inventory_org_idx").on(t.organizationId),
    index("branch_inventory_org_inventory_idx").on(t.organizationInventoryId),
    index("branch_inventory_assigned_by_idx").on(t.assignedByUserId),
    index("branch_inventory_visible_idx").on(t.isVisible),
    index("branch_inventory_active_idx").on(t.isActive),
    index("branch_inventory_deleted_at_idx").on(t.deletedAt),
    index("branch_inventory_status_idx").on(t.branchId, t.isVisible, t.isActive),
  ],
)

/**
 * Group Inventory Prices - the group tier of the price ladder.
 *
 * The ladder is resolved by `lib/server/effective-price.ts` and is, in order:
 *
 *   group override (here) -> organization override (`organization_inventory`)
 *   -> global base price (`global_products.base_price_cents`)
 *
 * Deliberate properties:
 *
 *  * **Absence is inheritance.** A group with no row for a product pays the
 *    organization price, so this table never has to be backfilled and the
 *    organization price it falls back to is left completely untouched.
 *  * **A branch resolves to exactly one group** (`branches.group_id`), so the
 *    price applying to a branch is never ambiguous. A branch outside every
 *    group simply has no group tier and keeps the organization price.
 *  * **Live, not copied.** Moving a branch between groups changes its prices
 *    immediately; nothing is denormalized onto the branch. Orders are unaffected
 *    because `order_items.price_cents` is a snapshot taken at order time.
 */
export const groupInventoryPrices = pgTable(
  "group_inventory_prices",
  {
    id: serial("id").primaryKey(),
    groupId: integer("group_id")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    // Denormalized tenant guard, matching `user_group_assignments`: every row is
    // pinned to the tenant it was written under so a cross-tenant override is
    // impossible to write and impossible to read back by accident.
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    organizationInventoryId: integer("organization_inventory_id")
      .references(() => organizationInventory.id, { onDelete: "cascade" })
      .notNull(),
    // Tax-inclusive, like every other price in the system. NOT NULL because
    // "no override" is represented by the absence of the row, never by a NULL.
    customPriceCents: integer("custom_price_cents").notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("group_inventory_prices_group_item_uq").on(t.groupId, t.organizationInventoryId),
    index("group_inventory_prices_group_idx").on(t.groupId),
    index("group_inventory_prices_org_idx").on(t.organizationId),
    index("group_inventory_prices_item_idx").on(t.organizationInventoryId),
    check("group_inventory_prices_price_valid_ck", sql`${t.customPriceCents} >= 0`),
  ],
)

/**
 * Append-only history of catalogue price changes.
 *
 * Database triggers on the three authoritative tiers keep this ledger in the
 * same transaction as the price write. `BRANCH` rows are historical change
 * points inferred once from pre-ledger order data; new live rows are GLOBAL,
 * ORGANIZATION or GROUP changes and never depend on an order being placed.
 */
export const productPriceHistory = pgTable(
  "product_price_history",
  {
    id: serial("id").primaryKey(),
    globalProductId: integer("global_product_id")
      .references(() => globalProducts.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "set null" }),
    groupId: integer("group_id")
      .references(() => groups.id, { onDelete: "set null" }),
    branchId: integer("branch_id")
      .references(() => branches.id, { onDelete: "set null" }),
    previousPriceCents: bigint("previous_price_cents", { mode: "number" }),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    scope: varchar("scope", { length: 24 }).notNull(),
    changeType: varchar("change_type", { length: 40 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    changedByUserId: uuid("changed_by_user_id")
      .references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    sourceKey: varchar("source_key", { length: 160 }),
  },
  (t) => [
    uniqueIndex("product_price_history_source_key_uq")
      .on(t.sourceKey)
      .where(sql`${t.sourceKey} IS NOT NULL`),
    index("product_price_history_product_time_idx").on(t.globalProductId, t.changedAt, t.id),
    index("product_price_history_stream_time_idx")
      .on(t.globalProductId, t.organizationId, t.groupId, t.changedAt, t.id)
      .where(sql`${t.priceCents} > 0`),
    index("product_price_history_org_time_idx")
      .on(t.organizationId, t.changedAt)
      .where(sql`${t.organizationId} IS NOT NULL`),
    index("product_price_history_group_time_idx")
      .on(t.groupId, t.changedAt)
      .where(sql`${t.groupId} IS NOT NULL`),
    index("product_price_history_branch_time_idx")
      .on(t.branchId, t.changedAt)
      .where(sql`${t.branchId} IS NOT NULL`),
    check(
      "product_price_history_prices_valid_ck",
      sql`${t.priceCents} >= 0 AND (${t.previousPriceCents} IS NULL OR ${t.previousPriceCents} >= 0)`,
    ),
    check(
      "product_price_history_scope_valid_ck",
      sql`${t.scope} IN ('GLOBAL', 'ORGANIZATION', 'GROUP', 'BRANCH')`,
    ),
    check(
      "product_price_history_source_valid_ck",
      sql`${t.source} IN ('CATALOG_CHANGE', 'ORDER_BACKFILL', 'MIGRATION_BASELINE')`,
    ),
  ],
)

export const productQuantityBudgets = pgTable(
  "product_quantity_budgets",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    organizationInventoryId: integer("organization_inventory_id")
      .references(() => organizationInventory.id, { onDelete: "cascade" })
      .notNull(),
    globalProductId: integer("global_product_id")
      .references(() => globalProducts.id)
      .notNull(),
    period: varchar("period", { length: 16 }).notNull(),
    allocatedQuantity: numeric("allocated_quantity", { precision: 12, scale: 3, mode: "number" }).notNull().default(0),
    heldQuantity: numeric("held_quantity", { precision: 12, scale: 3, mode: "number" }).notNull().default(0),
    usedQuantity: numeric("used_quantity", { precision: 12, scale: 3, mode: "number" }).notNull().default(0),
    creditedQuantity: numeric("credited_quantity", { precision: 12, scale: 3, mode: "number" }).notNull().default(0),
    amountAllocatedCents: bigint("amount_allocated_cents", { mode: "number" }).notNull().default(0),
    amountCreditedCents: bigint("amount_credited_cents", { mode: "number" }).notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("product_quantity_budgets_branch_product_period_uq").on(t.branchId, t.organizationInventoryId, t.period),
    index("product_quantity_budgets_org_idx").on(t.organizationId),
    index("product_quantity_budgets_branch_idx").on(t.branchId),
    index("product_quantity_budgets_product_idx").on(t.globalProductId),
    index("product_quantity_budgets_period_idx").on(t.period),
    check("product_quantity_budgets_values_valid_ck", sql`${t.allocatedQuantity} >= 0 AND ${t.heldQuantity} >= 0 AND ${t.usedQuantity} >= 0 AND ${t.creditedQuantity} >= 0 AND ${t.amountAllocatedCents} >= 0 AND ${t.amountCreditedCents} >= 0 AND (${t.allocatedQuantity} + ${t.creditedQuantity}) >= (${t.heldQuantity} + ${t.usedQuantity})`),
  ],
)

export const productQuantityBudgetAllocations = pgTable(
  "product_quantity_budget_allocations",
  {
    id: serial("id").primaryKey(),
    quantityBudgetId: integer("quantity_budget_id")
      .references(() => productQuantityBudgets.id, { onDelete: "cascade" })
      .notNull(),
    budgetId: integer("budget_id").references(() => budgets.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    organizationInventoryId: integer("organization_inventory_id")
      .references(() => organizationInventory.id, { onDelete: "cascade" })
      .notNull(),
    globalProductId: integer("global_product_id")
      .references(() => globalProducts.id)
      .notNull(),
    period: varchar("period", { length: 16 }).notNull(),
    allocationType: varchar("allocation_type", { length: 32 }).notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    priceCents: bigint("price_cents", { mode: "number" }).notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("product_quantity_budget_allocations_budget_idx").on(t.quantityBudgetId),
    index("product_quantity_budget_allocations_branch_idx").on(t.branchId),
    index("product_quantity_budget_allocations_product_idx").on(t.globalProductId),
    index("product_quantity_budget_allocations_period_idx").on(t.period),
  ],
)

// Employee Credentials - For Order Portal access
export const employeeCredentials = pgTable(
  "employee_credentials",
  {
    id: serial("id").primaryKey(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    username: varchar("username", { length: 255 }),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    firstName: varchar("first_name", { length: 128 }),
    lastName: varchar("last_name", { length: 128 }),
    mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
    mfaSecret: varchar("mfa_secret", { length: 255 }),
    isActive: boolean("is_active").default(true).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    sessionVersion: integer("session_version").notNull().default(1),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
    lockoutUntil: timestamp("lockout_until", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("employee_creds_username_uq").on(t.username),
    index("employee_creds_email_uq").on(t.email),
    index("employee_creds_branch_idx").on(t.branchId),
    index("employee_creds_org_idx").on(t.organizationId),
    index("employee_creds_active_idx").on(t.isActive),
    index("employee_creds_created_by_idx").on(t.createdByUserId),
  ],
)

// System Logs - Comprehensive audit trail for all system activities
export const systemLogs = pgTable(
  "system_logs",
  {
    id: serial("id").primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
    userId: varchar("user_id", { length: 255 }), // Can be UUID or emp_123 format
    userRole: varchar("user_role", { length: 64 }),
    userEmail: varchar("user_email", { length: 255 }),
    organizationId: integer("organization_id").references(() => organizations.id),
    branchId: integer("branch_id").references(() => branches.id),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 128 }),
    details: jsonb("details").$type<Record<string, any>>(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    success: boolean("success").default(true).notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("system_logs_user_idx").on(t.userId),
    index("system_logs_action_idx").on(t.action),
    index("system_logs_resource_idx").on(t.resourceType, t.resourceId),
    index("system_logs_timestamp_idx").on(t.timestamp),
    index("system_logs_org_idx").on(t.organizationId),
    index("system_logs_branch_idx").on(t.branchId),
    index("system_logs_role_idx").on(t.userRole),
  ],
)

// ========================================
// GROUP-BASED REPORTING & ANALYTICS
// ========================================

// Groups - Collections of branches for reporting purposes
export const groups = pgTable(
  "groups",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).default("active"), // active, inactive, deleted
    createdByUserId: uuid("created_by_user_id").references(() => users.id).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("groups_org_idx").on(t.organizationId),
    index("groups_name_idx").on(t.name),
    index("groups_status_idx").on(t.status),
  ],
)

// Group Audit Logs - Track all group-related operations
export const groupAuditLogs = pgTable(
  "group_audit_logs",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    groupId: integer("group_id").references(() => groups.id),
    action: varchar("action", { length: 128 }).notNull(), // CREATE_GROUP, UPDATE_GROUP, DELETE_GROUP, ASSIGN_BRANCH, REMOVE_BRANCH, VIEW_REPORT
    performedByUserId: uuid("performed_by_user_id")
      .references(() => users.id)
      .notNull(),
    performedByRole: varchar("performed_by_role", { length: 64 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, any>>().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("group_audit_org_idx").on(t.organizationId),
    index("group_audit_group_idx").on(t.groupId),
    index("group_audit_action_idx").on(t.action),
    index("group_audit_user_idx").on(t.performedByUserId),
    index("group_audit_timestamp_idx").on(t.createdAt),
  ],
)


// ========================================
// REPORTING & SCHEDULING SYSTEM
// ========================================

export const scheduledReports = pgTable(
  "scheduled_reports",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    userId: uuid("user_id").references(() => users.id).notNull(),
    reportName: varchar("report_name", { length: 255 }).notNull(),
    frequency: varchar("frequency", { length: 32 }).notNull(), // daily, weekly, monthly
    format: varchar("format", { length: 16 }).notNull(), // pdf, csv, excel
    emails: jsonb("emails").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastExecutedAt: timestamp("last_executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("scheduled_reports_user_idx").on(t.userId),
    index("scheduled_reports_org_idx").on(t.organizationId),
    index("scheduled_reports_enabled_idx").on(t.enabled),
  ],
)

// ========================================
// CONTROLLED LEGACY DATA IMPORTS
// ========================================

// Import batches and per-source mappings make historical imports auditable,
// idempotent, and independently reversible without touching operational stock.
export const legacyImportBatches = pgTable(
  "legacy_import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    sourceSystem: varchar("source_system", { length: 64 }).notNull(),
    sourceManifest: jsonb("source_manifest").$type<Record<string, any>>().notNull(),
    status: varchar("status", { length: 32 }).notNull().default("RUNNING"),
    counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
    importedByUserId: uuid("imported_by_user_id").references(() => users.id).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  },
  (t) => [
    index("legacy_import_batches_org_idx").on(t.organizationId),
    index("legacy_import_batches_source_status_idx").on(t.sourceSystem, t.status),
  ],
)

export const legacyProductMappings = pgTable(
  "legacy_product_mappings",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    sourceSystem: varchar("source_system", { length: 64 }).notNull(),
    normalizedName: varchar("normalized_name", { length: 255 }).notNull(),
    sourceName: varchar("source_name", { length: 255 }).notNull(),
    sourceCodes: jsonb("source_codes").$type<string[]>().notNull().default([]),
    globalProductId: integer("global_product_id").references(() => globalProducts.id).notNull(),
    organizationInventoryId: integer("organization_inventory_id").references(() => organizationInventory.id).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("legacy_product_mappings_source_product_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.normalizedName,
    ),
    index("legacy_product_mappings_product_idx").on(t.globalProductId),
  ],
)

export const legacyUserMappings = pgTable(
  "legacy_user_mappings",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    sourceSystem: varchar("source_system", { length: 64 }).notNull(),
    legacyOrderTakerId: integer("legacy_order_taker_id").notNull(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    sourceName: varchar("source_name", { length: 255 }).notNull(),
    userId: uuid("user_id").references(() => users.id).notNull(),
    isSynthetic: boolean("is_synthetic").notNull().default(false),
    createdByBatchId: uuid("created_by_batch_id").references(() => legacyImportBatches.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("legacy_user_mappings_source_user_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.legacyOrderTakerId,
      t.branchId,
    ),
    index("legacy_user_mappings_user_idx").on(t.userId),
    index("legacy_user_mappings_batch_idx").on(t.createdByBatchId),
  ],
)

export const legacyOrderImports = pgTable(
  "legacy_order_imports",
  {
    id: serial("id").primaryKey(),
    batchId: uuid("batch_id").references(() => legacyImportBatches.id, { onDelete: "cascade" }).notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    sourceSystem: varchar("source_system", { length: 64 }).notNull(),
    legacyOrderId: integer("legacy_order_id").notNull(),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }).notNull(),
    sourceChecksum: varchar("source_checksum", { length: 64 }).notNull(),
    sourcePayload: jsonb("source_payload").$type<Record<string, any>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("legacy_order_imports_source_order_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.legacyOrderId,
    ),
    index("legacy_order_imports_batch_idx").on(t.batchId),
    uniqueIndex("legacy_order_imports_order_idx").on(t.orderId),
  ],
)


// ========================================
// GROUP ORDER PORTAL SCOPE
// ========================================

// Groups a GROUP_ORDER_PORTAL user may order on behalf of. The membership is
// intentionally stored as a group reference rather than a flattened branch
// list, so branches later added to (or removed from) the group are reflected
// automatically. Only GROUP_ORDER_PORTAL users ever get rows here; every other
// role keeps its existing single-branch scope untouched.
export const userGroupAssignments = pgTable(
  "user_group_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    groupId: integer("group_id")
      .references(() => groups.id, { onDelete: "cascade" })
      .notNull(),
    // Denormalized tenant guard: every assignment is pinned to the tenant it
    // was created under so a cross-tenant row is impossible to write.
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("user_group_assignments_user_group_uq").on(t.userId, t.groupId),
    index("user_group_assignments_user_idx").on(t.userId),
    index("user_group_assignments_group_idx").on(t.groupId),
    index("user_group_assignments_org_idx").on(t.organizationId),
  ],
)

// Individually assigned branches for a GROUP_ORDER_PORTAL user, layered on top
// of whatever the assigned groups already resolve to.
export const userBranchAssignments = pgTable(
  "user_branch_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("user_branch_assignments_user_branch_uq").on(t.userId, t.branchId),
    index("user_branch_assignments_user_idx").on(t.userId),
    index("user_branch_assignments_branch_idx").on(t.branchId),
    index("user_branch_assignments_org_idx").on(t.organizationId),
  ],
)

// ========================================
// GROUP ORDERS (multi-branch submissions)
// ========================================

/**
 * One submission a Group Order Portal user made for many branches at once.
 *
 * The user experiences a single group order; the application still records one
 * ordinary row in `orders` per branch, linked back here through
 * `orders.groupOrderId`. Every downstream path — approval, budget, refund,
 * reporting — therefore keeps operating on normal single-branch orders and is
 * completely unaffected by this envelope.
 */
export const groupOrders = pgTable(
  "group_orders",
  {
    id: serial("id").primaryKey(),
    // Human-facing tracking id shown to the user (e.g. GRP-8F3K2QWD).
    reference: varchar("reference", { length: 32 }).notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    // Nullable so a submission covering branches without a group assignment is
    // still representable.
    groupId: integer("group_id").references(() => groups.id),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id)
      .notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestFingerprint: varchar("request_fingerprint", { length: 64 }).notNull(),
    notes: text("notes"),
    // Buyer-supplied purchase order reference for the whole submission. Copied
    // onto every branch order created beneath this envelope.
    poNumber: varchar("po_number", { length: 64 }),
    // Outcome snapshot. Branch orders are created independently, so a
    // submission can succeed for some branches and fail for others; the
    // failures are kept with their reason so the user can correct them.
    requestedBranchCount: integer("requested_branch_count").notNull().default(0),
    createdOrderCount: integer("created_order_count").notNull().default(0),
    failures: jsonb("failures")
      .$type<Array<{ branchId: number; branchName: string; reason: string }>>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("group_orders_reference_uq").on(t.reference),
    // Replaying the same Idempotency-Key returns the original submission rather
    // than creating a second set of branch orders.
    uniqueIndex("group_orders_creator_idempotency_uq").on(t.createdByUserId, t.idempotencyKey),
    index("group_orders_org_idx").on(t.organizationId),
    index("group_orders_creator_created_idx").on(t.createdByUserId, t.createdAt),
    index("group_orders_group_idx").on(t.groupId),
  ],
)

/**
 * One resumable draft per Group Order Portal user.
 *
 * The payload holds selections only — branch ids, inventory ids, quantities.
 * Prices and availability are always re-resolved on the server at submission
 * time, so a stale or tampered draft can never carry a stale price into an
 * order.
 */
export const groupOrderDrafts = pgTable(
  "group_order_drafts",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    groupId: integer("group_id").references(() => groups.id),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [uniqueIndex("group_order_drafts_user_uq").on(t.userId)],
)

/**
 * Direct communication between a client organization and Apricart.
 *
 * A support thread is a conversation, not a decision. It may be raised against
 * a specific order — and therefore against that order's invoice — or stand on
 * its own. Apricart (`SUPER_ADMIN`) participates in every thread; who on the
 * client side may read it is decided by `lib/support-access.ts` and is never
 * stored, so a role change takes effect immediately rather than leaving a
 * stale grant behind.
 *
 * There is deliberately no `reference` column: the human reference `SUP-000123`
 * is derived from the id by `supportThreadReference()`, and a column would be a
 * second source of truth for a value that is already unique.
 */
export const supportThreads = pgTable(
  "support_threads",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    // Null when the raiser has no branch of their own — Head Office does not.
    branchId: integer("branch_id").references(() => branches.id),
    // The order the query is about, when there is one. Nulled rather than
    // cascaded so a thread survives an order being removed: the conversation is
    // the record of what was asked, and it outlives its subject.
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    // The product the query is about, when there is one. Points at the global
    // catalogue rather than the organization's assignment row: the thread
    // already carries its organization, so the pair resolves the tenant's own
    // name for the product, and the reference survives the assignment later
    // being disabled — the conversation is still about that product.
    productId: integer("product_id").references(() => globalProducts.id, { onDelete: "set null" }),
    subject: varchar("subject", { length: 200 }).notNull(),
    category: varchar("category", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("OPEN"),
    priority: varchar("priority", { length: 16 }).notNull().default("NORMAL"),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id)
      .notNull(),
    // An Apricart person who has picked the thread up. Triage only — it grants
    // nothing and withholds nothing, every SUPER_ADMIN still reads every thread.
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow().notNull(),
    lastMessageSide: varchar("last_message_side", { length: 16 }).notNull().default("CUSTOMER"),
    // Recorded so response time can be measured later without a backfill.
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("support_threads_org_idx").on(t.organizationId),
    index("support_threads_branch_idx").on(t.branchId),
    index("support_threads_order_idx").on(t.orderId),
    index("support_threads_product_idx").on(t.productId),
    index("support_threads_creator_idx").on(t.createdByUserId),
    index("support_threads_assignee_idx").on(t.assignedToUserId),
    // The list is always ordered by most recent activity, within a scope.
    index("support_threads_org_activity_idx").on(t.organizationId, t.lastMessageAt),
    index("support_threads_status_activity_idx").on(t.status, t.lastMessageAt),
    check(
      "support_threads_status_valid_ck",
      sql`${t.status} IN ('OPEN', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED')`,
    ),
    check(
      "support_threads_category_valid_ck",
      sql`${t.category} IN ('INVOICE', 'ORDER', 'DELIVERY', 'PRODUCT', 'BILLING', 'OTHER')`,
    ),
    check(
      "support_threads_priority_valid_ck",
      sql`${t.priority} IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')`,
    ),
    check(
      "support_threads_side_valid_ck",
      sql`${t.lastMessageSide} IN ('CUSTOMER', 'APRICART')`,
    ),
    check("support_threads_message_count_ck", sql`${t.messageCount} >= 0`),
    check("support_threads_subject_present_ck", sql`char_length(btrim(${t.subject})) > 0`),
  ],
)

/**
 * One message in a thread.
 *
 * `authorRole` is a snapshot taken when the message was written. A person's
 * role can change; the record of who said what, in what capacity, must not.
 */
export const supportMessages = pgTable(
  "support_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .references(() => supportThreads.id, { onDelete: "cascade" })
      .notNull(),
    authorUserId: uuid("author_user_id")
      .references(() => users.id)
      .notNull(),
    authorSide: varchar("author_side", { length: 16 }).notNull(),
    authorRole: varchar("author_role", { length: 64 }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("support_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("support_messages_author_idx").on(t.authorUserId),
    check("support_messages_side_valid_ck", sql`${t.authorSide} IN ('CUSTOMER', 'APRICART')`),
    check(
      "support_messages_body_length_ck",
      sql`char_length(btrim(${t.body})) BETWEEN 1 AND 5000`,
    ),
  ],
)

/**
 * An image attached to a support message.
 *
 * Uploaded first and *claimed* by the message that carries it, inside the same
 * transaction that writes the message. Until it is claimed both `thread_id` and
 * `message_id` are null and the object is readable by nobody.
 *
 * The object itself lives in the private uploads bucket under the `support/`
 * prefix, deliberately outside the `products/` prefix that
 * `GET /api/v1/images/[...key]` will serve to any signed-in user. A support
 * attachment comes back only through `GET /api/v1/support/attachments/[id]`,
 * which applies the owning thread's visibility rule.
 */
export const supportAttachments = pgTable(
  "support_attachments",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id").references(() => supportThreads.id, { onDelete: "cascade" }),
    messageId: integer("message_id").references(() => supportMessages.id, { onDelete: "cascade" }),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .references(() => users.id)
      .notNull(),
    storageKey: varchar("storage_key", { length: 255 }).notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("support_attachments_storage_key_uq").on(t.storageKey),
    index("support_attachments_message_idx").on(t.messageId),
    index("support_attachments_thread_idx").on(t.threadId),
    // The claim looks up this uploader's unclaimed rows by id.
    index("support_attachments_uploader_idx").on(t.uploadedByUserId, t.createdAt),
    check(
      "support_attachments_size_valid_ck",
      sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 4194304`,
    ),
  ],
)

/**
 * How far each participant has read a thread.
 *
 * Not a participant table — being listed here grants nothing. It exists so the
 * list can show which conversations have moved since the viewer last looked.
 */
export const supportThreadReads = pgTable(
  "support_thread_reads",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .references(() => supportThreads.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("support_thread_reads_thread_user_uq").on(t.threadId, t.userId),
    index("support_thread_reads_user_idx").on(t.userId),
  ],
)

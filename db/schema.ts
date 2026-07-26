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
    status: varchar("status", { length: 32 }).default("active"),
    logoUrl: varchar("logo_url", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    orgNameIdx: uniqueIndex("org_name_idx").on(t.name),
    orgCodeIdx: uniqueIndex("org_code_idx").on(t.code),
    orgStatusIdx: index("org_status_idx").on(t.status),
  }),
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
    status: varchar("status", { length: 32 }).default("active"),
    // Group assignment for reporting and analytics
    groupId: integer("group_id"),
    // Base budget for "Add-on" calculation
    baselineBudgetCents: bigint("baseline_budget_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    orgIdx: index("branches_org_idx").on(t.organizationId),
    nameIdx: index("branches_name_idx").on(t.name),
    costCenterIdx: index("branches_cost_center_idx").on(t.costCenterId),
    statusIdx: index("branches_status_idx").on(t.status),
    groupIdx: index("branches_group_idx").on(t.groupId),
  }),
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
  (t) => ({
    nameIdx: uniqueIndex("roles_name_idx").on(t.name),
  }),
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
  (t) => ({
    rolePermIdx: index("role_permissions_role_idx").on(t.roleId),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    sessionVersion: integer("session_version").notNull().default(1),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
  },
  (t) => ({
    usernameIdx: uniqueIndex("users_username_idx").on(t.username),
    emailIdx: index("users_email_idx").on(t.email),
    roleIdx: index("users_role_idx").on(t.roleId),
    activeIdx: index("users_active_idx").on(t.isActive),
    orgIdx: index("users_org_idx").on(t.organizationId),
    branchIdx: index("users_branch_idx").on(t.branchId),
    employeeIdIdx: index("users_employee_id_idx").on(t.employeeId),
  }),
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
  (t) => ({
    userIdx: index("mfa_codes_user_idx").on(t.userId),
    codeIdx: index("mfa_codes_code_idx").on(t.code),
    expiresIdx: index("mfa_codes_expires_idx").on(t.expiresAt),
    typeIdx: index("mfa_codes_type_idx").on(t.type),
  }),
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
  (t) => ({
    nameIdx: index("categories_name_idx").on(t.name),
    catOrgIdx: index("categories_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    catIdx: index("products_category_idx").on(t.categoryId),
    nameIdx: index("products_name_idx").on(t.name),
    prodOrgIdx: index("products_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    productIdx: index("skus_product_idx").on(t.productId),
    skuIdx: uniqueIndex("skus_sku_idx").on(t.sku),
    skusOrgIdx: index("skus_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    byBranchSku: uniqueIndex("inventory_branch_sku_uq").on(t.branchId, t.skuId),
    branchIdx: index("inventory_branch_idx").on(t.branchId),
    inventoryOrgIdx: index("inventory_org_idx").on(t.organizationId),
    inventoryOrgBranchSkuIdx: index("inventory_org_branch_sku_idx").on(t.organizationId, t.branchId, t.skuId),
  }),
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
  (t) => ({
    headOrgIdx: index("head_offices_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    orgIdx: index("suppliers_org_idx").on(t.organizationId),
    branchIdx: index("suppliers_branch_idx").on(t.branchId),
    nameIdx: index("suppliers_name_idx").on(t.name),
  }),
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
  (t) => ({
    branchPeriodUq: uniqueIndex("budgets_branch_period_uq").on(t.branchId, t.period),
    orgIdx: index("budgets_org_idx").on(t.organizationId),
    branchIdx: index("budgets_branch_idx").on(t.branchId),
    budgetValuesValid: check("budgets_values_valid_ck", sql`${t.amountAllocatedCents} >= 0 AND ${t.amountSpentCents} >= 0 AND ${t.amountHeldCents} >= 0 AND ${t.amountCreditedCents} >= 0 AND (${t.amountAllocatedCents} + ${t.amountCreditedCents}) >= (${t.amountSpentCents} + ${t.amountHeldCents})`),
  }),
)

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
  },
  (t) => ({
    budgetIdx: index("budget_addons_budget_idx").on(t.budgetId),
  }),
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
  (t) => ({
    orgSettingsOrgIdx: index("org_settings_org_idx").on(t.organizationId),
    orgSettingsOrgKeyUq: uniqueIndex("organization_settings_org_key_uq").on(t.organizationId, t.key),
  }),
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
  (t) => ({
    orgMetricsOrgIdx: index("org_metrics_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    invoiceSequenceRange: check("invoice_sequences_range_ck", sql`${t.lastValue} >= 0 AND ${t.lastValue} <= 999999`),
  }),
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
    // Refund tracking fields
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    refundedByUserId: uuid("refunded_by_user_id").references(() => users.id),
    statusAtRefund: varchar("status_at_refund", { length: 32 }), // Status before refund (e.g., "APPROVED", "FULFILLED")
    refundAmountCents: bigint("refund_amount_cents", { mode: "number" }), // Total refund amount
    refundReason: text("refund_reason"),
    // Receipt data - complete snapshot for historical accuracy
    receiptData: jsonb("receipt_data").$type<{
      invoiceNumber: string
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
  (t) => ({
    tidIdx: uniqueIndex("orders_tid_idx").on(t.tid),
    branchIdx: index("orders_branch_idx").on(t.branchId),
    statusIdx: index("orders_status_idx").on(t.status),
    fulfillmentStatusIdx: index("orders_fulfillment_status_idx").on(t.fulfillmentStatus),
    paymentStatusIdx: index("orders_payment_status_idx").on(t.paymentStatus),
    createdIdx: index("orders_created_idx").on(t.createdAt),
    ordersOrgIdx: index("orders_org_idx").on(t.organizationId),
    ordersOrgBranchStatusIdx: index("orders_org_branch_status_idx").on(t.organizationId, t.branchId, t.status),
    ordersBranchStatusCreatedIdx: index("orders_branch_status_created_idx").on(t.branchId, t.status, t.createdAt),
    ordersOrgCreatedIdx: index("orders_org_created_idx").on(t.organizationId, t.createdAt),
    ordersCreatorIdempotencyUq: uniqueIndex("orders_creator_idempotency_uq").on(t.createdByUserId, t.idempotencyKey),
    orderAmountsNonnegative: check("orders_amounts_nonnegative_ck", sql`${t.subtotalCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.totalCents} >= 0 AND COALESCE(${t.refundAmountCents}, 0) >= 0 AND COALESCE(${t.refundAmountCents}, 0) <= ${t.totalCents}`),
    orderIdempotencyPair: check("orders_idempotency_pair_ck", sql`(${t.idempotencyKey} IS NULL AND ${t.requestFingerprint} IS NULL) OR (${t.idempotencyKey} IS NOT NULL AND ${t.requestFingerprint} IS NOT NULL)`),
  }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    orderIdx: index("order_items_order_idx").on(t.orderId),
    orderItemsOrgIdx: index("order_items_org_idx").on(t.organizationId),
    organizationInventoryIdx: index("order_items_organization_inventory_idx").on(t.organizationInventoryId),
    globalProductIdx: index("order_items_product_idx").on(t.globalProductId),
    orderItemsProductOrderIdx: index("order_items_product_order_idx").on(t.globalProductId, t.orderId),
    orderItemValuesValid: check("order_items_values_valid_ck", sql`${t.quantity} > 0 AND ${t.quantity} <= 1000000 AND ${t.priceCents} >= 0`),
  }),
)

export const refunds = pgTable(
  "refunds",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id),
    orderId: integer("order_id")
      .references(() => orders.id)
      .notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    reason: varchar("reason", { length: 255 }),
    // New workflow: support pending refund requests
    status: varchar("status", { length: 16 }).notNull().default("PENDING"), // PENDING, APPROVED
    refundNumber: varchar("refund_number", { length: 20 }).unique(),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id),
    processedByUserId: uuid("processed_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    orderIdx: index("refunds_order_idx").on(t.orderId),
    refundsOrgIdx: index("refunds_org_idx").on(t.organizationId),
    processedByIdx: index("refunds_processed_by_idx").on(t.processedByUserId),
    refundAmountPositive: check("refunds_amount_positive_ck", sql`${t.amountCents} > 0`),
  }),
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
  (t) => ({
    refundIdx: index("refund_items_refund_idx").on(t.refundId),
    orderItemIdx: index("refund_items_order_item_idx").on(t.orderItemId),
    refundItemValuesValid: check("refund_items_values_valid_ck", sql`${t.quantity} > 0 AND ${t.quantity} <= 1000000 AND ${t.amountCents} >= 0`),
  }),
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
    eventKey: varchar("event_key", { length: 255 }),
    message: text("message").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(t.userId),
    typeIdx: index("notifications_type_idx").on(t.type),
    notiOrgIdx: index("notifications_org_idx").on(t.organizationId),
    notiBranchIdx: index("notifications_branch_idx").on(t.branchId),
    notiOrderIdx: index("notifications_order_idx").on(t.orderId),
    notiEventKeyUq: uniqueIndex("notifications_event_key_uq").on(t.eventKey),
  }),
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
    branchId: integer("branch_id")
      .references(() => branches.id, { onDelete: "cascade" })
      .notNull(),
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
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
  (t) => ({
    eventKeyUq: uniqueIndex("email_outbox_event_key_uq").on(t.eventKey),
    statusNextAttemptIdx: index("email_outbox_status_next_attempt_idx").on(t.status, t.nextAttemptAt),
    recipientIdx: index("email_outbox_recipient_idx").on(t.recipientUserId),
    orgIdx: index("email_outbox_org_idx").on(t.organizationId),
    branchIdx: index("email_outbox_branch_idx").on(t.branchId),
    orderIdx: index("email_outbox_order_idx").on(t.orderId),
    attemptsNonnegative: check("email_outbox_attempts_nonnegative_ck", sql`${t.attempts} >= 0`),
    statusValid: check("email_outbox_status_valid_ck", sql`${t.status} IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED')`),
  }),
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
  (t) => ({
    userIdx: index("audit_user_idx").on(t.userId),
    entityIdx: index("audit_entity_idx").on(t.entity),
    auditOrgIdx: index("audit_org_idx").on(t.organizationId),
    auditBranchIdx: index("audit_branch_idx").on(t.branchId),
    auditCreatedActionIdx: index("audit_created_action_idx").on(t.createdAt, t.action),
  }),
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
  (t) => ({
    userIdx: index("sessions_user_idx").on(t.userId),
    expiresIdx: index("sessions_expires_idx").on(t.expiresAt),
    sessionOrgIdx: index("sessions_org_idx").on(t.organizationId),
  }),
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
  (t) => ({
    // Partial unique index enforced via SQL migration (allows reuse of codes from soft-deleted products)
    codeIdx: index("global_products_code_idx").on(t.productCode),
    nameIdx: index("global_products_name_idx").on(t.name),
    categoryIdx: index("global_products_category_idx").on(t.categoryId),
    statusIdx: index("global_products_status_idx").on(t.status),
    globalProductsCatStatusIdx: index("global_products_cat_status_idx").on(t.categoryId, t.status),
    globalProductsStatusCreatedIdx: index("global_products_status_created_idx").on(t.status, t.createdAt),
    globalProductValuesValid: check("global_products_values_valid_ck", sql`${t.basePrice} >= 0 AND ${t.stockQuantity} >= 0 AND ${t.quantityStep} > 0 AND COALESCE(${t.discountValue}, 0) >= 0`),
  }),
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
  (t) => ({
    orgProductUq: uniqueIndex("org_products_org_product_uq").on(t.organizationId, t.globalProductId),
    orgIdx: index("org_products_org_idx").on(t.organizationId),
    globalProductIdx: index("org_products_global_idx").on(t.globalProductId),
    enabledIdx: index("org_products_enabled_idx").on(t.isEnabled),
    organizationProductPriceValid: check("organization_products_price_valid_ck", sql`${t.customPrice} IS NULL OR ${t.customPrice} >= 0`),
  }),
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
  (t) => ({
    branchProductUq: uniqueIndex("branch_products_branch_product_uq").on(t.branchId, t.globalProductId),
    branchIdx: index("branch_products_branch_idx").on(t.branchId),
    orgIdx: index("branch_products_org_idx").on(t.organizationId),
    globalProductIdx: index("branch_products_global_idx").on(t.globalProductId),
    orgProductIdx: index("branch_products_org_product_idx").on(t.organizationProductId),
    visibleIdx: index("branch_products_visible_idx").on(t.isVisible),
    availableIdx: index("branch_products_available_idx").on(t.isAvailable),
  }),
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
  (t) => ({
    productIdx: index("product_assignments_product_idx").on(t.globalProductId),
    assignedToIdx: index("product_assignments_assigned_to_idx").on(t.assignedToType, t.assignedToId),
    userIdx: index("product_assignments_user_idx").on(t.performedByUserId),
  }),
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
  (t) => ({
    branchIdx: index("restock_requests_branch_idx").on(t.branchId),
    orgIdx: index("restock_requests_org_idx").on(t.organizationId),
    productIdx: index("restock_requests_product_idx").on(t.globalProductId),
    statusIdx: index("restock_requests_status_idx").on(t.status),
    requestedByIdx: index("restock_requests_requested_by_idx").on(t.requestedByUserId),
  }),
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
  (t) => ({
    syncTypeIdx: index("inventory_sync_logs_type_idx").on(t.syncType),
    targetIdx: index("inventory_sync_logs_target_idx").on(t.targetType, t.targetId),
    statusIdx: index("inventory_sync_logs_status_idx").on(t.status),
    userIdx: index("inventory_sync_logs_user_idx").on(t.performedByUserId),
    startedAtIdx: index("inventory_sync_logs_started_at_idx").on(t.startedAt),
  }),
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
  (t) => ({
    userIdx: index("product_import_batches_user_idx").on(t.uploadedByUserId),
    statusIdx: index("product_import_batches_status_idx").on(t.status),
    createdAtIdx: index("product_import_batches_created_at_idx").on(t.createdAt),
  }),
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
  (t) => ({
    nameIdx: index("modifiers_name_idx").on(t.name),
    typeIdx: index("modifiers_type_idx").on(t.type),
    statusIdx: index("modifiers_status_idx").on(t.status),
    userIdx: index("modifiers_user_idx").on(t.createdByUserId),
  }),
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
  (t) => ({
    productIdx: index("product_modifiers_product_idx").on(t.productId),
    modifierIdx: index("product_modifiers_modifier_idx").on(t.modifierId),
    productModifierIdx: uniqueIndex("product_modifiers_product_modifier_idx").on(t.productId, t.modifierId),
  }),
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
  (t) => ({
    orgProductUq: uniqueIndex("org_inventory_org_product_uq").on(t.organizationId, t.globalProductId),
    orgIdx: index("org_inventory_org_idx").on(t.organizationId),
    globalProductIdx: index("org_inventory_global_product_idx").on(t.globalProductId),
    assignedByIdx: index("org_inventory_assigned_by_idx").on(t.assignedByUserId),
    activeIdx: index("org_inventory_active_idx").on(t.isActive),
    deletedAtIdx: index("org_inventory_deleted_at_idx").on(t.deletedAt),
    organizationInventoryPriceValid: check("organization_inventory_price_valid_ck", sql`${t.customPrice} IS NULL OR ${t.customPrice} >= 0`),
  }),
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
  (t) => ({
    branchOrgInventoryUq: uniqueIndex("branch_inventory_branch_org_inventory_uq").on(t.branchId, t.organizationInventoryId),
    branchIdx: index("branch_inventory_branch_idx").on(t.branchId),
    orgIdx: index("branch_inventory_org_idx").on(t.organizationId),
    orgInventoryIdx: index("branch_inventory_org_inventory_idx").on(t.organizationInventoryId),
    assignedByIdx: index("branch_inventory_assigned_by_idx").on(t.assignedByUserId),
    visibleIdx: index("branch_inventory_visible_idx").on(t.isVisible),
    activeIdx: index("branch_inventory_active_idx").on(t.isActive),
    deletedAtIdx: index("branch_inventory_deleted_at_idx").on(t.deletedAt),
    branchInventoryStatusIdx: index("branch_inventory_status_idx").on(t.branchId, t.isVisible, t.isActive),
  }),
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
  (t) => ({
    branchProductPeriodUq: uniqueIndex("product_quantity_budgets_branch_product_period_uq").on(t.branchId, t.organizationInventoryId, t.period),
    orgIdx: index("product_quantity_budgets_org_idx").on(t.organizationId),
    branchIdx: index("product_quantity_budgets_branch_idx").on(t.branchId),
    productIdx: index("product_quantity_budgets_product_idx").on(t.globalProductId),
    periodIdx: index("product_quantity_budgets_period_idx").on(t.period),
    quantityBudgetValuesValid: check("product_quantity_budgets_values_valid_ck", sql`${t.allocatedQuantity} >= 0 AND ${t.heldQuantity} >= 0 AND ${t.usedQuantity} >= 0 AND ${t.creditedQuantity} >= 0 AND ${t.amountAllocatedCents} >= 0 AND ${t.amountCreditedCents} >= 0 AND (${t.allocatedQuantity} + ${t.creditedQuantity}) >= (${t.heldQuantity} + ${t.usedQuantity})`),
  }),
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
  (t) => ({
    quantityBudgetIdx: index("product_quantity_budget_allocations_budget_idx").on(t.quantityBudgetId),
    branchIdx: index("product_quantity_budget_allocations_branch_idx").on(t.branchId),
    productIdx: index("product_quantity_budget_allocations_product_idx").on(t.globalProductId),
    periodIdx: index("product_quantity_budget_allocations_period_idx").on(t.period),
  }),
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
  },
  (t) => ({
    usernameUq: uniqueIndex("employee_creds_username_uq").on(t.username),
    emailUq: index("employee_creds_email_uq").on(t.email),
    branchIdx: index("employee_creds_branch_idx").on(t.branchId),
    orgIdx: index("employee_creds_org_idx").on(t.organizationId),
    activeIdx: index("employee_creds_active_idx").on(t.isActive),
    createdByIdx: index("employee_creds_created_by_idx").on(t.createdByUserId),
  }),
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
  (t) => ({
    userIdx: index("system_logs_user_idx").on(t.userId),
    actionIdx: index("system_logs_action_idx").on(t.action),
    resourceIdx: index("system_logs_resource_idx").on(t.resourceType, t.resourceId),
    timestampIdx: index("system_logs_timestamp_idx").on(t.timestamp),
    orgIdx: index("system_logs_org_idx").on(t.organizationId),
    branchIdx: index("system_logs_branch_idx").on(t.branchId),
    roleIdx: index("system_logs_role_idx").on(t.userRole),
  }),
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
  (t) => ({
    orgIdx: index("groups_org_idx").on(t.organizationId),
    nameIdx: index("groups_name_idx").on(t.name),
    statusIdx: index("groups_status_idx").on(t.status),
    // REMOVED: orgNameUq - replaced with partial unique index via SQL migration
    // This allows recreating groups with same name after deletion (status='deleted')
  }),
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
  (t) => ({
    orgIdx: index("group_audit_org_idx").on(t.organizationId),
    groupIdx: index("group_audit_group_idx").on(t.groupId),
    actionIdx: index("group_audit_action_idx").on(t.action),
    userIdx: index("group_audit_user_idx").on(t.performedByUserId),
    timestampIdx: index("group_audit_timestamp_idx").on(t.createdAt),
  }),
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
  (t) => ({
    userIdx: index("scheduled_reports_user_idx").on(t.userId),
    orgIdx: index("scheduled_reports_org_idx").on(t.organizationId),
    enabledIdx: index("scheduled_reports_enabled_idx").on(t.enabled),
  }),
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
  (t) => ({
    orgIdx: index("legacy_import_batches_org_idx").on(t.organizationId),
    sourceStatusIdx: index("legacy_import_batches_source_status_idx").on(t.sourceSystem, t.status),
  }),
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
  (t) => ({
    sourceProductUq: uniqueIndex("legacy_product_mappings_source_product_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.normalizedName,
    ),
    productIdx: index("legacy_product_mappings_product_idx").on(t.globalProductId),
  }),
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
  (t) => ({
    sourceUserUq: uniqueIndex("legacy_user_mappings_source_user_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.legacyOrderTakerId,
      t.branchId,
    ),
    userIdx: index("legacy_user_mappings_user_idx").on(t.userId),
    batchIdx: index("legacy_user_mappings_batch_idx").on(t.createdByBatchId),
  }),
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
  (t) => ({
    sourceOrderUq: uniqueIndex("legacy_order_imports_source_order_uq").on(
      t.organizationId,
      t.sourceSystem,
      t.legacyOrderId,
    ),
    batchIdx: index("legacy_order_imports_batch_idx").on(t.batchId),
    orderIdx: uniqueIndex("legacy_order_imports_order_idx").on(t.orderId),
  }),
)

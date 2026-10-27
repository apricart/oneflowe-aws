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
  date,
  foreignKey,
  unique,
  doublePrecision,
  type PgTableExtraConfigValue,
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
    // Optional sales tax registration number, printed under Bill To beside the
    // NTN. Nullable for the same reasons; set on Create / Edit Organization.
    // See plans/OF-INVOICE-invoice-ledger.md (D9).
    strnNumber: varchar("strn_number", { length: 32 }),
    status: varchar("status", { length: 32 }).default("active"),
    orderApproverRole: varchar("order_approver_role", { length: 32 })
      .notNull()
      .default("BRANCH_ADMIN"),
    // Existing tenants retain the approval workflow. A Super Admin may opt a
    // tenant into immediate approval for orders created after the change.
    orderApprovalRequired: boolean("order_approval_required")
      .notNull()
      .default(true),
    // When enabled, a branch of this tenant holding two unpaid invoices may not
    // place a new order (lib/server/overdue-payment-source.ts). Set by Super
    // Admin only; defaults to false so no existing tenant is blocked on deploy.
    blockOrderingOnUnpaidInvoices: boolean("block_ordering_on_unpaid_invoices")
      .notNull()
      .default(false),
    // When enabled, a branch of this tenant holding two orders that are
    // delivered but not yet acknowledged may not place a new order
    // (lib/server/unacknowledged-delivery-block.ts). Super Admin only; off by
    // default so no existing tenant is blocked on deploy.
    blockOrderingOnUnacknowledgedDeliveries: boolean("block_ordering_on_unacknowledged_deliveries")
      .notNull()
      .default(false),
    // How many of each a branch may hold before it stops ordering, while the
    // matching block is on. Super Admin only; 1..100 (lib/ordering-block-threshold.ts),
    // default 2 — the fixed value before it was configurable.
    unpaidInvoiceBlockThreshold: integer("unpaid_invoice_block_threshold")
      .notNull()
      .default(2),
    unacknowledgedDeliveryBlockThreshold: integer("unacknowledged_delivery_block_threshold")
      .notNull()
      .default(2),
    // Whether this tenant's orders are checked against, and held from, a branch
    // budget (lib/server/organization-budget-policy.ts). The column default is
    // true so existing tenants and directly inserted rows keep their budget
    // control; the application creates organizations with an explicit false.
    // Super Admin only.
    budgetsEnabled: boolean("budgets_enabled")
      .notNull()
      .default(true),
    // Whether Apricart's Order Desk keys in this customer's orders (taken by
    // email or WhatsApp). Off by default, so no existing tenant becomes
    // reachable by the desk. Super Admin only; a desk user additionally needs
    // an `order_desk_assignments` row. See lib/order-desk-access.ts.
    managedOrdering: boolean("managed_ordering")
      .notNull()
      .default(false),
    // When enabled, members of this tenant may only authenticate from an
    // address in organizationAllowedIps. Defaults to false so every existing
    // organization keeps unrestricted login until a Super Admin opts in.
    privateNetworkLoginEnabled: boolean("private_network_login_enabled")
      .notNull()
      .default(false),
    // Whether this tenant's orders carry approval levels, defined in
    // organizationApprovalLevels. Super Admin only; off by default so no
    // existing tenant changes. Phase 1 stores the configuration only — nothing
    // in the order path reads it yet.
    // See plans/OF-APPROVAL-LEVELS-organization-approval-levels.md.
    orderApprovalLevelsEnabled: boolean("order_approval_levels_enabled")
      .notNull()
      .default(false),
    logoUrl: varchar("logo_url", { length: 512 }),
    // The domain an applicant's address must be at, e.g. `ke.com.pk`. Set by
    // Super Admin; null means self-service applications are refused. Not
    // unique: tenants that share a mail system share a domain.
    emailDomain: varchar("email_domain", { length: 253 }),
    // The last day (Asia/Karachi) this tenant's agreed prices are valid for.
    // Super Admin only; null = no contract date recorded. A reminder only — no
    // order, price or catalogue rule reads it (lib/price-contract-validity.ts,
    // plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
    priceContractValidUntil: date("price_contract_valid_until"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("org_name_idx").on(t.name),
    uniqueIndex("org_code_idx").on(t.code),
    index("org_status_idx").on(t.status),
    // The reminder sweep and the dashboard alert read the few dated rows only.
    index("organizations_price_contract_valid_until_idx")
      .on(t.priceContractValidUntil)
      .where(sql`${t.priceContractValidUntil} IS NOT NULL`),
    check(
      "organizations_order_approver_role_ck",
      sql`${t.orderApproverRole} IN ('BRANCH_ADMIN', 'HEAD_OFFICE')`,
    ),
    // `EMAIL_DOMAIN_PATTERN` in lib/organization-email-domain.ts, held here too
    // so no writer can store a spelling the comparison would never match.
    check(
      "organizations_email_domain_shape_ck",
      sql`${t.emailDomain} IS NULL OR (${t.emailDomain} = lower(${t.emailDomain}) AND ${t.emailDomain} ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$')`,
    ),
    // ORDERING_BLOCK_THRESHOLD_MIN..MAX in lib/ordering-block-threshold.ts.
    check(
      "organizations_unpaid_invoice_block_threshold_ck",
      sql`${t.unpaidInvoiceBlockThreshold} BETWEEN 1 AND 100`,
    ),
    check(
      "organizations_unacknowledged_delivery_block_threshold_ck",
      sql`${t.unacknowledgedDeliveryBlockThreshold} BETWEEN 1 AND 100`,
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
    // Delivery region, for the management delivery dashboard. One of
    // BRANCH_REGIONS (lib/branch-region.ts) or NULL ("Unknown"); set by Super
    // Admin in the branch form. See plans/OF-DELIVERY-management-delivery-dashboard.md.
    region: varchar("region", { length: 16 }),
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
    // How many people work at the branch; NULL = not provided. Written directly
    // by Super Admin / Head Office, or by Head Office approving a
    // branch_head_count_requests row. See plans/OF-BRANCH-head-count.md.
    headCount: integer("head_count"),
    // The number the branch is reached on; NULL = not provided. Written by Super
    // Admin / Head Office through the branch create and edit routes, held to
    // isValidBranchContactPhone (lib/branch-contact-phone.ts). See
    // plans/OF-BRANCH-contact-phone.md.
    contactPhone: varchar("contact_phone", { length: 32 }),
    // Parent / child / standalone: a label only, read by no access, budget,
    // price or catalogue rule. One of BRANCH_HIERARCHY_ROLES
    // (lib/branch-hierarchy.ts); a child names its parent, a parent of its own
    // organization (branches_parent_org_fk) that is itself a PARENT (the
    // branches_hierarchy_guard trigger). See plans/OF-BRANCH-parent-child-label.md.
    hierarchyRole: varchar("hierarchy_role", { length: 16 }).notNull().default("STANDALONE"),
    parentBranchId: integer("parent_branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  // Annotated: this table and the composite keys reference each other in a
  // cycle (branches -> groups -> users -> branches) that inference cannot close.
  (t): PgTableExtraConfigValue[] => [
    index("branches_org_idx").on(t.organizationId),
    index("branches_name_idx").on(t.name),
    index("branches_cost_center_idx").on(t.costCenterId),
    uniqueIndex("branches_org_external_identity_uq")
      .on(t.organizationId, t.externalSource, t.externalId)
      .where(sql`${t.externalSource} IS NOT NULL AND ${t.externalId} IS NOT NULL`),
    index("branches_status_idx").on(t.status),
    index("branches_group_idx").on(t.groupId),
    // The warehouse city key; the expression must stay identical to
    // branchCityKeySql (lib/server/branch-city-key.ts) or the index is not used.
    // See plans/OF-WAREHOUSE-city-assignments.md.
    index("branches_city_key_idx").on(sql`lower(btrim(regexp_replace(${t.city}, '\\s+', ' ', 'g')))`),
    check("branches_region_ck", sql`${t.region} IS NULL OR ${t.region} IN ('NORTH', 'CENTRAL', 'SOUTH')`),
    // MAX_BRANCH_HEAD_COUNT in lib/branch-head-count.ts.
    check("branches_head_count_ck", sql`${t.headCount} IS NULL OR ${t.headCount} BETWEEN 0 AND 1000000`),
    index("branches_parent_idx").on(t.parentBranchId).where(sql`${t.parentBranchId} IS NOT NULL`),
    check("branches_hierarchy_role_ck", sql`${t.hierarchyRole} IN ('STANDALONE', 'PARENT', 'CHILD')`),
    check(
      "branches_hierarchy_parent_ck",
      sql`((${t.hierarchyRole} = 'CHILD') = (${t.parentBranchId} IS NOT NULL))
        AND (${t.parentBranchId} IS NULL OR ${t.parentBranchId} <> ${t.id})`,
    ),
    check(
      "branches_external_identity_pair_ck",
      sql`(${t.externalSource} IS NULL) = (${t.externalId} IS NULL)
        AND (${t.externalSource} IS NULL OR (btrim(${t.externalSource}) <> '' AND btrim(${t.externalId}) <> ''))`,
    ),
    // Composite target for the (branch_id, organization_id) foreign keys: every
    // *_branch_org_fk / *_group_org_fk makes the database refuse a row whose
    // branch or group belongs to another organization than the row says.
    // See plans/OF-DB-tenant-composite-foreign-keys.md.
    unique("branches_id_organization_uq").on(t.id, t.organizationId),
    // The migration writes ON DELETE SET NULL (group_id) — the column list, which
    // Drizzle cannot express, leaves organization_id alone. There was no key
    // here before, so deleting the parent must keep succeeding.
    foreignKey({
      name: "branches_group_org_fk",
      columns: [t.groupId, t.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }).onDelete("set null"),
    // A child's parent is in the child's own organization. NO ACTION: deleting
    // a parent that still has children is refused.
    foreignKey({
      name: "branches_parent_org_fk",
      columns: [t.parentBranchId, t.organizationId],
      foreignColumns: [t.id, t.organizationId],
    }),
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
    // The organization's order approval level this user holds (1 = highest),
    // or null. Assigned by Super Admin / Head Office only to a role that can
    // decide the organization's orders (`canHoldApprovalLevel` in
    // lib/order-approval-levels.ts); written only by
    // lib/server/user-approval-level.ts, user creation, and cleared by an
    // access change of role or organization.
    // See plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md.
    orderApprovalLevel: integer("order_approval_level"),
    // Recorded by the department sign-up (plans/OF-JOIN-department-signup-multi-user.md):
    // the initiator's department and IP extension, an approver's designation.
    // Descriptive only; nothing authorizes on them.
    department: varchar("department", { length: 80 }),
    designation: varchar("designation", { length: 80 }),
    ipExtension: varchar("ip_extension", { length: 16 }),
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
  // Annotated: this table and the composite keys reference each other in a
  // cycle (branches -> groups -> users -> branches) that inference cannot close.
  (t): PgTableExtraConfigValue[] => [
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
    // MAX_APPROVAL_LEVELS in lib/order-approval-levels.ts.
    check(
      "users_order_approval_level_ck",
      sql`${t.orderApprovalLevel} IS NULL OR ${t.orderApprovalLevel} BETWEEN 1 AND 10`,
    ),
    check(
      "users_external_identity_pair_ck",
      sql`(${t.externalSource} IS NULL) = (${t.externalId} IS NULL)
        AND (${t.externalSource} IS NULL OR (btrim(${t.externalSource}) <> '' AND btrim(${t.externalId}) <> ''))`,
    ),
    // The migration writes ON DELETE SET NULL (branch_id) — the column list, which
    // Drizzle cannot express, leaves organization_id alone. There was no key
    // here before, so deleting the parent must keep succeeding.
    foreignKey({
      name: "users_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }).onDelete("set null"),
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

/**
 * One short-lived, single-use self-service password reset.
 *
 * `subject_id` is deliberately a string without a foreign key: normal users
 * are UUIDs while Order Portal employee principals are `emp_<number>`. The
 * service resolves that subject against the correct account table before any
 * mutation. Neither the six-digit OTP nor the bearer reset token is stored;
 * both columns hold an HMAC-SHA256 digest bound to this challenge id.
 */
export const passwordResetChallenges = pgTable(
  "password_reset_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectType: varchar("subject_type", { length: 16 }).notNull(),
    subjectId: varchar("subject_id", { length: 128 }).notNull(),
    codeDigest: varchar("code_digest", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    resetTokenDigest: varchar("reset_token_digest", { length: 64 }),
    resetTokenExpiresAt: timestamp("reset_token_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("password_reset_challenges_subject_idx").on(t.subjectType, t.subjectId, t.createdAt),
    index("password_reset_challenges_expiry_idx").on(t.expiresAt),
    uniqueIndex("password_reset_challenges_active_subject_uq")
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.consumedAt} IS NULL`),
    check(
      "password_reset_challenges_subject_type_ck",
      sql`${t.subjectType} IN ('user', 'employee')`,
    ),
    check(
      "password_reset_challenges_attempts_ck",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= 5`,
    ),
    check(
      "password_reset_challenges_digest_shape_ck",
      sql`${t.codeDigest} ~ '^[0-9a-f]{64}$' AND (${t.resetTokenDigest} IS NULL OR ${t.resetTokenDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "password_reset_challenges_time_order_ck",
      sql`${t.createdAt} < ${t.expiresAt} AND (${t.resetTokenExpiresAt} IS NULL OR ${t.verifiedAt} <= ${t.resetTokenExpiresAt})`,
    ),
    check(
      "password_reset_challenges_verification_ck",
      sql`(${t.verifiedAt} IS NULL AND ${t.resetTokenDigest} IS NULL AND ${t.resetTokenExpiresAt} IS NULL)
        OR (${t.verifiedAt} IS NOT NULL AND ${t.resetTokenDigest} IS NOT NULL AND ${t.resetTokenExpiresAt} IS NOT NULL)`,
    ),
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
    foreignKey({
      name: "inventory_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "suppliers_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * The extra places a branch needs goods delivered to, and the queue that lets
 * one exist.
 *
 * A branch already has one address of its own — `branches.address` — and that
 * stays the default and is not copied here. A row in this table is an
 * *additional* destination: a yard, a site office, a second gate. Somebody
 * assigned to the branch raises it, Head Office approves it, and only an
 * approved row may be delivered to (`lib/delivery-address.ts`,
 * `lib/delivery-address-access.ts`).
 *
 * The request and the address are **one row**, not two tables. "The address
 * that was approved" and "the address this order used" are then the same id
 * and cannot drift apart.
 *
 * `label_key` is the normalized spelling of `label`, written by the server
 * through `deliveryAddressLabelKey`. Storing it lets the duplicate index below
 * be a plain column index rather than a functional one, exactly as
 * `organization_join_requests.email` is stored already lower-cased — and makes
 * a duplicate a database error rather than a race between two readers.
 */
export const branchDeliveryAddresses = pgTable(
  "branch_delivery_addresses",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    // What a person picks it by on the checkout selector.
    label: varchar("label", { length: 120 }).notNull(),
    labelKey: varchar("label_key", { length: 120 }).notNull(),
    address: text("address").notNull(),
    city: varchar("city", { length: 100 }),
    province: varchar("province", { length: 100 }),
    contactPerson: varchar("contact_person", { length: 255 }),
    contactPhone: varchar("contact_phone", { length: 32 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    // Why the branch says it needs another destination. Shown to the approver.
    requestReason: text("request_reason"),
    requestedByUserId: uuid("requested_by_user_id")
      .references(() => users.id)
      .notNull(),
    decisionReason: text("decision_reason"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("branch_delivery_addresses_branch_status_idx").on(t.branchId, t.status, t.createdAt),
    index("branch_delivery_addresses_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    index("branch_delivery_addresses_requested_by_idx").on(t.requestedByUserId),
    // One live address per name per branch. Partial, so a rejected label may be
    // requested again once whatever was wrong with it has been fixed, while a
    // second request for a name already pending or already approved is refused
    // by the database rather than by a check some future endpoint might skip.
    uniqueIndex("branch_delivery_addresses_live_label_uq")
      .on(t.branchId, t.labelKey)
      .where(sql`${t.status} IN ('pending', 'approved')`),
    check(
      "branch_delivery_addresses_status_ck",
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    // A pending row carries no decision; a decided one names its decider. No
    // endpoint can approve an address without recording who approved it.
    check(
      "branch_delivery_addresses_decision_ck",
      sql`CASE WHEN ${t.status} = 'pending'
            THEN ${t.decidedAt} IS NULL AND ${t.decidedByUserId} IS NULL
            ELSE ${t.decidedAt} IS NOT NULL AND ${t.decidedByUserId} IS NOT NULL
          END`,
    ),
    check(
      "branch_delivery_addresses_text_ck",
      sql`length(btrim(${t.label})) > 0 AND length(btrim(${t.labelKey})) > 0 AND length(btrim(${t.address})) > 0`,
    ),
    foreignKey({
      name: "branch_delivery_addresses_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * A branch asking Head Office to set its head count
 * (plans/OF-BRANCH-head-count.md).
 *
 * Raised by a Branch Admin or Group User, decided by Head Office alone; an
 * approval writes `branches.head_count` in the same transaction. Shaped like
 * `branch_delivery_addresses` so the codebase runs one kind of approval queue.
 *
 * `current_head_count` is what the branch held when the request was raised,
 * for the reviewer; `applied_previous_head_count` is what an approval actually
 * overwrote, which may differ if an administrator edited it in between.
 */
export const branchHeadCountRequests = pgTable(
  "branch_head_count_requests",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    requestedHeadCount: integer("requested_head_count").notNull(),
    currentHeadCount: integer("current_head_count"),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    requestReason: text("request_reason"),
    requestedByUserId: uuid("requested_by_user_id")
      .references(() => users.id)
      .notNull(),
    appliedPreviousHeadCount: integer("applied_previous_head_count"),
    decisionReason: text("decision_reason"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("branch_head_count_requests_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    index("branch_head_count_requests_branch_status_idx").on(t.branchId, t.status, t.createdAt),
    index("branch_head_count_requests_requested_by_idx").on(t.requestedByUserId),
    // One request awaiting a decision per branch. A second is refused by the
    // database, not by a read-then-write check two callers could race past.
    uniqueIndex("branch_head_count_requests_pending_uq")
      .on(t.branchId)
      .where(sql`${t.status} = 'pending'`),
    check(
      "branch_head_count_requests_status_ck",
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      "branch_head_count_requests_decision_ck",
      sql`CASE WHEN ${t.status} = 'pending'
            THEN ${t.decidedAt} IS NULL AND ${t.decidedByUserId} IS NULL
            ELSE ${t.decidedAt} IS NOT NULL AND ${t.decidedByUserId} IS NOT NULL
          END`,
    ),
    check(
      "branch_head_count_requests_count_ck",
      sql`${t.requestedHeadCount} BETWEEN 0 AND 1000000`,
    ),
    foreignKey({
      name: "branch_head_count_requests_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "budgets_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "payment_control_exceptions_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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

/**
 * An organization's order approval levels, in order. Each level approves one
 * band: orders equal to or above its `max_amount_cents` (the band's lower bound,
 * despite its name) and below the level before it; the lowest level also takes
 * every order below its own amount (`approvalLevelBands`). Every level's amount
 * is lower than the one before (`approvalLevelsError` in
 * lib/order-approval-levels.ts, enforced by the only writer,
 * lib/server/order-approval-levels.ts).
 *
 * Positional: levels are written 1..N with no gaps, and replaced as a whole
 * set. Kept while the feature is switched off, so switching it back on
 * restores them. Super Admin only.
 * See plans/OF-APPROVAL-LEVELS-organization-approval-levels.md.
 */
export const organizationApprovalLevels = pgTable(
  "organization_approval_levels",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    level: integer("level").notNull(),
    maxAmountCents: bigint("max_amount_cents", { mode: "number" }).notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("organization_approval_levels_org_level_uq").on(t.organizationId, t.level),
    // MAX_APPROVAL_LEVELS in lib/order-approval-levels.ts.
    check(
      "organization_approval_levels_level_ck",
      sql`${t.level} BETWEEN 1 AND 10`,
    ),
    // APPROVAL_LEVEL_MIN_AMOUNT_CENTS..APPROVAL_LEVEL_MAX_AMOUNT_CENTS.
    check(
      "organization_approval_levels_amount_ck",
      sql`${t.maxAmountCents} BETWEEN 1 AND 100000000000`,
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
    paymentStatus: varchar("payment_status", { length: 16 }).notNull().default("UNPAID"), // UNPAID/PAID — toggled by SUPER_ADMIN and FINANCE (plans/OF-FINANCE-finance-role.md)
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
    // Where this order is to be delivered, when the requester chose somewhere
    // other than the branch's own address.
    //
    // Nullable, and that is load-bearing: every order raised before this column
    // existed has none, and so does every order from a flow that does not offer
    // the selector. All of them mean "the branch's own address", which is
    // exactly what they already render. Nothing is backfilled.
    //
    // Only an approved row may be named here, checked inside the creation
    // transaction against (id, organization, branch, status) — see
    // `loadApprovedDeliveryAddress` in `lib/server/delivery-addresses.ts`.
    deliveryAddressId: integer("delivery_address_id").references(() => branchDeliveryAddresses.id),
    createdByUserId: uuid("created_by_user_id")
      .references(() => users.id)
      .notNull(),
    // The role the creator held **at the moment the order was raised**.
    //
    // A person's role can change; what they were when they ordered cannot.
    // Attribution reports key on the requester role, so reading it live from
    // `users`/`roles` lets a promotion retroactively add or remove historical
    // orders from a report. Same reasoning as `status_at_refund` below.
    //
    // Nullable: rows written before this column existed have none, and every
    // reader falls back to the live join for those (see
    // `lib/server/order-creator-role-sql.ts`) until the backfill has run.
    createdByRole: varchar("created_by_role", { length: 32 }),
    // Whether this order took a budget hold when it was created — fixed then,
    // from its organization's `budgets_enabled`. Every later ledger move keys on
    // this rather than on the organization's current setting, so switching
    // budgets on or off can never release or spend a hold the order did not
    // take. See `orderTakesBudget` in lib/organization-budget-policy.ts.
    budgetTracked: boolean("budget_tracked").notNull().default(true),
    // The approval level this order waits at, fixed when it is created and
    // moved only by an edit. Null on every order of an organization that does
    // not use approval levels, which means "decided exactly as today".
    // See plans/OF-APPROVAL-LEVELS-route-orders-by-level.md.
    approvalLevel: integer("approval_level"),
    // The Apricart warehouse this order was transferred to, whose operators
    // now pick, dispatch and deliver it. Null on every order nobody has
    // transferred, which means "worked by whoever serves its branch, as
    // before". Written only by `transferOrderWarehouse`.
    // See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
    fulfillmentWarehouseId: integer("fulfillment_warehouse_id").references(() => apricartWarehouses.id),
    // Where an Order Desk order came from — the customer's email, WhatsApp
    // message or call — so it can be traced back to its source. Required for a
    // desk order and null on every portal order (lib/order-desk-access.ts).
    intakeChannel: varchar("intake_channel", { length: 16 }),
    intakeReference: varchar("intake_reference", { length: 255 }),
    // The storage key of the screenshot of that message, if one was uploaded.
    // Private: served only through the desk's own route, never the public
    // product-image route. One order per screenshot.
    intakeAttachmentKey: varchar("intake_attachment_key", { length: 128 }),
    // An Order Desk order withdrawn before delivery: who, when and why. The
    // hold and stock it took were released in the same transaction.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => users.id),
    cancellationReason: text("cancellation_reason"),
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
    // The approver's open request for a correction, while one is open: who
    // sent the order back, when, and what to fix. The order stays PENDING —
    // its hold, quantity hold and stock reservation are untouched — and cannot
    // be approved until a requester resubmits it, which clears all three.
    // Every round, open or closed, is kept in `order_correction_requests`.
    // See plans/OF-ORDER-RETURN-for-correction.md.
    returnedForCorrectionAt: timestamp("returned_for_correction_at", { withTimezone: true }),
    returnedForCorrectionByUserId: uuid("returned_for_correction_by_user_id").references(() => users.id),
    correctionRequestNote: text("correction_request_note"),
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
      /** Absent until the tax invoice is issued at delivery (lib/invoice-policy.ts). */
      invoiceNumber?: string
      /** Buyer's purchase order reference as supplied when the order was placed. */
      poNumber?: string
      date: string
      buyerName: string
      buyerAddress: string
      /**
       * The approved delivery address this order was sent to, when it was sent
       * somewhere other than the branch's own address. Absent on every order
       * that used the branch default, which is every order placed before
       * delivery addresses existed.
       */
      deliveryAddressLabel?: string
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
    // Partial for the same reason: only an order sent somewhere other than its
    // branch's own address carries the column, so the index stays the size of
    // that choice rather than the size of the orders table. It exists so
    // "which orders went to this address" stays cheap when Head Office is
    // deciding whether an address is still needed.
    index("orders_delivery_address_idx")
      .on(t.deliveryAddressId)
      .where(sql`${t.deliveryAddressId} IS NOT NULL`),
    // Partial: only a transferred order carries the column.
    index("orders_fulfillment_warehouse_idx")
      .on(t.fulfillmentWarehouseId, t.status)
      .where(sql`${t.fulfillmentWarehouseId} IS NOT NULL`),
    uniqueIndex("orders_creator_idempotency_uq").on(t.createdByUserId, t.idempotencyKey),
    check("orders_amounts_nonnegative_ck", sql`${t.subtotalCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.totalCents} >= 0 AND COALESCE(${t.refundAmountCents}, 0) >= 0 AND COALESCE(${t.refundAmountCents}, 0) <= ${t.totalCents}`),
    check("orders_idempotency_pair_ck", sql`(${t.idempotencyKey} IS NULL AND ${t.requestFingerprint} IS NULL) OR (${t.idempotencyKey} IS NOT NULL AND ${t.requestFingerprint} IS NOT NULL)`),
    // MAX_APPROVAL_LEVELS in lib/order-approval-levels.ts.
    check("orders_approval_level_ck", sql`${t.approvalLevel} IS NULL OR ${t.approvalLevel} BETWEEN 1 AND 10`),
    check("orders_intake_channel_ck", sql`${t.intakeChannel} IS NULL OR ${t.intakeChannel} IN ('EMAIL', 'WHATSAPP', 'PHONE', 'OTHER')`),
    check(
      "orders_intake_attachment_key_ck",
      sql`${t.intakeAttachmentKey} IS NULL OR ${t.intakeAttachmentKey} ~ '^order-intake/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|gif|webp)$'`,
    ),
    uniqueIndex("orders_intake_attachment_key_uq")
      .on(t.intakeAttachmentKey)
      .where(sql`${t.intakeAttachmentKey} IS NOT NULL`),
    // An open correction request is all three columns or none, and only ever on
    // a PENDING order — so no path that moves the status can leave the flag
    // behind on an approved, rejected or cancelled order.
    check(
      "orders_correction_state_ck",
      sql`(${t.returnedForCorrectionAt} IS NULL AND ${t.returnedForCorrectionByUserId} IS NULL AND ${t.correctionRequestNote} IS NULL) OR (${t.returnedForCorrectionAt} IS NOT NULL AND ${t.returnedForCorrectionByUserId} IS NOT NULL AND ${t.correctionRequestNote} IS NOT NULL AND UPPER(${t.status}) = 'PENDING')`,
    ),
    // A group order's envelope is in the same organization as each of its orders.
    foreignKey({
      name: "orders_group_order_org_fk",
      columns: [t.groupOrderId, t.organizationId],
      foreignColumns: [groupOrders.id, groupOrders.organizationId],
    }),
    foreignKey({
      name: "orders_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
    // Composite target for the invoice ledger's (order_id, organization_id)
    // keys, as branches and groups have (plans/OF-INVOICE-invoice-ledger.md).
    unique("orders_id_organization_uq").on(t.id, t.organizationId),
  ],
)

/**
 * The delivery challan behind each order's "Delivered" — Super Admin's proof
 * of delivery. See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
 *
 * A row is created *unattached* when the file is uploaded, bound to its order
 * and its uploader, and is attached by the delivery itself (or by a
 * replacement), in the same transaction. One current challan per order; a
 * replaced one is kept. The object lives under the private `delivery-challan/`
 * prefix, which the public image route cannot serve.
 */
export const orderDeliveryChallans = pgTable(
  "order_delivery_challans",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    branchId: integer("branch_id").references(() => branches.id).notNull(),
    storageKey: varchar("storage_key", { length: 128 }).notNull(),
    // What the uploader's file was called, sanitised, for display only. It
    // never builds a key or a path.
    fileName: varchar("file_name", { length: 160 }).notNull(),
    contentType: varchar("content_type", { length: 32 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id).notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
    replacedByUserId: uuid("replaced_by_user_id").references(() => users.id),
  },
  (t) => [
    uniqueIndex("order_delivery_challans_storage_key_uq").on(t.storageKey),
    index("order_delivery_challans_order_idx").on(t.orderId, t.uploadedAt),
    uniqueIndex("order_delivery_challans_current_uq")
      .on(t.orderId)
      .where(sql`${t.attachedAt} IS NOT NULL AND ${t.replacedAt} IS NULL`),
    check(
      "order_delivery_challans_key_ck",
      sql`${t.storageKey} ~ '^delivery-challan/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp|pdf)$'`,
    ),
    check(
      "order_delivery_challans_type_ck",
      sql`${t.contentType} IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')`,
    ),
    check("order_delivery_challans_size_ck", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 4194304`),
    check(
      "order_delivery_challans_replace_ck",
      sql`(${t.replacedAt} IS NULL AND ${t.replacedByUserId} IS NULL) OR (${t.replacedAt} IS NOT NULL AND ${t.replacedByUserId} IS NOT NULL AND ${t.attachedAt} IS NOT NULL)`,
    ),
    foreignKey({
      name: "order_delivery_challans_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * Every round of "returned for correction" an order has been through.
 *
 * The open round is mirrored on the order row (`returned_for_correction_*`),
 * which is what every guard and list reads; this table is the history the
 * order detail renders. A round is opened by an approver and closed either by a
 * requester resubmitting the order or by the order being rejected. One open
 * round per order, enforced by the partial unique index.
 */
export const orderCorrectionRequests = pgTable(
  "order_correction_requests",
  {
    id: serial("id").primaryKey(),
    // Cascade, so the administrative order deletion removes the trail with it.
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id)
      .notNull(),
    requestedByUserId: uuid("requested_by_user_id")
      .references(() => users.id)
      .notNull(),
    requestedByRole: varchar("requested_by_role", { length: 32 }).notNull(),
    comment: text("comment").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    resolution: varchar("resolution", { length: 16 }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    resolvedByRole: varchar("resolved_by_role", { length: 32 }),
    responseNote: text("response_note"),
  },
  (t) => [
    index("order_correction_requests_order_idx").on(t.orderId, t.requestedAt),
    uniqueIndex("order_correction_requests_open_uq")
      .on(t.orderId)
      .where(sql`${t.resolution} IS NULL`),
    check(
      "order_correction_requests_resolution_ck",
      // CANCELLED: the Order Desk withdrew a returned desk order instead of
      // resubmitting it (plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('RESUBMITTED', 'REJECTED', 'CANCELLED')`,
    ),
    check(
      "order_correction_requests_shape_ck",
      sql`(${t.resolution} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.resolvedByUserId} IS NULL AND ${t.resolvedByRole} IS NULL AND ${t.responseNote} IS NULL) OR (${t.resolution} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL AND ${t.resolvedByUserId} IS NOT NULL AND ${t.resolvedByRole} IS NOT NULL)`,
    ),
    check(
      "order_correction_requests_text_ck",
      sql`char_length(btrim(${t.comment})) BETWEEN 1 AND 1000 AND (${t.responseNote} IS NULL OR char_length(${t.responseNote}) <= 1000)`,
    ),
    foreignKey({
      name: "order_correction_requests_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    // The Order Desk typed this line's price (plans/OF-ORDER-DESK-line-price-entry.md).
    // priceCents is then the entered figure, and cataloguePriceCents what the
    // price ladder said at that moment (null when it had none). Every other
    // line: false and null.
    priceEnteredManually: boolean("price_entered_manually").notNull().default(false),
    cataloguePriceCents: bigint("catalogue_price_cents", { mode: "number" }),
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
    check("order_items_manual_price_ck", sql`${t.cataloguePriceCents} IS NULL OR (${t.priceEnteredManually} AND ${t.cataloguePriceCents} >= 0)`),
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

/**
 * The invoice ledger (plans/OF-INVOICE-invoice-ledger.md).
 *
 * A tax invoice is issued when an order's delivery is recorded, numbered from
 * the organization's existing `invoice_sequences` series and dated that day in
 * Karachi; a refund approved against it issues a numbered credit note. Neither
 * document changes once written: database triggers refuse any update to an
 * invoice other than its credited totals and status, and any update or delete
 * of its lines, its credit notes or their lines.
 *
 * Invoices supplied before the ledger existed are copied in by
 * `npm run backfill:invoice-ledger` with their original number and printed
 * date (`origin` LEGACY_*); they keep printing from the order's own snapshot.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    branchId: integer("branch_id").notNull(),
    orderId: integer("order_id").notNull(),
    number: varchar("number", { length: 40 }).notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    origin: varchar("origin", { length: 24 }).notNull(),
    status: varchar("status", { length: 24 }).notNull().default("ISSUED"),
    seller: jsonb("seller").$type<Record<string, unknown>>().notNull(),
    buyer: jsonb("buyer").$type<Record<string, unknown>>().notNull(),
    participants: jsonb("participants").$type<Record<string, unknown>>().notNull().default({}),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    deliveryChargesCents: bigint("delivery_charges_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    creditedNetCents: bigint("credited_net_cents", { mode: "number" }).notNull().default(0),
    creditedTaxCents: bigint("credited_tax_cents", { mode: "number" }).notNull().default(0),
    creditedTotalCents: bigint("credited_total_cents", { mode: "number" }).notNull().default(0),
    // The order's `receipt_data` verbatim, for legacy rows only.
    legacySnapshot: jsonb("legacy_snapshot"),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id),
    // Set on rows the backfill wrote, so its rollback can find exactly them.
    backfillBatch: varchar("backfill_batch", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("invoices_order_uq").on(t.orderId),
    uniqueIndex("invoices_org_number_uq").on(t.organizationId, t.number),
    uniqueIndex("invoices_prefixed_number_uq")
      .on(t.number)
      .where(sql`${t.number} ~ '^[A-Z0-9_]+-APR-[0-9]{6}$'`),
    unique("invoices_id_organization_uq").on(t.id, t.organizationId),
    index("invoices_org_issue_date_idx").on(t.organizationId, t.issueDate),
    index("invoices_branch_idx").on(t.branchId),
    check("invoices_origin_ck", sql`${t.origin} IN ('ISSUED_AT_SUPPLY', 'LEGACY_SNAPSHOT', 'LEGACY_IMPORT')`),
    check("invoices_status_ck", sql`${t.status} IN ('ISSUED', 'PARTIALLY_CREDITED', 'CREDITED')`),
    check(
      "invoices_amounts_ck",
      sql`${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.discountCents} >= 0 AND ${t.deliveryChargesCents} >= 0 AND ${t.totalCents} >= 0`,
    ),
    // Issued invoices add up exactly; legacy rows keep the figures they were issued with.
    check(
      "invoices_arithmetic_ck",
      sql`${t.origin} <> 'ISSUED_AT_SUPPLY' OR ${t.netCents} + ${t.taxCents} + ${t.deliveryChargesCents} - ${t.discountCents} = ${t.totalCents}`,
    ),
    check(
      "invoices_credited_ck",
      sql`${t.creditedNetCents} >= 0 AND ${t.creditedTaxCents} >= 0 AND ${t.creditedTotalCents} >= 0 AND ${t.creditedTotalCents} <= ${t.totalCents}`,
    ),
    check("invoices_legacy_snapshot_ck", sql`(${t.origin} = 'ISSUED_AT_SUPPLY') = (${t.legacySnapshot} IS NULL)`),
    // Credit notes only ever add a reconciled (net, tax, total) to an invoice
    // (drizzle/20261016120000_invoice_ledger_credit_integrity.sql; the trigger
    // also refuses lowering a credited total).
    check("invoices_credited_split_ck", sql`${t.creditedNetCents} + ${t.creditedTaxCents} = ${t.creditedTotalCents}`),
    check("invoices_credited_tax_ck", sql`${t.creditedTaxCents} <= ${t.taxCents}`),
    check(
      "invoices_status_credited_ck",
      sql`${t.origin} <> 'ISSUED_AT_SUPPLY'
        OR (${t.status} = 'ISSUED' AND ${t.creditedTotalCents} = 0)
        OR (${t.status} = 'PARTIALLY_CREDITED' AND ${t.creditedTotalCents} > 0 AND ${t.creditedTotalCents} < ${t.totalCents})
        OR (${t.status} = 'CREDITED' AND ${t.creditedTotalCents} > 0 AND ${t.creditedTotalCents} = ${t.totalCents})`,
    ),
    foreignKey({
      name: "invoices_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
    foreignKey({
      name: "invoices_order_org_fk",
      columns: [t.orderId, t.organizationId],
      foreignColumns: [orders.id, orders.organizationId],
    }),
  ],
)

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id").notNull(),
    organizationId: integer("organization_id").notNull(),
    lineNo: integer("line_no").notNull(),
    orderItemId: integer("order_item_id").references(() => orderItems.id).notNull(),
    productName: varchar("product_name", { length: 255 }).notNull(),
    productCode: varchar("product_code", { length: 128 }),
    unit: varchar("unit", { length: 64 }).notNull(),
    category: varchar("category", { length: 255 }),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }).notNull(),
    // The tax-inclusive unit price the order was charged at.
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull(),
    taxRateBp: integer("tax_rate_bp"),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("invoice_lines_line_uq").on(t.invoiceId, t.lineNo),
    index("invoice_lines_order_item_idx").on(t.orderItemId),
    check("invoice_lines_line_no_ck", sql`${t.lineNo} > 0`),
    check(
      "invoice_lines_values_ck",
      sql`${t.quantity} > 0 AND ${t.unitPriceCents} >= 0 AND ${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.netCents} + ${t.taxCents} = ${t.grossCents}`,
    ),
    check("invoice_lines_tax_rate_ck", sql`${t.taxRateBp} IS NULL OR (${t.taxRateBp} >= 0 AND ${t.taxRateBp} <= 10000)`),
    foreignKey({
      name: "invoice_lines_invoice_org_fk",
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [invoices.id, invoices.organizationId],
    }),
  ],
)

export const creditNoteSequences = pgTable(
  "credit_note_sequences",
  {
    // ON DELETE CASCADE in the migration, as invoice_sequences.
    organizationId: integer("organization_id")
      .primaryKey()
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    lastValue: integer("last_value").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    check("credit_note_sequences_range_ck", sql`${t.lastValue} >= 0 AND ${t.lastValue} <= 999999`),
  ],
)

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id").references(() => organizations.id).notNull(),
    invoiceId: integer("invoice_id").notNull(),
    refundId: integer("refund_id").references(() => refunds.id).notNull(),
    number: varchar("number", { length: 40 }).notNull(),
    issueDate: date("issue_date", { mode: "string" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    reason: text("reason"),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    issuedByUserId: uuid("issued_by_user_id").references(() => users.id).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    // One credit note per approved refund: a retried approval cannot issue two.
    uniqueIndex("credit_notes_refund_uq").on(t.refundId),
    uniqueIndex("credit_notes_number_uq").on(t.number),
    unique("credit_notes_id_organization_uq").on(t.id, t.organizationId),
    index("credit_notes_invoice_idx").on(t.invoiceId),
    check("credit_notes_number_ck", sql`${t.number} ~ '^[A-Z0-9_]+-CN-[0-9]{6}$'`),
    check(
      "credit_notes_amounts_ck",
      sql`${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.totalCents} > 0 AND ${t.netCents} + ${t.taxCents} = ${t.totalCents}`,
    ),
    foreignKey({
      name: "credit_notes_invoice_org_fk",
      columns: [t.invoiceId, t.organizationId],
      foreignColumns: [invoices.id, invoices.organizationId],
    }),
  ],
)

export const creditNoteLines = pgTable(
  "credit_note_lines",
  {
    id: serial("id").primaryKey(),
    creditNoteId: integer("credit_note_id").notNull(),
    organizationId: integer("organization_id").notNull(),
    lineNo: integer("line_no").notNull(),
    // Null for an un-itemised adjustment, or a credit against a legacy invoice.
    invoiceLineId: integer("invoice_line_id").references(() => invoiceLines.id),
    orderItemId: integer("order_item_id").references(() => orderItems.id),
    description: varchar("description", { length: 255 }).notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3, mode: "number" }),
    taxRateBp: integer("tax_rate_bp"),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("credit_note_lines_line_uq").on(t.creditNoteId, t.lineNo),
    check("credit_note_lines_line_no_ck", sql`${t.lineNo} > 0`),
    check(
      "credit_note_lines_values_ck",
      sql`(${t.quantity} IS NULL OR ${t.quantity} > 0) AND ${t.netCents} >= 0 AND ${t.taxCents} >= 0 AND ${t.netCents} + ${t.taxCents} = ${t.grossCents}`,
    ),
    foreignKey({
      name: "credit_note_lines_credit_note_org_fk",
      columns: [t.creditNoteId, t.organizationId],
      foreignColumns: [creditNotes.id, creditNotes.organizationId],
    }),
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
    foreignKey({
      name: "branch_products_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "restock_requests_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "branch_inventory_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "group_inventory_prices_group_org_fk",
      columns: [t.groupId, t.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }),
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
    foreignKey({
      name: "product_quantity_budgets_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "product_quantity_budget_allocations_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "employee_credentials_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
  // Annotated: this table and the composite keys reference each other in a
  // cycle (branches -> groups -> users -> branches) that inference cannot close.
  (t): PgTableExtraConfigValue[] => [
    index("groups_org_idx").on(t.organizationId),
    index("groups_name_idx").on(t.name),
    index("groups_status_idx").on(t.status),
    // Composite target for the (group_id, organization_id) foreign keys.
    unique("groups_id_organization_uq").on(t.id, t.organizationId),
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
    foreignKey({
      name: "legacy_user_mappings_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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
    foreignKey({
      name: "user_group_assignments_group_org_fk",
      columns: [t.groupId, t.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }),
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
    foreignKey({
      name: "user_branch_assignments_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * What an Order Desk user may reach. A row with `branch_id` null grants every
 * branch of the organization; a row with a branch grants that branch alone.
 *
 * Deliberately a table of its own rather than rows in
 * `user_branch_assignments`: those feed the group roles' scope and reporting
 * (`resolveUsersScopedToBranches` reads every row regardless of role), and a
 * desk user must never appear there. Super Admin writes these rows; the reach
 * they grant is read through `lib/server/order-desk-scope.ts`, which also
 * requires the organization to be `managed_ordering`.
 */
export const orderDeskAssignments = pgTable(
  "order_desk_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: integer("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("order_desk_assignments_user_org_uq")
      .on(t.userId, t.organizationId)
      .where(sql`${t.branchId} IS NULL`),
    uniqueIndex("order_desk_assignments_user_branch_uq")
      .on(t.userId, t.branchId)
      .where(sql`${t.branchId} IS NOT NULL`),
    index("order_desk_assignments_user_idx").on(t.userId),
    index("order_desk_assignments_org_idx").on(t.organizationId),
    foreignKey({
      name: "order_desk_assignments_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * Which organizations an Apricart Executive approves Order Desk orders for.
 * One row per executive per organization; there is no branch grain.
 *
 * Super Admin writes these rows (`lib/server/apricart-executive-team.ts`); the
 * reach they grant is read through `lib/server/apricart-executive-scope.ts`
 * and, for a decision, re-read `FOR SHARE` inside the deciding transaction.
 * They govern approval only — the delivery dashboard reads every tenant.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */
export const apricartExecutiveAssignments = pgTable(
  "apricart_executive_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("apricart_executive_assignments_user_org_uq").on(t.userId, t.organizationId),
    index("apricart_executive_assignments_org_idx").on(t.organizationId),
  ],
)

/**
 * Which organizations a Finance user reads orders and reports for, and marks
 * orders Paid or Unpaid in. Super Admin writes these rows
 * (`lib/server/finance-scope.ts`); the reach is re-read on every request, and
 * an account with none reads nothing. See plans/OF-FINANCE-finance-role.md.
 */
export const financeOrganizationAssignments = pgTable(
  "finance_organization_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("finance_organization_assignments_user_org_uq").on(t.userId, t.organizationId),
    index("finance_organization_assignments_org_idx").on(t.organizationId),
  ],
)

/**
 * Which branches a Warehouse user picks, dispatches and delivers for. One row
 * per user per branch — there is deliberately no organization-wide row, and no
 * organization column: the organization is always the branch's own, read
 * through the join, so the two can never disagree.
 *
 * Super Admin writes these rows (`lib/server/warehouse-team.ts`); the reach
 * they grant is read through `lib/server/warehouse-scope.ts` and, for a write,
 * re-read `FOR SHARE` inside the writing transaction.
 * See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md.
 */
export const warehouseAssignments = pgTable(
  "warehouse_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("warehouse_assignments_user_branch_uq").on(t.userId, t.branchId),
    index("warehouse_assignments_branch_idx").on(t.branchId),
  ],
)

/**
 * Whole cities a Warehouse user serves: every branch whose normalised city
 * equals `city_key`, including branches opened in that city later. Stores the
 * key, never branch ids, so no write is needed when a branch is added.
 *
 * The key is only ever computed in SQL, by `branchCityKeySql`
 * (`lib/server/branch-city-key.ts`), on both sides of every comparison; the
 * `branches_city_key_idx` expression index serves the join. The reach is read
 * with the branch assignments above, through `lib/server/warehouse-scope.ts`.
 * See plans/OF-WAREHOUSE-city-assignments.md.
 */
export const warehouseCityAssignments = pgTable(
  "warehouse_city_assignments",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    cityKey: varchar("city_key", { length: 100 }).notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("warehouse_city_assignments_user_city_uq").on(t.userId, t.cityKey),
    index("warehouse_city_assignments_city_idx").on(t.cityKey),
    check("warehouse_city_assignments_city_key_ck", sql`btrim(${t.cityKey}) <> ''`),
  ],
)

/**
 * The organizations a Warehouse user's cities apply to. A city rule above
 * reaches a branch only when the branch's organization is listed here for the
 * same user — the two sets are intersected, and an empty set reaches nothing.
 * Every reader matches through `warehouseCityRuleJoin`
 * (`lib/server/warehouse-city-rule.ts`). Grants nothing on its own.
 * See plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */
export const warehouseCityOrganizations = pgTable(
  "warehouse_city_organizations",
  {
    id: serial("id").primaryKey(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("warehouse_city_organizations_user_org_uq").on(t.userId, t.organizationId),
    index("warehouse_city_organizations_org_idx").on(t.organizationId),
  ],
)

/**
 * Apricart's warehouses, as places rather than accounts: the stable owner an
 * order will be fulfilled by, which keeps existing when the people working it
 * are deactivated or replaced. Never deleted — made `INACTIVE` instead.
 *
 * An order Super Admin has transferred names one in
 * `orders.fulfillment_warehouse_id`, and is then worked by its operator
 * members only. Every other order is still worked through `loadWarehouseReach`
 * (branch reach), and routes are still configuration only.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */
export const apricartWarehouses = pgTable(
  "apricart_warehouses",
  {
    id: serial("id").primaryKey(),
    code: varchar("code", { length: 20 }).notNull(),
    name: varchar("name", { length: 150 }).notNull(),
    city: varchar("city", { length: 100 }),
    address: varchar("address", { length: 500 }),
    contactPhone: varchar("contact_phone", { length: 30 }),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("apricart_warehouses_code_uq").on(t.code),
    check("apricart_warehouses_status_ck", sql`${t.status} IN ('ACTIVE', 'INACTIVE')`),
  ],
)

/**
 * Who works at a warehouse: `WAREHOUSE_OPERATOR` for a `WAREHOUSE` account,
 * `EXECUTIVE` for an `APRICART_EXECUTIVE` account. The responsibility follows
 * the account's role, decided on the server (`lib/apricart-warehouses.ts`).
 * One person may belong to several warehouses.
 */
export const apricartWarehouseMemberships = pgTable(
  "apricart_warehouse_memberships",
  {
    id: serial("id").primaryKey(),
    warehouseId: integer("warehouse_id")
      .references(() => apricartWarehouses.id)
      .notNull(),
    userId: uuid("user_id")
      .references(() => users.id, { onDelete: "cascade" })
      .notNull(),
    responsibility: varchar("responsibility", { length: 30 }).notNull(),
    // Which of the warehouse's branches an operator works: ALL of them, or the
    // SELECTED ones in apricart_warehouse_member_branches. An executive is
    // always ALL. Read only while WAREHOUSE_ORDER_OWNERSHIP is not "branch"
    // (lib/warehouse-ownership-policy.ts). See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
    branchScope: varchar("branch_scope", { length: 16 }).notNull().default("ALL"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("apricart_warehouse_memberships_warehouse_user_uq").on(t.warehouseId, t.userId),
    index("apricart_warehouse_memberships_user_idx").on(t.userId),
    check(
      "apricart_warehouse_memberships_responsibility_ck",
      sql`${t.responsibility} IN ('WAREHOUSE_OPERATOR', 'EXECUTIVE')`,
    ),
    check(
      "apricart_warehouse_memberships_branch_scope_ck",
      sql`${t.branchScope} IN ('ALL', 'SELECTED') AND (${t.branchScope} = 'ALL' OR ${t.responsibility} = 'WAREHOUSE_OPERATOR')`,
    ),
  ],
)

/**
 * The branches a `SELECTED` operator works, each of which is in the
 * membership's warehouse when written. A branch that later leaves the
 * warehouse simply stops matching: the reach joins it to the branch's live
 * warehouse (`branchWarehouseSql`).
 */
export const apricartWarehouseMemberBranches = pgTable(
  "apricart_warehouse_member_branches",
  {
    id: serial("id").primaryKey(),
    membershipId: integer("membership_id")
      .references(() => apricartWarehouseMemberships.id, { onDelete: "cascade" })
      .notNull(),
    branchId: integer("branch_id")
      .references(() => branches.id, { onDelete: "cascade" })
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("apricart_warehouse_member_branches_uq").on(t.membershipId, t.branchId),
    index("apricart_warehouse_member_branches_branch_idx").on(t.branchId),
  ],
)

/**
 * Which warehouse a branch belongs to by rule: every branch of an
 * organization (`city_key` null), or every branch of an organization in one
 * city. Evaluated at read time by `branchWarehouseSql`
 * (`lib/server/branch-warehouse.ts`) and never copied into rows, so a branch
 * created or re-citied by any path is in its warehouse at once — exactly as a
 * warehouse user's city assignment works today. A manual route overrides a
 * rule. `city_key` is written only through `branchCityKeySql`.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
 */
export const warehouseRouteRules = pgTable(
  "warehouse_route_rules",
  {
    id: serial("id").primaryKey(),
    warehouseId: integer("warehouse_id")
      .references(() => apricartWarehouses.id)
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    cityKey: varchar("city_key", { length: 100 }),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One warehouse per organization, and per organization and city, so a
    // branch never matches two warehouses at the same precedence.
    uniqueIndex("warehouse_route_rules_org_uq").on(t.organizationId).where(sql`${t.cityKey} IS NULL`),
    uniqueIndex("warehouse_route_rules_org_city_uq").on(t.organizationId, t.cityKey).where(sql`${t.cityKey} IS NOT NULL`),
    index("warehouse_route_rules_warehouse_idx").on(t.warehouseId),
    check("warehouse_route_rules_city_key_ck", sql`${t.cityKey} IS NULL OR btrim(${t.cityKey}) <> ''`),
  ],
)

/**
 * A branch put in a warehouse by hand. Overrides any `warehouse_route_rules`
 * match. Read only while WAREHOUSE_ORDER_OWNERSHIP is not "branch".
 */
export const branchFulfillmentRoutes = pgTable(
  "branch_fulfillment_routes",
  {
    branchId: integer("branch_id")
      .primaryKey()
      .references(() => branches.id, { onDelete: "cascade" }),
    warehouseId: integer("warehouse_id")
      .references(() => apricartWarehouses.id)
      .notNull(),
    createdByUserId: uuid("created_by_user_id"),
    updatedByUserId: uuid("updated_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("branch_fulfillment_routes_warehouse_idx").on(t.warehouseId),
  ],
)

/**
 * Every time an order moved from one warehouse to another, oldest first.
 * `from_warehouse_id` / `to_warehouse_id` null means "whoever serves the
 * order's branch" — an order not yet transferred, or one handed back. Written
 * only by `transferOrderWarehouse`, in the transaction that moves the order,
 * beside its `ORDER_WAREHOUSE_TRANSFERRED` audit row; never updated.
 * See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */
export const orderWarehouseTransfers = pgTable(
  "order_warehouse_transfers",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .references(() => orders.id, { onDelete: "cascade" })
      .notNull(),
    fromWarehouseId: integer("from_warehouse_id").references(() => apricartWarehouses.id),
    toWarehouseId: integer("to_warehouse_id").references(() => apricartWarehouses.id),
    reason: varchar("reason", { length: 500 }).notNull(),
    // Null once that account is deleted; the audit row still names it.
    transferredByUserId: uuid("transferred_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("order_warehouse_transfers_order_idx").on(t.orderId, t.id),
    check(
      "order_warehouse_transfers_moves_ck",
      sql`${t.fromWarehouseId} IS DISTINCT FROM ${t.toWarehouseId}`,
    ),
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
    // Composite target for orders (group_order_id, organization_id).
    unique("group_orders_id_organization_uq").on(t.id, t.organizationId),
    foreignKey({
      name: "group_orders_group_org_fk",
      columns: [t.groupId, t.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }),
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
  (t) => [
    uniqueIndex("group_order_drafts_user_uq").on(t.userId),
    foreignKey({
      name: "group_order_drafts_group_org_fk",
      columns: [t.groupId, t.organizationId],
      foreignColumns: [groups.id, groups.organizationId],
    }),
  ],
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
    foreignKey({
      name: "support_threads_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
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

/**
 * The code an organization hands out so people can ask to join it.
 *
 * Deliberately a table of its own rather than a column on `organizations`:
 * `GET /api/v1/organizations` and `GET /api/v1/organizations/[id]` both select
 * the whole organization row and both admit BRANCH_ADMIN, GROUP_USER and
 * ORDER_PORTAL, so a column here would be handed to every employee in the
 * tenant on page load. Reaching this table goes through
 * `/api/v1/organizations/join-code`, which admits Head Office alone.
 *
 * One row per organization: the row's presence is what makes a tenant joinable,
 * and deleting it closes joining without disturbing anything else. The code is
 * stored as typed after `normalizeJoinCode` — upper case, no whitespace — so a
 * lookup is an exact index probe and one code cannot be recorded twice under
 * two spellings.
 */
export const organizationJoinCodes = pgTable(
  "organization_join_codes",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    code: varchar("code", { length: 64 }).notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("organization_join_codes_org_uq").on(t.organizationId),
    uniqueIndex("organization_join_codes_code_uq").on(t.code),
    // The floor on guessing work, held in the database as well as in
    // `lib/organization-join.ts`, so no future writer can shorten it.
    check(
      "organization_join_codes_code_shape_ck",
      sql`${t.code} ~ '^[A-Z0-9-]{8,32}$'`,
    ),
  ],
)

/**
 * Somebody asking to join an organization, from the public join form.
 *
 * This is not a user and never becomes one on its own. Head Office approves it,
 * and only then is a `users` row written — see `lib/server/organization-join.ts`.
 *
 * `password_hash` holds bcrypt output from the moment of submission; the
 * applicant's password is never persisted in any other form and cannot be read
 * back. The requested role is confined to `JOINABLE_ROLES` here as well as in
 * Zod, because a check constraint is the one layer a new endpoint cannot forget.
 */
/**
 * One emailed code proving that a join applicant receives mail at the address
 * they typed (plans/OF-JOIN-email-otp-verification.md). Modelled on
 * `password_reset_challenges`: only HMAC digests are stored — never the code,
 * the proof, or the address itself — and a resend consumes the live row, so
 * the partial unique index allows one per (organization, address).
 */
export const joinEmailVerifications = pgTable(
  "join_email_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    emailDigest: varchar("email_digest", { length: 64 }).notNull(),
    codeDigest: varchar("code_digest", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    proofDigest: varchar("proof_digest", { length: 64 }),
    proofExpiresAt: timestamp("proof_expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("join_email_verifications_subject_idx").on(t.organizationId, t.emailDigest, t.createdAt),
    index("join_email_verifications_expiry_idx").on(t.expiresAt),
    uniqueIndex("join_email_verifications_live_uq")
      .on(t.organizationId, t.emailDigest)
      .where(sql`${t.consumedAt} IS NULL`),
    check(
      "join_email_verifications_attempts_ck",
      sql`${t.attempts} >= 0 AND ${t.attempts} <= 5`,
    ),
    check(
      "join_email_verifications_digest_shape_ck",
      sql`${t.emailDigest} ~ '^[0-9a-f]{64}$' AND ${t.codeDigest} ~ '^[0-9a-f]{64}$' AND (${t.proofDigest} IS NULL OR ${t.proofDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "join_email_verifications_time_order_ck",
      sql`${t.createdAt} < ${t.expiresAt} AND (${t.proofExpiresAt} IS NULL OR ${t.verifiedAt} <= ${t.proofExpiresAt})`,
    ),
    check(
      "join_email_verifications_verification_ck",
      sql`(${t.verifiedAt} IS NULL AND ${t.proofDigest} IS NULL AND ${t.proofExpiresAt} IS NULL)
        OR (${t.verifiedAt} IS NOT NULL AND ${t.proofDigest} IS NOT NULL AND ${t.proofExpiresAt} IS NOT NULL)`,
    ),
  ],
)

export const organizationJoinRequests = pgTable(
  "organization_join_requests",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    requestedRole: varchar("requested_role", { length: 32 }).notNull(),
    // Single-branch roles only. A group role leaves this null and carries its
    // reach in the two id lists instead.
    requestedBranchId: integer("requested_branch_id").references(() => branches.id),
    requestedGroupIds: jsonb("requested_group_ids").$type<number[]>().notNull().default([]),
    requestedBranchIds: jsonb("requested_branch_ids").$type<number[]>().notNull().default([]),
    // 1 = the standard form; 2 = the department sign-up, used only by an
    // organization with order approval levels on. A version 2 request keeps its
    // branches, approvers and addresses in the three child tables below.
    // See plans/OF-JOIN-department-signup-multi-user.md.
    formVersion: integer("form_version").notNull().default(1),
    department: varchar("department", { length: 80 }),
    ipExtension: varchar("ip_extension", { length: 16 }),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
    // The level bands shown to the applicant, for the review only. Never read
    // by order routing.
    approvalLevelsSnapshot: jsonb("approval_levels_snapshot")
      .$type<Array<{ level: number; fromCents: number | null; belowCents: number | null }>>(),
    firstName: varchar("first_name", { length: 100 }).notNull(),
    lastName: varchar("last_name", { length: 100 }).notNull(),
    // Stored already lower-cased by `normalizeEmail`, which is what lets the
    // pending-duplicate index below be a plain column index.
    email: varchar("email", { length: 255 }).notNull(),
    username: varchar("username", { length: 255 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    employeeId: varchar("employee_id", { length: 64 }),
    imprestHolder: varchar("imprest_holder", { length: 255 }),
    contactPerson: varchar("contact_person", { length: 255 }),
    location: varchar("location", { length: 255 }),
    address: text("address"),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    decisionReason: text("decision_reason"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdUserId: uuid("created_user_id").references(() => users.id),
    // Kept for abuse investigation on a public endpoint. Never rendered.
    submittedIp: varchar("submitted_ip", { length: 64 }),
    submittedUserAgent: varchar("submitted_user_agent", { length: 512 }),
    // When the applicant proved the address by a code sent to it
    // (plans/OF-JOIN-email-otp-verification.md). Null on requests made before
    // that step existed, and cleared when Head Office edits the address.
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("organization_join_requests_org_status_idx").on(t.organizationId, t.status, t.createdAt),
    index("organization_join_requests_created_user_idx").on(t.createdUserId),
    // One pending request per identity **per tenant**. Partial, so a rejected
    // applicant may reapply, and an approved one leaves the identity to the
    // `users` indexes and to `assertUniqueUserFields`.
    //
    // Keyed on the organization deliberately. A global index here would let a
    // pending request in one tenant block the same person from applying to a
    // different tenant — a cross-tenant channel neither tenant can see or
    // clear, reachable by anyone holding one tenant's join code. Two tenants may
    // therefore each queue the same person; whichever approves first creates the
    // account, and the other approval is refused with a 409 because
    // `assertUniqueUserFields` and the `users` unique indexes remain
    // application-wide.
    uniqueIndex("organization_join_requests_pending_email_uq")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex("organization_join_requests_pending_username_uq")
      .on(t.organizationId, t.username)
      .where(sql`${t.status} = 'pending'`),
    check(
      "organization_join_requests_status_ck",
      sql`${t.status} IN ('pending', 'approved', 'rejected')`,
    ),
    // The four roles the public form may ask for. HEAD_OFFICE and SUPER_ADMIN
    // are unreachable from this table by construction.
    check(
      "organization_join_requests_role_ck",
      sql`${t.requestedRole} IN ('BRANCH_ADMIN', 'ORDER_PORTAL', 'GROUP_USER', 'GROUP_ORDER_PORTAL')`,
    ),
    // A single-branch role names one branch and no lists; a group role names at
    // least one group or branch and no single branch. The same rule as
    // `joinRequestScopeShapeError`, held where it cannot be bypassed.
    //
    // A version 2 request names its branches in organization_join_request_branches
    // (a CRC to create has no id yet), so it is held only to the two roles the
    // department sign-up grants and to no groups.
    check(
      "organization_join_requests_scope_shape_ck",
      sql`CASE WHEN ${t.formVersion} = 2
            THEN ${t.requestedRole} IN ('ORDER_PORTAL', 'GROUP_ORDER_PORTAL')
              AND jsonb_array_length(${t.requestedGroupIds}) = 0
          WHEN ${t.requestedRole} IN ('BRANCH_ADMIN', 'ORDER_PORTAL')
            THEN ${t.requestedBranchId} IS NOT NULL
              AND jsonb_array_length(${t.requestedGroupIds}) = 0
              AND jsonb_array_length(${t.requestedBranchIds}) = 0
            ELSE ${t.requestedBranchId} IS NULL
              AND jsonb_array_length(${t.requestedGroupIds}) + jsonb_array_length(${t.requestedBranchIds}) > 0
          END`,
    ),
    // A pending request carries no decision, and a decided one carries both a
    // decider and a time. An approved request also names the user it created.
    check(
      "organization_join_requests_decision_ck",
      sql`CASE WHEN ${t.status} = 'pending'
            THEN ${t.decidedAt} IS NULL AND ${t.decidedByUserId} IS NULL AND ${t.createdUserId} IS NULL
            ELSE ${t.decidedAt} IS NOT NULL AND ${t.decidedByUserId} IS NOT NULL
          END`,
    ),
    check(
      "organization_join_requests_approved_user_ck",
      sql`${t.status} <> 'approved' OR ${t.createdUserId} IS NOT NULL`,
    ),
    check("organization_join_requests_form_version_ck", sql`${t.formVersion} IN (1, 2)`),
  ],
)

/**
 * A department sign-up's branches: each is an existing branch, or a CRC (cost
 * centre) to be created at approval. `resolved_branch_id` records the branch
 * the CRC became. See plans/OF-JOIN-department-signup-multi-user.md.
 */
export const organizationJoinRequestBranches = pgTable(
  "organization_join_request_branches",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .references(() => organizationJoinRequests.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    existingBranchId: integer("existing_branch_id"),
    // Upper-cased and trimmed by `normalizeCrc`.
    costCenterId: varchar("cost_center_id", { length: 64 }),
    // The name the applicant gave a branch to be created; null for an existing
    // branch and for a request submitted before names were asked for.
    requestedBranchName: varchar("requested_branch_name", { length: 100 }),
    // The city the applicant says a branch to be created is in, in the
    // spelling of lib/pakistan-cities.ts, and that city's province; both null
    // for an existing branch and for a request submitted before they were
    // asked for (plans/OF-JOIN-applicant-new-branch-city.md).
    requestedBranchCity: varchar("requested_branch_city", { length: 100 }),
    requestedBranchProvince: varchar("requested_branch_province", { length: 100 }),
    // The type the applicant proposes for a branch to be created — STANDALONE,
    // PARENT or CHILD — and a child's parent: an existing branch of this
    // organization, or the CRC of another branch to be created on this request.
    // All null for an existing branch and for a request submitted before the
    // type was asked for (plans/OF-JOIN-new-branch-parent-child.md).
    requestedHierarchyRole: varchar("requested_hierarchy_role", { length: 16 }),
    requestedParentBranchId: integer("requested_parent_branch_id"),
    requestedParentCrc: varchar("requested_parent_crc", { length: 64 }),
    resolvedBranchId: integer("resolved_branch_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    index("organization_join_request_branches_request_idx").on(t.requestId),
    uniqueIndex("organization_join_request_branches_existing_uq").on(t.requestId, t.existingBranchId),
    uniqueIndex("organization_join_request_branches_crc_uq").on(t.requestId, t.costCenterId),
    check(
      "organization_join_request_branches_shape_ck",
      sql`(${t.existingBranchId} IS NULL) <> (${t.costCenterId} IS NULL)
        AND (${t.costCenterId} IS NULL OR length(btrim(${t.costCenterId})) > 0)`,
    ),
    check(
      "organization_join_request_branches_name_ck",
      sql`${t.requestedBranchName} IS NULL
        OR (${t.costCenterId} IS NOT NULL AND length(btrim(${t.requestedBranchName})) > 0)`,
    ),
    check(
      "organization_join_request_branches_location_ck",
      // Both halves named NOT NULL: length(btrim(NULL)) is NULL, which a CHECK accepts.
      sql`(${t.requestedBranchCity} IS NULL AND ${t.requestedBranchProvince} IS NULL)
        OR (${t.costCenterId} IS NOT NULL
          AND ${t.requestedBranchCity} IS NOT NULL
          AND ${t.requestedBranchProvince} IS NOT NULL
          AND length(btrim(${t.requestedBranchCity})) > 0
          AND length(btrim(${t.requestedBranchProvince})) > 0)`,
    ),
    check(
      "organization_join_request_branches_hierarchy_ck",
      // A type only on a branch to be created; a child names exactly one
      // parent and nothing else names one; a parent CRC is never the row's own.
      sql`(${t.requestedHierarchyRole} IS NULL
          AND ${t.requestedParentBranchId} IS NULL
          AND ${t.requestedParentCrc} IS NULL)
        OR (${t.costCenterId} IS NOT NULL
          AND ${t.requestedHierarchyRole} IN ('STANDALONE', 'PARENT', 'CHILD')
          AND (${t.requestedHierarchyRole} = 'CHILD')
            = ((${t.requestedParentBranchId} IS NOT NULL) <> (${t.requestedParentCrc} IS NOT NULL))
          AND (${t.requestedHierarchyRole} = 'CHILD'
            OR (${t.requestedParentBranchId} IS NULL AND ${t.requestedParentCrc} IS NULL))
          AND (${t.requestedParentCrc} IS NULL OR ${t.requestedParentCrc} <> ${t.costCenterId}))`,
    ),
    foreignKey({
      name: "organization_join_request_branches_parent_org_fk",
      columns: [t.requestedParentBranchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
    foreignKey({
      name: "organization_join_request_branches_branch_org_fk",
      columns: [t.existingBranchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
    foreignKey({
      name: "organization_join_request_branches_resolved_org_fk",
      columns: [t.resolvedBranchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * A department sign-up's financial approver per level, and what the approval
 * did with each one (`resolution`, see `planApproverResolution`).
 */
export const organizationJoinRequestApprovers = pgTable(
  "organization_join_request_approvers",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .references(() => organizationJoinRequests.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    level: integer("level").notNull(),
    // Lower-cased by `normalizeEmail`.
    email: varchar("email", { length: 255 }).notNull(),
    designation: varchar("designation", { length: 80 }).notNull(),
    resolution: varchar("resolution", { length: 16 }),
    approverUserId: uuid("approver_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("organization_join_request_approvers_level_uq").on(t.requestId, t.level),
    uniqueIndex("organization_join_request_approvers_email_uq").on(t.requestId, t.email),
    // MAX_APPROVAL_LEVELS in lib/order-approval-levels.ts.
    check("organization_join_request_approvers_level_ck", sql`${t.level} BETWEEN 1 AND 10`),
    check(
      "organization_join_request_approvers_resolution_ck",
      sql`${t.resolution} IS NULL OR ${t.resolution} IN ('created', 'assigned', 'extended', 'covered', 'not_applied')`,
    ),
  ],
)

/**
 * A department sign-up's delivery addresses. The branch is Head Office's to
 * assign at approval, when the address is written to branch_delivery_addresses.
 */
export const organizationJoinRequestAddresses = pgTable(
  "organization_join_request_addresses",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id")
      .references(() => organizationJoinRequests.id, { onDelete: "cascade" })
      .notNull(),
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    address: varchar("address", { length: 200 }).notNull(),
    branchId: integer("branch_id"),
    deliveryAddressId: integer("delivery_address_id").references(() => branchDeliveryAddresses.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t): PgTableExtraConfigValue[] => [
    index("organization_join_request_addresses_request_idx").on(t.requestId),
    check("organization_join_request_addresses_text_ck", sql`length(btrim(${t.address})) > 0`),
    foreignKey({
      name: "organization_join_request_addresses_branch_org_fk",
      columns: [t.branchId, t.organizationId],
      foreignColumns: [branches.id, branches.organizationId],
    }),
  ],
)

/**
 * A Head Office request for a product the catalogue does not carry, and Super
 * Admin's decision on it. Information only: approving one creates no product
 * and sets no price — see `lib/product-request.ts` and
 * `plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`.
 *
 * Every descriptive column is nullable because every field on the form is
 * optional; the route refuses a request with nothing in it at all.
 */
export const productRequests = pgTable(
  "product_requests",
  {
    id: serial("id").primaryKey(),
    // The requester's tenant, read from their user row on the server.
    organizationId: integer("organization_id")
      .references(() => organizations.id)
      .notNull(),
    requestedByUserId: uuid("requested_by_user_id")
      .references(() => users.id)
      .notNull(),
    status: varchar("status", { length: 32 }).notNull().default("PENDING"),
    productName: varchar("product_name", { length: 255 }),
    brand: varchar("brand", { length: 255 }),
    description: text("description"),
    // Nulled rather than cascaded, so a request outlives a category being
    // removed: it is the record of what was asked.
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    subcategoryId: integer("subcategory_id").references(() => categories.id, { onDelete: "set null" }),
    unit: varchar("unit", { length: 64 }),
    packSize: varchar("pack_size", { length: 128 }),
    barcode: varchar("barcode", { length: 64 }),
    // What Head Office expects to pay, for Super Admin's information. Nothing
    // in the price ladder reads it.
    expectedPriceCents: integer("expected_price_cents"),
    estimatedMonthlyQuantity: numeric("estimated_monthly_quantity", { precision: 12, scale: 3, mode: "number" }),
    preferredSupplier: varchar("preferred_supplier", { length: 255 }),
    referenceUrl: text("reference_url"),
    notes: text("notes"),
    // A stored image path from `POST /api/v1/upload/image`, never a `data:`
    // URL or an external address.
    imageUrl: text("image_url"),
    // Set when Super Admin marks the request under review, and kept once it is
    // decided so the timeline can show when review began.
    reviewStartedByUserId: uuid("review_started_by_user_id").references(() => users.id),
    reviewStartedAt: timestamp("review_started_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // The day Super Admin expects the product in the catalogue. Required by the
    // API on every approval; null on approvals made before it existed.
    estimatedAvailableOn: date("estimated_available_on", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("product_requests_org_created_idx").on(t.organizationId, t.createdAt),
    index("product_requests_status_created_idx").on(t.status, t.createdAt),
    index("product_requests_requester_idx").on(t.requestedByUserId),
    check("product_requests_status_ck", sql`${t.status} IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')`),
    check(
      "product_requests_values_valid_ck",
      sql`COALESCE(${t.expectedPriceCents}, 0) >= 0 AND COALESCE(${t.estimatedMonthlyQuantity}, 0) >= 0`,
    ),
    check(
      "product_requests_image_path_ck",
      sql`${t.imageUrl} IS NULL OR ${t.imageUrl} LIKE '/api/v1/images/products/%'`,
    ),
    // An undecided request carries no decision; a decided one names who and when.
    check(
      "product_requests_review_ck",
      sql`CASE WHEN ${t.status} IN ('PENDING', 'UNDER_REVIEW')
            THEN ${t.reviewedAt} IS NULL AND ${t.reviewedByUserId} IS NULL AND ${t.reviewNote} IS NULL
            ELSE ${t.reviewedAt} IS NOT NULL AND ${t.reviewedByUserId} IS NOT NULL
          END`,
    ),
    // Under review names who started it and when; pending has neither; a
    // decided request keeps both or never had them.
    check(
      "product_requests_review_start_ck",
      sql`CASE ${t.status}
            WHEN 'PENDING' THEN ${t.reviewStartedAt} IS NULL AND ${t.reviewStartedByUserId} IS NULL
            WHEN 'UNDER_REVIEW' THEN ${t.reviewStartedAt} IS NOT NULL AND ${t.reviewStartedByUserId} IS NOT NULL
            ELSE (${t.reviewStartedAt} IS NULL) = (${t.reviewStartedByUserId} IS NULL)
          END`,
    ),
    // Only an approval promises a date.
    check(
      "product_requests_availability_ck",
      sql`${t.estimatedAvailableOn} IS NULL OR ${t.status} = 'APPROVED'`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Rider delivery (plans/OF-RIDER-DELIVERY-backend.md) — new tables only
// ---------------------------------------------------------------------------

export const riderProfiles = pgTable(
  "rider_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    code: varchar("code", { length: 32 }).notNull(),
    phone: varchar("phone", { length: 32 }),
    vehicleNumber: varchar("vehicle_number", { length: 64 }),
    isOnDuty: boolean("is_on_duty").notNull().default(false),
    avatarUrl: text("avatar_url"),
    // Serving city — links the rider to the one warehouse depot for that city.
    cityKey: varchar("city_key", { length: 120 }),
    cityLabel: varchar("city_label", { length: 120 }),
    warehouseUserId: uuid("warehouse_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_profiles_code_uq").on(t.code),
    index("rider_profiles_warehouse_user_idx").on(t.warehouseUserId),
    index("rider_profiles_city_key_idx").on(t.cityKey),
  ],
)

export const riderDepots = pgTable(
  "rider_depots",
  {
    id: serial("id").primaryKey(),
    warehouseUserId: uuid("warehouse_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull().default("Warehouse"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    address: text("address"),
    // One warehouse start pin per city (partial unique index in migration).
    cityKey: varchar("city_key", { length: 120 }),
    cityLabel: varchar("city_label", { length: 120 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_depots_warehouse_user_uq").on(t.warehouseUserId),
    uniqueIndex("rider_depots_city_key_uq")
      .on(t.cityKey)
      .where(sql`${t.cityKey} IS NOT NULL`),
    check("rider_depots_lat_ck", sql`${t.latitude} >= -90 AND ${t.latitude} <= 90`),
    check("rider_depots_lng_ck", sql`${t.longitude} >= -180 AND ${t.longitude} <= 180`),
  ],
)

/** Delivery-leg statuses for rider_order_assignments (not orders.fulfillment_status). */
export const RIDER_ASSIGNMENT_STATUSES = [
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "POD_SUBMITTED",
  "POD_REJECTED",
  "POD_APPROVED",
  "FULFILLMENT_PENDING",
  "FULFILLMENT_COMPLETED",
] as const

export type RiderAssignmentStatus = (typeof RIDER_ASSIGNMENT_STATUSES)[number]

export const riderOrderAssignments = pgTable(
  "rider_order_assignments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    riderUserId: uuid("rider_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    assignedByUserId: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    deliverySequence: integer("delivery_sequence").notNull(),
    deliveryLat: doublePrecision("delivery_lat").notNull(),
    deliveryLng: doublePrecision("delivery_lng").notNull(),
    deliveryAddressText: text("delivery_address_text"),
    status: varchar("status", { length: 32 }).notNull().default("ASSIGNED"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    outForDeliveryAt: timestamp("out_for_delivery_at", { withTimezone: true }),
    podSubmittedAt: timestamp("pod_submitted_at", { withTimezone: true }),
    podApprovedAt: timestamp("pod_approved_at", { withTimezone: true }),
    podRejectedAt: timestamp("pod_rejected_at", { withTimezone: true }),
    podRejectReason: text("pod_reject_reason"),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    arrivalLat: doublePrecision("arrival_lat"),
    arrivalLng: doublePrecision("arrival_lng"),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_order_assignments_open_order_uq")
      .on(t.orderId)
      .where(sql`${t.status} <> 'FULFILLMENT_COMPLETED'`),
    index("rider_order_assignments_rider_status_idx").on(t.riderUserId, t.status),
    index("rider_order_assignments_rider_seq_idx").on(t.riderUserId, t.deliverySequence),
    check(
      "rider_order_assignments_status_ck",
      sql`${t.status} IN ('ASSIGNED', 'OUT_FOR_DELIVERY', 'POD_SUBMITTED', 'POD_REJECTED', 'POD_APPROVED', 'FULFILLMENT_PENDING', 'FULFILLMENT_COMPLETED')`,
    ),
    check("rider_order_assignments_seq_ck", sql`${t.deliverySequence} >= 1`),
    check("rider_order_assignments_lat_ck", sql`${t.deliveryLat} >= -90 AND ${t.deliveryLat} <= 90`),
    check("rider_order_assignments_lng_ck", sql`${t.deliveryLng} >= -180 AND ${t.deliveryLng} <= 180`),
  ],
)

export const riderPodImages = pgTable(
  "rider_pod_images",
  {
    id: serial("id").primaryKey(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => riderOrderAssignments.id, { onDelete: "cascade" }),
    storageKey: varchar("storage_key", { length: 256 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedByUserId: uuid("uploaded_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("rider_pod_images_assignment_idx").on(t.assignmentId),
    uniqueIndex("rider_pod_images_storage_key_uq").on(t.storageKey),
    check("rider_pod_images_size_ck", sql`${t.sizeBytes} > 0 AND ${t.sizeBytes} <= 5242880`),
    check(
      "rider_pod_images_key_ck",
      sql`(${t.storageKey} LIKE 'proof-of-delivery/%' OR ${t.storageKey} LIKE 'rider-pod/%')`,
    ),
  ],
)

export const riderLocationEvents = pgTable(
  "rider_location_events",
  {
    id: serial("id").primaryKey(),
    riderUserId: uuid("rider_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignmentId: integer("assignment_id").references(() => riderOrderAssignments.id, {
      onDelete: "set null",
    }),
    kind: varchar("kind", { length: 32 }).notNull().default("ARRIVAL"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
    distanceMeters: doublePrecision("distance_meters"),
  },
  (t) => [
    index("rider_location_events_rider_recorded_idx").on(t.riderUserId, t.recordedAt),
    check("rider_location_events_kind_ck", sql`${t.kind} IN ('ARRIVAL', 'SAMPLE')`),
    check("rider_location_events_lat_ck", sql`${t.latitude} >= -90 AND ${t.latitude} <= 90`),
    check("rider_location_events_lng_ck", sql`${t.longitude} >= -180 AND ${t.longitude} <= 180`),
  ],
)

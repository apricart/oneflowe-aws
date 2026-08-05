import { pgTable, index, uniqueIndex, foreignKey, serial, integer, uuid, boolean, timestamp, text, jsonb, varchar, bigint, unique } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const branchInventory = pgTable("branch_inventory", {
	id: serial().primaryKey().notNull(),
	branchId: integer("branch_id").notNull(),
	organizationId: integer("organization_id").notNull(),
	organizationInventoryId: integer("organization_inventory_id").notNull(),
	assignedByUserId: uuid("assigned_by_user_id").notNull(),
	isVisible: boolean("is_visible").default(true).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("branch_inventory_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	index("branch_inventory_assigned_by_idx").using("btree", table.assignedByUserId.asc().nullsLast().op("uuid_ops")),
	index("branch_inventory_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("branch_inventory_branch_org_inventory_uq").using("btree", table.branchId.asc().nullsLast().op("int4_ops"), table.organizationInventoryId.asc().nullsLast().op("int4_ops")),
	index("branch_inventory_deleted_at_idx").using("btree", table.deletedAt.asc().nullsLast().op("timestamptz_ops")),
	index("branch_inventory_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("branch_inventory_org_inventory_idx").using("btree", table.organizationInventoryId.asc().nullsLast().op("int4_ops")),
	index("branch_inventory_status_idx").using("btree", table.branchId.asc().nullsLast().op("bool_ops"), table.isVisible.asc().nullsLast().op("int4_ops"), table.isActive.asc().nullsLast().op("bool_ops")),
	index("branch_inventory_visible_idx").using("btree", table.isVisible.asc().nullsLast().op("bool_ops")),
	foreignKey({
			columns: [table.assignedByUserId],
			foreignColumns: [users.id],
			name: "branch_inventory_assigned_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "branch_inventory_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "branch_inventory_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.organizationInventoryId],
			foreignColumns: [organizationInventory.id],
			name: "branch_inventory_organization_inventory_id_organization_invento"
		}).onDelete("cascade"),
]);

export const branchProducts = pgTable("branch_products", {
	id: serial().primaryKey().notNull(),
	branchId: integer("branch_id").notNull(),
	organizationId: integer("organization_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	organizationProductId: integer("organization_product_id"),
	isVisible: boolean("is_visible").default(true).notNull(),
	isAvailable: boolean("is_available").default(true).notNull(),
	customNotes: text("custom_notes"),
	metadata: jsonb().default({}),
	updatedByUserId: uuid("updated_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("branch_products_available_idx").using("btree", table.isAvailable.asc().nullsLast().op("bool_ops")),
	index("branch_products_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("branch_products_branch_product_uq").using("btree", table.branchId.asc().nullsLast().op("int4_ops"), table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("branch_products_global_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("branch_products_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("branch_products_org_product_idx").using("btree", table.organizationProductId.asc().nullsLast().op("int4_ops")),
	index("branch_products_visible_idx").using("btree", table.isVisible.asc().nullsLast().op("bool_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "branch_products_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "branch_products_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "branch_products_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.organizationProductId],
			foreignColumns: [organizationProducts.id],
			name: "branch_products_organization_product_id_organization_products_i"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "branch_products_updated_by_user_id_users_id_fk"
		}),
]);

export const categories = pgTable("categories", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	name: varchar({ length: 255 }).notNull(),
	parentId: integer("parent_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("categories_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("categories_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "categories_organization_id_organizations_id_fk"
		}),
]);

export const inventory = pgTable("inventory", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id").notNull(),
	skuId: integer("sku_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("inventory_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("inventory_branch_sku_uq").using("btree", table.branchId.asc().nullsLast().op("int4_ops"), table.skuId.asc().nullsLast().op("int4_ops")),
	index("inventory_org_branch_sku_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.branchId.asc().nullsLast().op("int4_ops"), table.skuId.asc().nullsLast().op("int4_ops")),
	index("inventory_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "inventory_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "inventory_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.skuId],
			foreignColumns: [skus.id],
			name: "inventory_sku_id_skus_id_fk"
		}),
]);

export const headOffices = pgTable("head_offices", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	contactEmail: varchar("contact_email", { length: 255 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("head_offices_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "head_offices_organization_id_organizations_id_fk"
		}),
]);

export const employeeCredentials = pgTable("employee_credentials", {
	id: serial().primaryKey().notNull(),
	branchId: integer("branch_id").notNull(),
	organizationId: integer("organization_id").notNull(),
	email: varchar({ length: 255 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }).notNull(),
	firstName: varchar("first_name", { length: 128 }),
	lastName: varchar("last_name", { length: 128 }),
	mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
	mfaSecret: varchar("mfa_secret", { length: 255 }),
	isActive: boolean("is_active").default(true).notNull(),
	createdByUserId: uuid("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	deactivatedAt: timestamp("deactivated_at", { withTimezone: true, mode: 'string' }),
	sessionVersion: integer("session_version").default(1).notNull(),
	username: varchar({ length: 255 }),
}, (table) => [
	index("employee_creds_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	index("employee_creds_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("employee_creds_created_by_idx").using("btree", table.createdByUserId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("employee_creds_email_uq").using("btree", table.email.asc().nullsLast().op("text_ops")),
	index("employee_creds_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("employee_creds_username_uq").using("btree", table.username.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "employee_credentials_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "employee_credentials_created_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "employee_credentials_organization_id_organizations_id_fk"
		}),
]);

export const mfaCodes = pgTable("mfa_codes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	code: varchar({ length: 6 }).notNull(),
	type: varchar({ length: 20 }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	attempts: integer().default(0).notNull(),
	isUsed: boolean("is_used").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("mfa_codes_code_idx").using("btree", table.code.asc().nullsLast().op("text_ops")),
	index("mfa_codes_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("mfa_codes_type_idx").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("mfa_codes_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "mfa_codes_user_id_users_id_fk"
		}),
]);

export const inventorySyncLogs = pgTable("inventory_sync_logs", {
	id: serial().primaryKey().notNull(),
	syncType: varchar("sync_type", { length: 64 }).notNull(),
	triggerLevel: varchar("trigger_level", { length: 32 }).notNull(),
	targetType: varchar("target_type", { length: 32 }).notNull(),
	targetId: integer("target_id"),
	affectedProducts: jsonb("affected_products").default([]),
	changesCount: integer("changes_count").default(0).notNull(),
	status: varchar({ length: 32 }).default('pending').notNull(),
	errorMessage: text("error_message"),
	performedByUserId: uuid("performed_by_user_id").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb().default({}),
}, (table) => [
	index("inventory_sync_logs_started_at_idx").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")),
	index("inventory_sync_logs_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("inventory_sync_logs_target_idx").using("btree", table.targetType.asc().nullsLast().op("int4_ops"), table.targetId.asc().nullsLast().op("int4_ops")),
	index("inventory_sync_logs_type_idx").using("btree", table.syncType.asc().nullsLast().op("text_ops")),
	index("inventory_sync_logs_user_idx").using("btree", table.performedByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.performedByUserId],
			foreignColumns: [users.id],
			name: "inventory_sync_logs_performed_by_user_id_users_id_fk"
		}),
]);

export const modifiers = pgTable("modifiers", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	type: varchar({ length: 64 }).default('unit').notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	createdByUserId: uuid("created_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("modifiers_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("modifiers_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("modifiers_type_idx").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("modifiers_user_idx").using("btree", table.createdByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "modifiers_created_by_user_id_users_id_fk"
		}),
]);

export const orgMetrics = pgTable("org_metrics", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	month: varchar({ length: 16 }),
	totalOrders: integer("total_orders"),
	totalSpendCents: integer("total_spend_cents"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("org_metrics_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "org_metrics_organization_id_organizations_id_fk"
		}),
]);

export const organizationSettings = pgTable("organization_settings", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	key: varchar({ length: 128 }).notNull(),
	value: jsonb(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("org_settings_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_settings_organization_id_organizations_id_fk"
		}),
]);

export const productAssignments = pgTable("product_assignments", {
	id: serial().primaryKey().notNull(),
	globalProductId: integer("global_product_id").notNull(),
	assignedToType: varchar("assigned_to_type", { length: 32 }).notNull(),
	assignedToId: integer("assigned_to_id").notNull(),
	action: varchar({ length: 32 }).notNull(),
	performedByUserId: uuid("performed_by_user_id").notNull(),
	performedByRole: varchar("performed_by_role", { length: 64 }).notNull(),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("product_assignments_assigned_to_idx").using("btree", table.assignedToType.asc().nullsLast().op("text_ops"), table.assignedToId.asc().nullsLast().op("int4_ops")),
	index("product_assignments_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("product_assignments_user_idx").using("btree", table.performedByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "product_assignments_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.performedByUserId],
			foreignColumns: [users.id],
			name: "product_assignments_performed_by_user_id_users_id_fk"
		}),
]);

export const organizationInventory = pgTable("organization_inventory", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	assignedByUserId: uuid("assigned_by_user_id").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	customName: varchar("custom_name", { length: 255 }),
	customPriceCents: integer("custom_price_cents"),
	customDescription: text("custom_description"),
	customImageUrl: text("custom_image_url"),
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("org_inventory_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	index("org_inventory_assigned_by_idx").using("btree", table.assignedByUserId.asc().nullsLast().op("uuid_ops")),
	index("org_inventory_deleted_at_idx").using("btree", table.deletedAt.asc().nullsLast().op("timestamptz_ops")),
	index("org_inventory_global_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("org_inventory_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("org_inventory_org_product_uq").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.globalProductId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.assignedByUserId],
			foreignColumns: [users.id],
			name: "organization_inventory_assigned_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "organization_inventory_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_inventory_organization_id_organizations_id_fk"
		}),
]);

export const organizations = pgTable("organizations", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 255 }).notNull(),
	code: varchar({ length: 64 }),
	status: varchar({ length: 32 }).default('active'),
	logoUrl: varchar("logo_url", { length: 512 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("org_code_idx").using("btree", table.code.asc().nullsLast().op("text_ops")),
	uniqueIndex("org_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("org_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
]);

export const organizationProducts = pgTable("organization_products", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	isEnabled: boolean("is_enabled").default(true).notNull(),
	customName: varchar("custom_name", { length: 255 }),
	customDescription: text("custom_description"),
	customPriceCents: integer("custom_price_cents"),
	customImageUrl: text("custom_image_url"),
	tags: jsonb().default([]),
	priority: integer().default(0),
	overrideLevel: varchar("override_level", { length: 32 }).default('super_admin'),
	metadata: jsonb().default({}),
	updatedByUserId: uuid("updated_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("org_products_enabled_idx").using("btree", table.isEnabled.asc().nullsLast().op("bool_ops")),
	index("org_products_global_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("org_products_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("org_products_org_product_uq").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.globalProductId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "organization_products_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "organization_products_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "organization_products_updated_by_user_id_users_id_fk"
		}),
]);

export const refunds = pgTable("refunds", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	orderId: integer("order_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxRefundCents: bigint("tax_refund_cents", { mode: "number" }).default(0).notNull(),
	reason: varchar({ length: 255 }),
	processedByUserId: uuid("processed_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	status: varchar({ length: 16 }).default('PENDING').notNull(),
	requestedByUserId: uuid("requested_by_user_id"),
}, (table) => [
	index("refunds_order_idx").using("btree", table.orderId.asc().nullsLast().op("int4_ops")),
	index("refunds_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("refunds_processed_by_idx").using("btree", table.processedByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "refunds_order_id_orders_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "refunds_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.processedByUserId],
			foreignColumns: [users.id],
			name: "refunds_processed_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.requestedByUserId],
			foreignColumns: [users.id],
			name: "refunds_requested_by_user_id_users_id_fk"
		}),
]);

export const roles = pgTable("roles", {
	id: serial().primaryKey().notNull(),
	name: varchar({ length: 64 }).notNull(),
	description: text(),
	permissions: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("roles_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
]);

export const sessions = pgTable("sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: integer("organization_id"),
	refreshTokenHash: varchar("refresh_token_hash", { length: 255 }).notNull(),
	ipAddress: varchar("ip_address", { length: 64 }),
	userAgent: varchar("user_agent", { length: 255 }),
	lastActivityAt: timestamp("last_activity_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("sessions_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("sessions_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("sessions_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "sessions_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "sessions_user_id_users_id_fk"
		}),
]);

export const suppliers = pgTable("suppliers", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	branchId: integer("branch_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	address: text(),
	contact: varchar({ length: 255 }),
	email: varchar({ length: 255 }),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("suppliers_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("suppliers_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("suppliers_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "suppliers_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "suppliers_organization_id_organizations_id_fk"
		}),
]);

export const skus = pgTable("skus", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	productId: integer("product_id").notNull(),
	sku: varchar({ length: 128 }).notNull(),
	unit: varchar({ length: 64 }).notNull(),
	priceCents: integer("price_cents").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("skus_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("skus_product_idx").using("btree", table.productId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("skus_sku_idx").using("btree", table.sku.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "skus_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [products.id],
			name: "skus_product_id_products_id_fk"
		}),
]);

export const productImportBatches = pgTable("product_import_batches", {
	id: serial().primaryKey().notNull(),
	fileName: varchar("file_name", { length: 255 }).notNull(),
	uploadedByUserId: uuid("uploaded_by_user_id").notNull(),
	totalRows: integer("total_rows").default(0).notNull(),
	successfulRows: integer("successful_rows").default(0).notNull(),
	failedRows: integer("failed_rows").default(0).notNull(),
	status: varchar({ length: 32 }).default('processing').notNull(),
	validationErrors: jsonb("validation_errors").default([]),
	importedProductIds: jsonb("imported_product_ids").default([]),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("product_import_batches_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("product_import_batches_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("product_import_batches_user_idx").using("btree", table.uploadedByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.uploadedByUserId],
			foreignColumns: [users.id],
			name: "product_import_batches_uploaded_by_user_id_users_id_fk"
		}),
]);

export const productModifiers = pgTable("product_modifiers", {
	id: serial().primaryKey().notNull(),
	productId: integer("product_id").notNull(),
	modifierId: integer("modifier_id").notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("product_modifiers_modifier_idx").using("btree", table.modifierId.asc().nullsLast().op("int4_ops")),
	index("product_modifiers_product_idx").using("btree", table.productId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("product_modifiers_product_modifier_idx").using("btree", table.productId.asc().nullsLast().op("int4_ops"), table.modifierId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.modifierId],
			foreignColumns: [modifiers.id],
			name: "product_modifiers_modifier_id_modifiers_id_fk"
		}),
	foreignKey({
			columns: [table.productId],
			foreignColumns: [globalProducts.id],
			name: "product_modifiers_product_id_global_products_id_fk"
		}),
]);

export const products = pgTable("products", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	name: varchar({ length: 255 }).notNull(),
	categoryId: integer("category_id").notNull(),
	description: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("products_category_idx").using("btree", table.categoryId.asc().nullsLast().op("int4_ops")),
	index("products_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("products_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [categories.id],
			name: "products_category_id_categories_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "products_organization_id_organizations_id_fk"
		}),
]);

export const groupAuditLogs = pgTable("group_audit_logs", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	groupId: integer("group_id"),
	action: varchar({ length: 128 }).notNull(),
	performedByUserId: uuid("performed_by_user_id").notNull(),
	performedByRole: varchar("performed_by_role", { length: 64 }).notNull(),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("group_audit_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("group_audit_group_idx").using("btree", table.groupId.asc().nullsLast().op("int4_ops")),
	index("group_audit_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("group_audit_timestamp_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("group_audit_user_idx").using("btree", table.performedByUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.groupId],
			foreignColumns: [groups.id],
			name: "group_audit_logs_group_id_groups_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "group_audit_logs_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.performedByUserId],
			foreignColumns: [users.id],
			name: "group_audit_logs_performed_by_user_id_users_id_fk"
		}),
]);

export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: varchar({ length: 255 }).notNull(),
	passwordHash: varchar("password_hash", { length: 255 }).notNull(),
	roleId: integer("role_id").notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	fullName: varchar("full_name", { length: 255 }),
	firstName: varchar("first_name", { length: 100 }),
	lastName: varchar("last_name", { length: 100 }),
	phone: varchar({ length: 32 }),
	mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	sessionVersion: integer("session_version").default(1).notNull(),
	employeeId: varchar("employee_id", { length: 64 }),
	imprestHolder: varchar("imprest_holder", { length: 255 }),
	contactPerson: varchar("contact_person", { length: 255 }),
	address: text(),
	username: varchar({ length: 255 }),
	location: varchar({ length: 255 }),
}, (table) => [
	index("users_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
	index("users_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("users_email_idx").using("btree", table.email.asc().nullsLast().op("text_ops")),
	uniqueIndex("users_employee_id_idx").using("btree", table.employeeId.asc().nullsLast().op("text_ops")),
	index("users_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("users_role_idx").using("btree", table.roleId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("users_username_idx").using("btree", table.username.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "users_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "users_role_id_roles_id_fk"
		}),
]);

export const orderItems = pgTable("order_items", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	organizationInventoryId: integer("organization_inventory_id"),
	orderId: integer("order_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	productName: varchar("product_name", { length: 255 }).notNull(),
	productCode: varchar("product_code", { length: 128 }),
	unit: varchar({ length: 64 }).notNull(),
	quantity: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	priceCents: bigint("price_cents", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("order_items_order_idx").using("btree", table.orderId.asc().nullsLast().op("int4_ops")),
	index("order_items_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("order_items_organization_inventory_idx").using("btree", table.organizationInventoryId.asc().nullsLast().op("int4_ops")),
	index("order_items_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("order_items_product_order_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops"), table.orderId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "order_items_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.orderId],
			foreignColumns: [orders.id],
			name: "order_items_order_id_orders_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "order_items_organization_id_organizations_id_fk"
		}),
]);

export const rolePermissions = pgTable("role_permissions", {
	id: serial().primaryKey().notNull(),
	roleId: integer("role_id").notNull(),
	permissionKey: varchar("permission_key", { length: 128 }).notNull(),
	allowed: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("role_permissions_role_idx").using("btree", table.roleId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.roleId],
			foreignColumns: [roles.id],
			name: "role_permissions_role_id_roles_id_fk"
		}),
]);

export const globalProducts = pgTable("global_products", {
	id: serial().primaryKey().notNull(),
	productCode: varchar("product_code", { length: 128 }).notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	categoryId: integer("category_id"),
	imageUrl: text("image_url"),
	basePriceCents: integer("base_price_cents").default(0).notNull(),
	unit: varchar({ length: 64 }).default('unit').notNull(),
	status: varchar({ length: 32 }).default('active').notNull(),
	metadata: jsonb().default({}),
	createdByUserId: uuid("created_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	discountType: varchar("discount_type", { length: 16 }),
	discountValueCents: integer("discount_value_cents"),
	discountStartAt: timestamp("discount_start_at", { withTimezone: true, mode: 'string' }),
	discountEndAt: timestamp("discount_end_at", { withTimezone: true, mode: 'string' }),
	discountActive: boolean("discount_active").default(false),
	stockQuantity: integer("stock_quantity").default(0).notNull(),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("global_products_cat_status_idx").using("btree", table.categoryId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("global_products_category_idx").using("btree", table.categoryId.asc().nullsLast().op("int4_ops")),
	index("global_products_code_idx").using("btree", table.productCode.asc().nullsLast().op("text_ops")),
	index("global_products_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("global_products_status_created_idx").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
	index("global_products_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.categoryId],
			foreignColumns: [categories.id],
			name: "global_products_category_id_categories_id_fk"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "global_products_created_by_user_id_users_id_fk"
		}),
]);

export const branches = pgTable("branches", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	province: varchar({ length: 100 }),
	city: varchar({ length: 100 }),
	address: text(),
	costCenterId: varchar("cost_center_id", { length: 128 }),
	adminUserId: uuid("admin_user_id"),
	code: varchar({ length: 64 }),
	status: varchar({ length: 32 }).default('active'),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	groupId: integer("group_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	baselineBudgetCents: bigint("baseline_budget_cents", { mode: "number" }).default(0).notNull(),
}, (table) => [
	index("branches_cost_center_idx").using("btree", table.costCenterId.asc().nullsLast().op("text_ops")),
	index("branches_group_idx").using("btree", table.groupId.asc().nullsLast().op("int4_ops")),
	index("branches_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("branches_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("branches_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "branches_organization_id_organizations_id_fk"
		}),
]);

export const notifications = pgTable("notifications", {
	id: serial().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id"),
	type: varchar({ length: 64 }).notNull(),
	targetRole: varchar("target_role", { length: 64 }),
	message: text().notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("notifications_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("notifications_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("notifications_type_idx").using("btree", table.type.asc().nullsLast().op("text_ops")),
	index("notifications_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "notifications_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "notifications_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "notifications_user_id_users_id_fk"
		}),
]);

export const auditLogs = pgTable("audit_logs", {
	id: serial().primaryKey().notNull(),
	userId: uuid("user_id"),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id"),
	action: varchar({ length: 128 }).notNull(),
	entity: varchar({ length: 128 }).notNull(),
	entityId: varchar("entity_id", { length: 128 }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("audit_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("audit_created_action_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"), table.action.asc().nullsLast().op("timestamptz_ops")),
	index("audit_entity_idx").using("btree", table.entity.asc().nullsLast().op("text_ops")),
	index("audit_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("audit_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "audit_logs_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "audit_logs_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "audit_logs_user_id_users_id_fk"
		}),
]);

export const orders = pgTable("orders", {
	id: serial().primaryKey().notNull(),
	tid: varchar({ length: 26 }).notNull(),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id").notNull(),
	status: varchar({ length: 32 }).default('PENDING').notNull(),
	fulfillmentStatus: varchar("fulfillment_status", { length: 32 }).default('NOT_STARTED').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	subtotalCents: bigint("subtotal_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	taxCents: bigint("tax_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	totalCents: bigint("total_cents", { mode: "number" }).default(0).notNull(),
	notes: text(),
	createdByUserId: uuid("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	fulfilledAt: timestamp("fulfilled_at", { withTimezone: true, mode: 'string' }),
	approvedByUserId: uuid("approved_by_user_id"),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	rejectedByUserId: uuid("rejected_by_user_id"),
	rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: 'string' }),
	rejectionReason: text("rejection_reason"),
	approvalTokenHash: varchar("approval_token_hash", { length: 255 }),
	approvalTokenCreatedAt: timestamp("approval_token_created_at", { withTimezone: true, mode: 'string' }),
	fulfilledByUserId: uuid("fulfilled_by_user_id"),
	approvalToken: varchar("approval_token", { length: 16 }),
	refundedAt: timestamp("refunded_at", { withTimezone: true, mode: 'string' }),
	refundedByUserId: uuid("refunded_by_user_id"),
	statusAtRefund: varchar("status_at_refund", { length: 32 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	refundAmountCents: bigint("refund_amount_cents", { mode: "number" }),
	refundReason: text("refund_reason"),
	receiptData: jsonb("receipt_data"),
}, (table) => [
	index("orders_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("orders_branch_status_created_idx").using("btree", table.branchId.asc().nullsLast().op("timestamptz_ops"), table.status.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("int4_ops")),
	index("orders_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("orders_fulfillment_status_idx").using("btree", table.fulfillmentStatus.asc().nullsLast().op("text_ops")),
	index("orders_org_branch_status_idx").using("btree", table.organizationId.asc().nullsLast().op("text_ops"), table.branchId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("orders_org_created_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("orders_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("orders_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	uniqueIndex("orders_tid_idx").using("btree", table.tid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.approvedByUserId],
			foreignColumns: [users.id],
			name: "orders_approved_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "orders_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "orders_created_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.fulfilledByUserId],
			foreignColumns: [users.id],
			name: "orders_fulfilled_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "orders_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.refundedByUserId],
			foreignColumns: [users.id],
			name: "orders_refunded_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.rejectedByUserId],
			foreignColumns: [users.id],
			name: "orders_rejected_by_user_id_users_id_fk"
		}),
	unique("orders_tid_unique").on(table.tid),
]);

export const systemLogs = pgTable("system_logs", {
	id: serial().primaryKey().notNull(),
	timestamp: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	userId: varchar("user_id", { length: 255 }),
	userRole: varchar("user_role", { length: 64 }),
	userEmail: varchar("user_email", { length: 255 }),
	organizationId: integer("organization_id"),
	branchId: integer("branch_id"),
	action: varchar({ length: 128 }).notNull(),
	resourceType: varchar("resource_type", { length: 64 }).notNull(),
	resourceId: varchar("resource_id", { length: 128 }),
	details: jsonb(),
	ipAddress: varchar("ip_address", { length: 64 }),
	userAgent: text("user_agent"),
	success: boolean().default(true).notNull(),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("system_logs_action_idx").using("btree", table.action.asc().nullsLast().op("text_ops")),
	index("system_logs_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("system_logs_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("system_logs_resource_idx").using("btree", table.resourceType.asc().nullsLast().op("text_ops"), table.resourceId.asc().nullsLast().op("text_ops")),
	index("system_logs_role_idx").using("btree", table.userRole.asc().nullsLast().op("text_ops")),
	index("system_logs_timestamp_idx").using("btree", table.timestamp.asc().nullsLast().op("timestamptz_ops")),
	index("system_logs_user_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "system_logs_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "system_logs_organization_id_organizations_id_fk"
		}),
]);

export const groups = pgTable("groups", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	name: varchar({ length: 255 }).notNull(),
	description: text(),
	status: varchar({ length: 32 }).default('active'),
	createdByUserId: uuid("created_by_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("groups_name_idx").using("btree", table.name.asc().nullsLast().op("text_ops")),
	index("groups_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("groups_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "groups_created_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "groups_organization_id_organizations_id_fk"
		}),
]);

export const refundItems = pgTable("refund_items", {
	id: serial().primaryKey().notNull(),
	refundId: integer("refund_id").notNull(),
	orderItemId: integer("order_item_id").notNull(),
	quantity: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("refund_items_order_item_idx").using("btree", table.orderItemId.asc().nullsLast().op("int4_ops")),
	index("refund_items_refund_idx").using("btree", table.refundId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.orderItemId],
			foreignColumns: [orderItems.id],
			name: "refund_items_order_item_id_order_items_id_fk"
		}),
	foreignKey({
			columns: [table.refundId],
			foreignColumns: [refunds.id],
			name: "refund_items_refund_id_refunds_id_fk"
		}).onDelete("cascade"),
]);

export const scheduledReports = pgTable("scheduled_reports", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id"),
	userId: uuid("user_id").notNull(),
	reportName: varchar("report_name", { length: 255 }).notNull(),
	frequency: varchar({ length: 32 }).notNull(),
	format: varchar({ length: 16 }).notNull(),
	emails: jsonb().default([]).notNull(),
	enabled: boolean().default(true).notNull(),
	lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("scheduled_reports_enabled_idx").using("btree", table.enabled.asc().nullsLast().op("bool_ops")),
	index("scheduled_reports_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("scheduled_reports_user_idx").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "scheduled_reports_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "scheduled_reports_user_id_users_id_fk"
		}),
]);

export const budgetAddons = pgTable("budget_addons", {
	id: serial().primaryKey().notNull(),
	budgetId: integer("budget_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	reason: text(),
	createdByUserId: uuid("created_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("budget_addons_budget_idx").using("btree", table.budgetId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.budgetId],
			foreignColumns: [budgets.id],
			name: "budget_addons_budget_id_budgets_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "budget_addons_created_by_user_id_users_id_fk"
		}),
]);

export const budgets = pgTable("budgets", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	branchId: integer("branch_id").notNull(),
	period: varchar({ length: 16 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountAllocatedCents: bigint("amount_allocated_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountSpentCents: bigint("amount_spent_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountHeldCents: bigint("amount_held_cents", { mode: "number" }).default(0).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	amountCreditedCents: bigint("amount_credited_cents", { mode: "number" }).default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("budgets_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("budgets_branch_period_uq").using("btree", table.branchId.asc().nullsLast().op("int4_ops"), table.period.asc().nullsLast().op("int4_ops")),
	index("budgets_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "budgets_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "budgets_organization_id_organizations_id_fk"
	}),
]);

export const productQuantityBudgets = pgTable("product_quantity_budgets", {
	id: serial().primaryKey().notNull(),
	organizationId: integer("organization_id").notNull(),
	branchId: integer("branch_id").notNull(),
	organizationInventoryId: integer("organization_inventory_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	period: varchar({ length: 16 }).notNull(),
	allocatedQuantity: integer("allocated_quantity").default(0).notNull(),
	heldQuantity: integer("held_quantity").default(0).notNull(),
	usedQuantity: integer("used_quantity").default(0).notNull(),
	creditedQuantity: integer("credited_quantity").default(0).notNull(),
	amountAllocatedCents: bigint("amount_allocated_cents", { mode: "number" }).default(0).notNull(),
	amountCreditedCents: bigint("amount_credited_cents", { mode: "number" }).default(0).notNull(),
	createdByUserId: uuid("created_by_user_id"),
	updatedByUserId: uuid("updated_by_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("product_quantity_budgets_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	uniqueIndex("product_quantity_budgets_branch_product_period_uq").using("btree", table.branchId.asc().nullsLast().op("int4_ops"), table.organizationInventoryId.asc().nullsLast().op("int4_ops"), table.period.asc().nullsLast().op("text_ops")),
	index("product_quantity_budgets_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("product_quantity_budgets_period_idx").using("btree", table.period.asc().nullsLast().op("text_ops")),
	index("product_quantity_budgets_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "product_quantity_budgets_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "product_quantity_budgets_created_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "product_quantity_budgets_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "product_quantity_budgets_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.organizationInventoryId],
			foreignColumns: [organizationInventory.id],
			name: "product_quantity_budgets_organization_inventory_id_organization"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.updatedByUserId],
			foreignColumns: [users.id],
			name: "product_quantity_budgets_updated_by_user_id_users_id_fk"
		}),
]);

export const productQuantityBudgetAllocations = pgTable("product_quantity_budget_allocations", {
	id: serial().primaryKey().notNull(),
	quantityBudgetId: integer("quantity_budget_id").notNull(),
	budgetId: integer("budget_id"),
	organizationId: integer("organization_id").notNull(),
	branchId: integer("branch_id").notNull(),
	organizationInventoryId: integer("organization_inventory_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	period: varchar({ length: 16 }).notNull(),
	allocationType: varchar("allocation_type", { length: 32 }).notNull(),
	quantity: integer().notNull(),
	priceCents: bigint("price_cents", { mode: "number" }).notNull(),
	amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
	createdByUserId: uuid("created_by_user_id"),
	metadata: jsonb().default({}),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("product_quantity_budget_allocations_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("product_quantity_budget_allocations_budget_idx").using("btree", table.quantityBudgetId.asc().nullsLast().op("int4_ops")),
	index("product_quantity_budget_allocations_period_idx").using("btree", table.period.asc().nullsLast().op("text_ops")),
	index("product_quantity_budget_allocations_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "product_quantity_budget_allocations_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.budgetId],
			foreignColumns: [budgets.id],
			name: "product_quantity_budget_allocations_budget_id_budgets_id_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdByUserId],
			foreignColumns: [users.id],
			name: "product_quantity_budget_allocations_created_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "product_quantity_budget_allocations_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "product_quantity_budget_allocations_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.organizationInventoryId],
			foreignColumns: [organizationInventory.id],
			name: "product_quantity_budget_allocations_organization_inventory_id"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.quantityBudgetId],
			foreignColumns: [productQuantityBudgets.id],
			name: "product_quantity_budget_allocations_quantity_budget_id_fk"
		}).onDelete("cascade"),
]);

export const restockRequests = pgTable("restock_requests", {
	id: serial().primaryKey().notNull(),
	branchId: integer("branch_id").notNull(),
	organizationId: integer("organization_id").notNull(),
	globalProductId: integer("global_product_id").notNull(),
	requestedQuantity: integer("requested_quantity").notNull(),
	currentStock: integer("current_stock").notNull(),
	reason: text(),
	status: varchar({ length: 32 }).default('pending').notNull(),
	requestedByUserId: uuid("requested_by_user_id").notNull(),
	reviewedByUserId: uuid("reviewed_by_user_id"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
	reviewNotes: text("review_notes"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("restock_requests_branch_idx").using("btree", table.branchId.asc().nullsLast().op("int4_ops")),
	index("restock_requests_org_idx").using("btree", table.organizationId.asc().nullsLast().op("int4_ops")),
	index("restock_requests_product_idx").using("btree", table.globalProductId.asc().nullsLast().op("int4_ops")),
	index("restock_requests_requested_by_idx").using("btree", table.requestedByUserId.asc().nullsLast().op("uuid_ops")),
	index("restock_requests_status_idx").using("btree", table.status.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.branchId],
			foreignColumns: [branches.id],
			name: "restock_requests_branch_id_branches_id_fk"
		}),
	foreignKey({
			columns: [table.globalProductId],
			foreignColumns: [globalProducts.id],
			name: "restock_requests_global_product_id_global_products_id_fk"
		}),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organizations.id],
			name: "restock_requests_organization_id_organizations_id_fk"
		}),
	foreignKey({
			columns: [table.requestedByUserId],
			foreignColumns: [users.id],
			name: "restock_requests_requested_by_user_id_users_id_fk"
		}),
	foreignKey({
			columns: [table.reviewedByUserId],
			foreignColumns: [users.id],
			name: "restock_requests_reviewed_by_user_id_users_id_fk"
		}),
]);

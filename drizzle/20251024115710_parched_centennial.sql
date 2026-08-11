CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"organization_id" integer,
	"branch_id" integer,
	"action" varchar(128) NOT NULL,
	"entity" varchar(128) NOT NULL,
	"entity_id" varchar(128),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "branch_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"organization_inventory_id" integer NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"is_visible" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 10 NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "branch_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"organization_product_id" integer,
	"is_visible" boolean DEFAULT true NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"stock_quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 10 NOT NULL,
	"reorder_quantity" integer DEFAULT 50 NOT NULL,
	"last_restock_date" timestamp with time zone,
	"custom_notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"admin_user_id" uuid,
	"code" varchar(64),
	"status" varchar(32) DEFAULT 'active', -- NOSONAR: generated schema repeats this default intentionally
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"period" varchar(16) NOT NULL,
	"amount_allocated_cents" integer DEFAULT 0 NOT NULL,
	"amount_spent_cents" integer DEFAULT 0 NOT NULL,
	"amount_held_cents" integer DEFAULT 0 NOT NULL,
	"amount_credited_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" varchar(255) NOT NULL,
	"parent_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "employee_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"first_name" varchar(128),
	"last_name" varchar(128),
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"mfa_secret" varchar(255),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deactivated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "global_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_code" varchar(128) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category_id" integer,
	"image_url" varchar(512),
	"base_price_cents" integer DEFAULT 0 NOT NULL,
	"unit" varchar(64) DEFAULT 'unit' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "head_offices" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_email" varchar(255),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"branch_id" integer NOT NULL,
	"sku_id" integer NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"reorder_threshold" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "inventory_sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"sync_type" varchar(64) NOT NULL,
	"trigger_level" varchar(32) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" integer,
	"affected_products" jsonb DEFAULT '[]'::jsonb,
	"changes_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"performed_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE "mfa_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" varchar(6) NOT NULL,
	"type" varchar(20) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"is_used" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"type" varchar(64) DEFAULT 'unit' NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer,
	"branch_id" integer,
	"type" varchar(64) NOT NULL,
	"target_role" varchar(64),
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"order_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"product_name" varchar(255) NOT NULL,
	"product_code" varchar(128),
	"unit" varchar(64) NOT NULL,
	"quantity" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"tid" varchar(26) NOT NULL,
	"organization_id" integer,
	"branch_id" integer NOT NULL,
	"status" varchar(32) DEFAULT 'PENDING' NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "orders_tid_unique" UNIQUE("tid")
);
--> statement-breakpoint
CREATE TABLE "org_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"month" varchar(16),
	"total_orders" integer,
	"total_spend_cents" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organization_inventory" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"assigned_by_user_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom_name" varchar(255),
	"custom_price_cents" integer,
	"custom_description" text,
	"custom_image_url" varchar(512),
	"assigned_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_products" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"custom_name" varchar(255),
	"custom_description" text,
	"custom_price_cents" integer,
	"custom_image_url" varchar(512),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"priority" integer DEFAULT 0,
	"override_level" varchar(32) DEFAULT 'super_admin',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"key" varchar(128) NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(64),
	"status" varchar(32) DEFAULT 'active',
	"logo_url" varchar(512),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "product_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"global_product_id" integer NOT NULL,
	"assigned_to_type" varchar(32) NOT NULL,
	"assigned_to_id" integer NOT NULL,
	"action" varchar(32) NOT NULL,
	"performed_by_user_id" uuid NOT NULL,
	"performed_by_role" varchar(64) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "product_import_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"successful_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'processing' NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb,
	"imported_product_ids" jsonb DEFAULT '[]'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "product_modifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"modifier_id" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"name" varchar(255) NOT NULL,
	"category_id" integer NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"order_id" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" varchar(255),
	"processed_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "restock_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"branch_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"global_product_id" integer NOT NULL,
	"requested_quantity" integer NOT NULL,
	"current_stock" integer NOT NULL,
	"reason" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"role_id" integer NOT NULL,
	"permission_key" varchar(128) NOT NULL,
	"allowed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(64) NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" integer,
	"refresh_token_hash" varchar(255) NOT NULL,
	"ip_address" varchar(64),
	"user_agent" varchar(255),
	"last_activity_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer,
	"product_id" integer NOT NULL,
	"sku" varchar(128) NOT NULL,
	"unit" varchar(64) NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"address" text,
	"contact" varchar(255),
	"email" varchar(255),
	"description" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role_id" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"full_name" varchar(255),
	"first_name" varchar(100),
	"last_name" varchar(100),
	"phone" varchar(32),
	"login_code" varchar(64),
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"organization_id" integer,
	"branch_id" integer,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"code" varchar(64),
	"contact" varchar(255),
	"email" varchar(255),
	"description" text,
	"is_main" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_inventory" ADD CONSTRAINT "branch_inventory_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_inventory" ADD CONSTRAINT "branch_inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_inventory" ADD CONSTRAINT "branch_inventory_organization_inventory_id_organization_inventory_id_fk" FOREIGN KEY ("organization_inventory_id") REFERENCES "public"."organization_inventory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_inventory" ADD CONSTRAINT "branch_inventory_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_organization_product_id_organization_products_id_fk" FOREIGN KEY ("organization_product_id") REFERENCES "public"."organization_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_products" ADD CONSTRAINT "branch_products_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_credentials" ADD CONSTRAINT "employee_credentials_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_credentials" ADD CONSTRAINT "employee_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_credentials" ADD CONSTRAINT "employee_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_products" ADD CONSTRAINT "global_products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_products" ADD CONSTRAINT "global_products_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "head_offices" ADD CONSTRAINT "head_offices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_sync_logs" ADD CONSTRAINT "inventory_sync_logs_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_codes" ADD CONSTRAINT "mfa_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_metrics" ADD CONSTRAINT "org_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_inventory" ADD CONSTRAINT "organization_inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_inventory" ADD CONSTRAINT "organization_inventory_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_inventory" ADD CONSTRAINT "organization_inventory_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_products" ADD CONSTRAINT "organization_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_products" ADD CONSTRAINT "organization_products_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_products" ADD CONSTRAINT "organization_products_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_assignments" ADD CONSTRAINT "product_assignments_performed_by_user_id_users_id_fk" FOREIGN KEY ("performed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_import_batches" ADD CONSTRAINT "product_import_batches_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifiers" ADD CONSTRAINT "product_modifiers_product_id_global_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_modifiers" ADD CONSTRAINT "product_modifiers_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_processed_by_user_id_users_id_fk" FOREIGN KEY ("processed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_global_product_id_global_products_id_fk" FOREIGN KEY ("global_product_id") REFERENCES "public"."global_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restock_requests" ADD CONSTRAINT "restock_requests_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_logs" USING btree ("entity");--> statement-breakpoint
CREATE INDEX "audit_org_idx" ON "audit_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_branch_idx" ON "audit_logs" USING btree ("branch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_inventory_branch_org_inventory_uq" ON "branch_inventory" USING btree ("branch_id","organization_inventory_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_branch_idx" ON "branch_inventory" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_org_idx" ON "branch_inventory" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_org_inventory_idx" ON "branch_inventory" USING btree ("organization_inventory_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_assigned_by_idx" ON "branch_inventory" USING btree ("assigned_by_user_id");--> statement-breakpoint
CREATE INDEX "branch_inventory_visible_idx" ON "branch_inventory" USING btree ("is_visible");--> statement-breakpoint
CREATE INDEX "branch_inventory_active_idx" ON "branch_inventory" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "branch_inventory_deleted_at_idx" ON "branch_inventory" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_products_branch_product_uq" ON "branch_products" USING btree ("branch_id","global_product_id");--> statement-breakpoint
CREATE INDEX "branch_products_branch_idx" ON "branch_products" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "branch_products_org_idx" ON "branch_products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "branch_products_global_idx" ON "branch_products" USING btree ("global_product_id");--> statement-breakpoint
CREATE INDEX "branch_products_org_product_idx" ON "branch_products" USING btree ("organization_product_id");--> statement-breakpoint
CREATE INDEX "branch_products_visible_idx" ON "branch_products" USING btree ("is_visible");--> statement-breakpoint
CREATE INDEX "branch_products_available_idx" ON "branch_products" USING btree ("is_available");--> statement-breakpoint
CREATE INDEX "branch_products_low_stock_idx" ON "branch_products" USING btree ("stock_quantity");--> statement-breakpoint
CREATE INDEX "branches_org_idx" ON "branches" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "branches_name_idx" ON "branches" USING btree ("name");--> statement-breakpoint
CREATE INDEX "branches_status_idx" ON "branches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_branch_period_uq" ON "budgets" USING btree ("branch_id","period");--> statement-breakpoint
CREATE INDEX "budgets_org_idx" ON "budgets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "budgets_branch_idx" ON "budgets" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "categories_name_idx" ON "categories" USING btree ("name");--> statement-breakpoint
CREATE INDEX "categories_org_idx" ON "categories" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_creds_email_uq" ON "employee_credentials" USING btree ("email");--> statement-breakpoint
CREATE INDEX "employee_creds_branch_idx" ON "employee_credentials" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "employee_creds_org_idx" ON "employee_credentials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "employee_creds_active_idx" ON "employee_credentials" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "employee_creds_created_by_idx" ON "employee_credentials" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "global_products_code_idx" ON "global_products" USING btree ("product_code");--> statement-breakpoint
CREATE INDEX "global_products_name_idx" ON "global_products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "global_products_category_idx" ON "global_products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "global_products_status_idx" ON "global_products" USING btree ("status");--> statement-breakpoint
CREATE INDEX "head_offices_org_idx" ON "head_offices" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_branch_sku_uq" ON "inventory" USING btree ("branch_id","sku_id");--> statement-breakpoint
CREATE INDEX "inventory_branch_idx" ON "inventory" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "inventory_org_idx" ON "inventory" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inventory_org_branch_sku_idx" ON "inventory" USING btree ("organization_id","branch_id","sku_id");--> statement-breakpoint
CREATE INDEX "inventory_sync_logs_type_idx" ON "inventory_sync_logs" USING btree ("sync_type");--> statement-breakpoint
CREATE INDEX "inventory_sync_logs_target_idx" ON "inventory_sync_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "inventory_sync_logs_status_idx" ON "inventory_sync_logs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inventory_sync_logs_user_idx" ON "inventory_sync_logs" USING btree ("performed_by_user_id");--> statement-breakpoint
CREATE INDEX "inventory_sync_logs_started_at_idx" ON "inventory_sync_logs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "mfa_codes_user_idx" ON "mfa_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mfa_codes_code_idx" ON "mfa_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "mfa_codes_expires_idx" ON "mfa_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "mfa_codes_type_idx" ON "mfa_codes" USING btree ("type");--> statement-breakpoint
CREATE INDEX "modifiers_name_idx" ON "modifiers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "modifiers_type_idx" ON "modifiers" USING btree ("type");--> statement-breakpoint
CREATE INDEX "modifiers_status_idx" ON "modifiers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "modifiers_user_idx" ON "modifiers" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_type_idx" ON "notifications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "notifications_org_idx" ON "notifications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notifications_branch_idx" ON "notifications" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_org_idx" ON "order_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "order_items_product_idx" ON "order_items" USING btree ("global_product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tid_idx" ON "orders" USING btree ("tid");--> statement-breakpoint
CREATE INDEX "orders_branch_idx" ON "orders" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_org_idx" ON "orders" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "orders_org_branch_status_idx" ON "orders" USING btree ("organization_id","branch_id","status");--> statement-breakpoint
CREATE INDEX "org_metrics_org_idx" ON "org_metrics" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_inventory_org_product_uq" ON "organization_inventory" USING btree ("organization_id","global_product_id");--> statement-breakpoint
CREATE INDEX "org_inventory_org_idx" ON "organization_inventory" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_inventory_global_product_idx" ON "organization_inventory" USING btree ("global_product_id");--> statement-breakpoint
CREATE INDEX "org_inventory_assigned_by_idx" ON "organization_inventory" USING btree ("assigned_by_user_id");--> statement-breakpoint
CREATE INDEX "org_inventory_active_idx" ON "organization_inventory" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "org_inventory_deleted_at_idx" ON "organization_inventory" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "org_products_org_product_uq" ON "organization_products" USING btree ("organization_id","global_product_id");--> statement-breakpoint
CREATE INDEX "org_products_org_idx" ON "organization_products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "org_products_global_idx" ON "organization_products" USING btree ("global_product_id");--> statement-breakpoint
CREATE INDEX "org_products_enabled_idx" ON "organization_products" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "org_settings_org_idx" ON "organization_settings" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_name_idx" ON "organizations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "org_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_assignments_product_idx" ON "product_assignments" USING btree ("global_product_id");--> statement-breakpoint
CREATE INDEX "product_assignments_assigned_to_idx" ON "product_assignments" USING btree ("assigned_to_type","assigned_to_id");--> statement-breakpoint
CREATE INDEX "product_assignments_user_idx" ON "product_assignments" USING btree ("performed_by_user_id");--> statement-breakpoint
CREATE INDEX "product_import_batches_user_idx" ON "product_import_batches" USING btree ("uploaded_by_user_id");--> statement-breakpoint
CREATE INDEX "product_import_batches_status_idx" ON "product_import_batches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "product_import_batches_created_at_idx" ON "product_import_batches" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_modifiers_product_idx" ON "product_modifiers" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_modifiers_modifier_idx" ON "product_modifiers" USING btree ("modifier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_modifiers_product_modifier_idx" ON "product_modifiers" USING btree ("product_id","modifier_id");--> statement-breakpoint
CREATE INDEX "products_category_idx" ON "products" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_org_idx" ON "refunds" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "refunds_processed_by_idx" ON "refunds" USING btree ("processed_by_user_id");--> statement-breakpoint
CREATE INDEX "restock_requests_branch_idx" ON "restock_requests" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "restock_requests_org_idx" ON "restock_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "restock_requests_product_idx" ON "restock_requests" USING btree ("global_product_id");--> statement-breakpoint
CREATE INDEX "restock_requests_status_idx" ON "restock_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "restock_requests_requested_by_idx" ON "restock_requests" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_idx" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_org_idx" ON "sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "skus_product_idx" ON "skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_sku_idx" ON "skus" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "skus_org_idx" ON "skus" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppliers_org_idx" ON "suppliers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppliers_branch_idx" ON "suppliers" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "suppliers_name_idx" ON "suppliers" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "users_active_idx" ON "users" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "users_login_code_idx" ON "users" USING btree ("login_code");--> statement-breakpoint
CREATE INDEX "users_org_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_branch_idx" ON "users" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "warehouses_org_idx" ON "warehouses" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "warehouses_branch_idx" ON "warehouses" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "warehouses_name_idx" ON "warehouses" USING btree ("name");--> statement-breakpoint
CREATE INDEX "warehouses_code_idx" ON "warehouses" USING btree ("code");--> statement-breakpoint
CREATE INDEX "warehouses_main_idx" ON "warehouses" USING btree ("is_main");

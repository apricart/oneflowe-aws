-- Direct communication between portal users and Apricart.
--
-- Four new tables plus three additive changes to existing ones. Nothing here
-- drops or rewrites anything: every statement is guarded so the migration is
-- re-entrant, and rolling the application back leaves these tables unused
-- rather than broken.

CREATE TABLE IF NOT EXISTS "support_threads" (
  "id" serial PRIMARY KEY NOT NULL,
  "organization_id" integer NOT NULL,
  "branch_id" integer,
  "order_id" integer,
  "subject" varchar(200) NOT NULL,
  "category" varchar(32) NOT NULL,
  "status" varchar(32) DEFAULT 'OPEN' NOT NULL,
  "priority" varchar(16) DEFAULT 'NORMAL' NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "assigned_to_user_id" uuid,
  "message_count" integer DEFAULT 0 NOT NULL,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_message_side" varchar(16) DEFAULT 'CUSTOMER' NOT NULL,
  "first_response_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "resolved_by_user_id" uuid,
  "closed_at" timestamp with time zone,
  "closed_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "support_threads_status_valid_ck" CHECK ("status" IN ('OPEN', 'AWAITING_CUSTOMER', 'RESOLVED', 'CLOSED')),
  CONSTRAINT "support_threads_category_valid_ck" CHECK ("category" IN ('INVOICE', 'ORDER', 'DELIVERY', 'PRODUCT', 'BILLING', 'OTHER')),
  CONSTRAINT "support_threads_priority_valid_ck" CHECK ("priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  CONSTRAINT "support_threads_side_valid_ck" CHECK ("last_message_side" IN ('CUSTOMER', 'APRICART')),
  CONSTRAINT "support_threads_message_count_ck" CHECK ("message_count" >= 0),
  CONSTRAINT "support_threads_subject_present_ck" CHECK (char_length(btrim("subject")) > 0)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "support_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "thread_id" integer NOT NULL,
  "author_user_id" uuid NOT NULL,
  "author_side" varchar(16) NOT NULL,
  "author_role" varchar(64) NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "support_messages_side_valid_ck" CHECK ("author_side" IN ('CUSTOMER', 'APRICART')),
  CONSTRAINT "support_messages_body_length_ck" CHECK (char_length(btrim("body")) BETWEEN 1 AND 5000)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "support_attachments" (
  "id" serial PRIMARY KEY NOT NULL,
  "thread_id" integer,
  "message_id" integer,
  "organization_id" integer NOT NULL,
  "uploaded_by_user_id" uuid NOT NULL,
  "storage_key" varchar(255) NOT NULL,
  "file_name" varchar(255) NOT NULL,
  "content_type" varchar(64) NOT NULL,
  "size_bytes" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "support_attachments_size_valid_ck" CHECK ("size_bytes" > 0 AND "size_bytes" <= 4194304)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "support_thread_reads" (
  "id" serial PRIMARY KEY NOT NULL,
  "thread_id" integer NOT NULL,
  "user_id" uuid NOT NULL,
  "last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Foreign keys. Each is added only if it is not already present, so a repeated
-- run is a no-op rather than a duplicate-object error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_organization_id_organizations_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_organization_id_organizations_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_branch_id_branches_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_branch_id_branches_id_fk"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_order_id_orders_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_created_by_user_id_users_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_created_by_user_id_users_id_fk"
      FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_assigned_to_user_id_users_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_assigned_to_user_id_users_id_fk"
      FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_resolved_by_user_id_users_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_resolved_by_user_id_users_id_fk"
      FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_threads_closed_by_user_id_users_id_fk') THEN
    ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_closed_by_user_id_users_id_fk"
      FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_thread_id_support_threads_id_fk') THEN
    ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_thread_id_support_threads_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_messages_author_user_id_users_id_fk') THEN
    ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_author_user_id_users_id_fk"
      FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_attachments_thread_id_support_threads_id_fk') THEN
    ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_thread_id_support_threads_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_attachments_message_id_support_messages_id_fk') THEN
    ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_support_messages_id_fk"
      FOREIGN KEY ("message_id") REFERENCES "public"."support_messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_attachments_organization_id_organizations_id_fk') THEN
    ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_organization_id_organizations_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_attachments_uploaded_by_user_id_users_id_fk') THEN
    ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_uploaded_by_user_id_users_id_fk"
      FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_thread_reads_thread_id_support_threads_id_fk') THEN
    ALTER TABLE "support_thread_reads" ADD CONSTRAINT "support_thread_reads_thread_id_support_threads_id_fk"
      FOREIGN KEY ("thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_thread_reads_user_id_users_id_fk') THEN
    ALTER TABLE "support_thread_reads" ADD CONSTRAINT "support_thread_reads_user_id_users_id_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "support_threads_org_idx" ON "support_threads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_branch_idx" ON "support_threads" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_order_idx" ON "support_threads" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_creator_idx" ON "support_threads" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_assignee_idx" ON "support_threads" USING btree ("assigned_to_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_org_activity_idx" ON "support_threads" USING btree ("organization_id","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_threads_status_activity_idx" ON "support_threads" USING btree ("status","last_message_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_messages_thread_created_idx" ON "support_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_messages_author_idx" ON "support_messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_attachments_storage_key_uq" ON "support_attachments" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_attachments_message_idx" ON "support_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_attachments_thread_idx" ON "support_attachments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_attachments_uploader_idx" ON "support_attachments" USING btree ("uploaded_by_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_thread_reads_thread_user_uq" ON "support_thread_reads" USING btree ("thread_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_thread_reads_user_idx" ON "support_thread_reads" USING btree ("user_id");--> statement-breakpoint

-- The bell needs to deep-link a support thread.
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "support_thread_id" integer;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_support_thread_id_support_threads_id_fk') THEN
    ALTER TABLE "notifications" ADD CONSTRAINT "notifications_support_thread_id_support_threads_id_fk"
      FOREIGN KEY ("support_thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_support_thread_idx" ON "notifications" USING btree ("support_thread_id");--> statement-breakpoint

-- The outbox now carries support messages as well as order lifecycle events. A
-- support notification has no order, and a Head Office raiser has no branch, so
-- both columns relax to NULL. This is additive: every row already written keeps
-- its values, and every existing write still supplies them.
ALTER TABLE "email_outbox" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ALTER COLUMN "branch_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN IF NOT EXISTS "support_thread_id" integer;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_support_thread_id_support_threads_id_fk') THEN
    ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_support_thread_id_support_threads_id_fk"
      FOREIGN KEY ("support_thread_id") REFERENCES "public"."support_threads"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_support_thread_idx" ON "email_outbox" USING btree ("support_thread_id");

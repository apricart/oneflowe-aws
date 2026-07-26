ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "order_id" integer;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "event_key" varchar(255);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'notifications_order_id_orders_id_fk'
  ) THEN
    ALTER TABLE "notifications"
      ADD CONSTRAINT "notifications_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_order_idx" ON "notifications" ("order_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_event_key_uq" ON "notifications" ("event_key");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "email_outbox" (
  "id" serial PRIMARY KEY NOT NULL,
  "event_key" varchar(255) NOT NULL,
  "recipient_user_id" uuid NOT NULL,
  "recipient_email" varchar(255) NOT NULL,
  "recipient_role" varchar(64) NOT NULL,
  "organization_id" integer NOT NULL,
  "branch_id" integer NOT NULL,
  "order_id" integer NOT NULL,
  "template" varchar(64) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" varchar(32) DEFAULT 'PENDING' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now(),
  "processing_started_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "provider_message_id" varchar(255),
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "email_outbox_attempts_nonnegative_ck" CHECK ("attempts" >= 0),
  CONSTRAINT "email_outbox_status_valid_ck" CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED'))
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_recipient_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "email_outbox"
      ADD CONSTRAINT "email_outbox_recipient_user_id_users_id_fk"
      FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_organization_id_organizations_id_fk'
  ) THEN
    ALTER TABLE "email_outbox"
      ADD CONSTRAINT "email_outbox_organization_id_organizations_id_fk"
      FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_branch_id_branches_id_fk'
  ) THEN
    ALTER TABLE "email_outbox"
      ADD CONSTRAINT "email_outbox_branch_id_branches_id_fk"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'email_outbox_order_id_orders_id_fk'
  ) THEN
    ALTER TABLE "email_outbox"
      ADD CONSTRAINT "email_outbox_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_outbox_event_key_uq" ON "email_outbox" ("event_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_status_next_attempt_idx" ON "email_outbox" ("status", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_recipient_idx" ON "email_outbox" ("recipient_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_org_idx" ON "email_outbox" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_branch_idx" ON "email_outbox" ("branch_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_outbox_order_idx" ON "email_outbox" ("order_id");
--> statement-breakpoint

ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "email_outbox" FROM anon;
    REVOKE ALL ON SEQUENCE "email_outbox_id_seq" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "email_outbox" FROM authenticated;
    REVOKE ALL ON SEQUENCE "email_outbox_id_seq" FROM authenticated;
  END IF;
END $$;

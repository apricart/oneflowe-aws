-- Verify a join applicant's email with a one-time code before the join form.
-- See plans/OF-JOIN-email-otp-verification.md.
--
-- Additive only: a new table, and a nullable column on organization_join_requests
-- that every existing request leaves null.
--
-- Apply before deploying: the join submit reads the table and writes the column.
--
-- Rollback (after reverting the code that reads them):
--   DROP TABLE IF EXISTS "join_email_verifications";
--   ALTER TABLE "organization_join_requests" DROP COLUMN IF EXISTS "email_verified_at";

CREATE TABLE IF NOT EXISTS "join_email_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" integer NOT NULL,
	"email_digest" varchar(64) NOT NULL,
	"code_digest" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"proof_digest" varchar(64),
	"proof_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_email_verifications_attempts_ck" CHECK ("join_email_verifications"."attempts" >= 0 AND "join_email_verifications"."attempts" <= 5),
	CONSTRAINT "join_email_verifications_digest_shape_ck" CHECK ("join_email_verifications"."email_digest" ~ '^[0-9a-f]{64}$' AND "join_email_verifications"."code_digest" ~ '^[0-9a-f]{64}$' AND ("join_email_verifications"."proof_digest" IS NULL OR "join_email_verifications"."proof_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "join_email_verifications_time_order_ck" CHECK ("join_email_verifications"."created_at" < "join_email_verifications"."expires_at" AND ("join_email_verifications"."proof_expires_at" IS NULL OR "join_email_verifications"."verified_at" <= "join_email_verifications"."proof_expires_at")),
	CONSTRAINT "join_email_verifications_verification_ck" CHECK (("join_email_verifications"."verified_at" IS NULL AND "join_email_verifications"."proof_digest" IS NULL AND "join_email_verifications"."proof_expires_at" IS NULL)
        OR ("join_email_verifications"."verified_at" IS NOT NULL AND "join_email_verifications"."proof_digest" IS NOT NULL AND "join_email_verifications"."proof_expires_at" IS NOT NULL))
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "join_email_verifications" ADD CONSTRAINT "join_email_verifications_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_email_verifications_subject_idx" ON "join_email_verifications" USING btree ("organization_id","email_digest","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "join_email_verifications_expiry_idx" ON "join_email_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_email_verifications_live_uq" ON "join_email_verifications" USING btree ("organization_id","email_digest") WHERE "join_email_verifications"."consumed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "organization_join_requests" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;--> statement-breakpoint
-- Belt and braces: 20260709000000 already revokes the browser roles by default
-- privilege. The table holds digests of one-time codes, so say it explicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "join_email_verifications" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "join_email_verifications" FROM authenticated;
  END IF;
END $$;

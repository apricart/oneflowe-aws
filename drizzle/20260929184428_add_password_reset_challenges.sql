CREATE TABLE "password_reset_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" varchar(16) NOT NULL,
	"subject_id" varchar(128) NOT NULL,
	"code_digest" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"reset_token_digest" varchar(64),
	"reset_token_expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_challenges_subject_type_ck" CHECK ("password_reset_challenges"."subject_type" IN ('user', 'employee')),
	CONSTRAINT "password_reset_challenges_attempts_ck" CHECK ("password_reset_challenges"."attempts" >= 0 AND "password_reset_challenges"."attempts" <= 5),
	CONSTRAINT "password_reset_challenges_digest_shape_ck" CHECK ("password_reset_challenges"."code_digest" ~ '^[0-9a-f]{64}$' AND ("password_reset_challenges"."reset_token_digest" IS NULL OR "password_reset_challenges"."reset_token_digest" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "password_reset_challenges_time_order_ck" CHECK ("password_reset_challenges"."created_at" < "password_reset_challenges"."expires_at" AND ("password_reset_challenges"."reset_token_expires_at" IS NULL OR "password_reset_challenges"."verified_at" <= "password_reset_challenges"."reset_token_expires_at")),
	CONSTRAINT "password_reset_challenges_verification_ck" CHECK (("password_reset_challenges"."verified_at" IS NULL AND "password_reset_challenges"."reset_token_digest" IS NULL AND "password_reset_challenges"."reset_token_expires_at" IS NULL)
        OR ("password_reset_challenges"."verified_at" IS NOT NULL AND "password_reset_challenges"."reset_token_digest" IS NOT NULL AND "password_reset_challenges"."reset_token_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "password_reset_challenges_subject_idx" ON "password_reset_challenges" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "password_reset_challenges_expiry_idx" ON "password_reset_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_challenges_active_subject_uq" ON "password_reset_challenges" USING btree ("subject_type","subject_id") WHERE "password_reset_challenges"."consumed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "password_reset_challenges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "password_reset_challenges" TO oneflowe_runtime;

    -- Only the server's authentication bootstrap context may operate on this
    -- public recovery table. Browser/PostgREST roles receive no policy.
    IF to_regprocedure('oneflowe_rls.auth_bootstrap()') IS NOT NULL THEN
      DROP POLICY IF EXISTS oneflowe_password_reset_select ON "password_reset_challenges";
      DROP POLICY IF EXISTS oneflowe_password_reset_insert ON "password_reset_challenges";
      DROP POLICY IF EXISTS oneflowe_password_reset_update ON "password_reset_challenges";
      CREATE POLICY oneflowe_password_reset_select ON "password_reset_challenges"
        FOR SELECT TO oneflowe_runtime USING (oneflowe_rls.auth_bootstrap());
      CREATE POLICY oneflowe_password_reset_insert ON "password_reset_challenges"
        FOR INSERT TO oneflowe_runtime WITH CHECK (oneflowe_rls.auth_bootstrap());
      CREATE POLICY oneflowe_password_reset_update ON "password_reset_challenges"
        FOR UPDATE TO oneflowe_runtime
        USING (oneflowe_rls.auth_bootstrap())
        WITH CHECK (oneflowe_rls.auth_bootstrap());
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "password_reset_challenges" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "password_reset_challenges" FROM authenticated;
  END IF;
END $$;

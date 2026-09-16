-- Forced password rotation with email verification
-- (plans/OF-KE-forced-password-rotation.md).
--
-- Purely additive: three nullable timestamp columns, no default, no backfill,
-- no index. Existing rows are untouched and every read tolerates NULL, so
-- rolling the application back leaves the columns unused rather than broken.
-- Guarded so the migration is re-entrant, in the style of
-- 20260909120000_add_support_thread_product.sql.
--
-- users.email_verified_at    when the address on the row last received a code
--                            that was entered back.
-- users.password_changed_at  when the person last set their own password. A
--                            must_change_password cleared by an administrator
--                            is not a rotation; this column is what says one
--                            happened.
-- auth_sessions.email_verified_at
--                            the proof that *this* session entered a code,
--                            consumed by the password change it authorises.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN IF NOT EXISTS "email_verified_at" timestamp with time zone;

-- The email domain an organization's self-service applicants must use.
--
-- One nullable column and one check constraint on `organizations`. Every
-- existing row is NULL and passes the constraint, so there is no rewrite and no
-- backfill; the table holds a handful of rows, so the brief lock is negligible.
--
-- NULL means the organization has not set a domain, and the public join form
-- refuses to take a request for it. Deliberately not unique: tenants that share
-- a mail system (K-Electric and K-E-Demo do) share a domain.
--
-- The constraint is `EMAIL_DOMAIN_PATTERN` in lib/organization-email-domain.ts:
-- lower case, two or more labels of [a-z0-9-] that neither start nor end with a
-- dash, and an alphabetic top-level label.
--
-- Rollback:
--   ALTER TABLE organizations DROP COLUMN email_domain;
-- (the constraint goes with the column). See plans/OF-JOIN-email-domain-lock.md.
ALTER TABLE "organizations" ADD COLUMN "email_domain" varchar(253);--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_email_domain_shape_ck" CHECK ("organizations"."email_domain" IS NULL OR ("organizations"."email_domain" = lower("organizations"."email_domain") AND "organizations"."email_domain" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'));

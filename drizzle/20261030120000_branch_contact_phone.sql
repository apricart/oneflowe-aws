-- A branch's contact phone, set by Super Admin or Head Office.
-- See plans/OF-BRANCH-contact-phone.md.
--
-- Additive only. branches.contact_phone is nullable with no default, so adding
-- it does not rewrite the table and every existing branch reads "not provided".
-- varchar(32) matches branch_delivery_addresses.contact_phone; the character
-- and digit rule lives in lib/branch-contact-phone.ts.
--
-- Apply before deploying: the branch reads select contact_phone.
--
-- Rollback (after reverting the code that reads it):
--   ALTER TABLE "branches" DROP COLUMN IF EXISTS "contact_phone";

ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "contact_phone" varchar(32);

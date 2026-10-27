-- The last day an organization's agreed prices are valid for, set by Super Admin.
-- See plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md.
--
-- Additive only. organizations.price_contract_valid_until is a nullable date
-- with no default, so adding it does not rewrite the table and every existing
-- organization reads "no contract date recorded". It is a reminder only: no
-- order, price or catalogue rule reads it. The partial index covers only the
-- dated rows, which the daily reminder sweep and the dashboard alert read.
--
-- Apply before deploying: the organization routes write the column.
--
-- Rollback (after reverting the code that reads it):
--   DROP INDEX IF EXISTS "organizations_price_contract_valid_until_idx";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "price_contract_valid_until";

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "price_contract_valid_until" date;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_price_contract_valid_until_idx"
  ON "organizations" USING btree ("price_contract_valid_until")
  WHERE "price_contract_valid_until" IS NOT NULL;

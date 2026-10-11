-- Optional organization STRN (sales tax registration) number, printed under
-- Bill To beside the NTN. See plans/OF-INVOICE-invoice-ledger.md (D9).
--
-- Nullable with no default, so every existing organization keeps exactly its
-- current data and no code path is forced to supply one. Additive and
-- idempotent: safe to re-run. Apply before deploying — the organization
-- routes and the invoice read the column.
--
-- Rollback (after reverting the code that reads it):
--   ALTER TABLE organizations DROP COLUMN IF EXISTS strn_number;
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS strn_number varchar(32);

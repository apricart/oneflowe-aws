-- Optional organization NTN (tax) number.
--
-- Nullable with no default, so every existing organization keeps exactly its
-- current data and no code path is forced to supply one. Idempotent: safe to
-- re-run.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS ntn_number varchar(32);

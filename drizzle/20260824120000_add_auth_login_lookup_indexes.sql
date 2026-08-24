-- Indexed lookups for the sign-in credential match.
--
-- Both credential providers resolve an account with
--   WHERE (username = $1 OR lower(email) = $1) AND deleted_at IS NULL
-- A plain index on `email` cannot serve `lower(email)`, so that side of the OR
-- was unindexable and Postgres fell back to a sequential scan of the whole
-- account table on every sign-in attempt, successful or not. Indexing the
-- expression makes both branches indexable, which is the precondition for the
-- planner to choose a BitmapOr of two index scans instead.
--
-- Deliberately created without CONCURRENTLY so the statement stays inside the
-- migration transaction, matching every other migration in this directory. On a
-- large live table an operator may create the identical index CONCURRENTLY
-- ahead of the deploy; IF NOT EXISTS then makes this migration a no-op.

-- Partial: soft-deleted accounts can never authenticate, so they do not belong
-- in the index the login path probes.
CREATE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (lower(email))
  WHERE deleted_at IS NULL;

-- The employee table has no soft-delete column, so this one is unconditional.
CREATE INDEX IF NOT EXISTS employee_creds_email_lower_idx
  ON employee_credentials (lower(email));

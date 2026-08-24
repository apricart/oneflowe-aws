-- Durable per-account brute-force lockout.
--
-- Rate limiting alone is keyed partly on the client address, so an attacker
-- rotating source addresses gets a fresh budget against the same account.
-- These counters are keyed on the account only, which is the control PCI DSS
-- 8.3.4 actually asks for, and they survive a Redis outage.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS lockout_until timestamptz;

ALTER TABLE employee_credentials
  ADD COLUMN IF NOT EXISTS failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS lockout_until timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_failed_login_attempts_ck'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_failed_login_attempts_ck
      CHECK (failed_login_attempts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_creds_failed_login_attempts_ck'
  ) THEN
    ALTER TABLE employee_credentials
      ADD CONSTRAINT employee_creds_failed_login_attempts_ck
      CHECK (failed_login_attempts >= 0);
  END IF;
END $$;

-- Supports the operational "which accounts are currently locked" query without
-- scanning every row; partial so it stays small.
CREATE INDEX IF NOT EXISTS users_lockout_until_idx
  ON users(lockout_until) WHERE lockout_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS employee_creds_lockout_until_idx
  ON employee_credentials(lockout_until) WHERE lockout_until IS NOT NULL;

-- The authentication path writes system_logs before any principal is
-- established, so the runtime role needs an unconditional insert grant here.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT INSERT ON TABLE system_logs TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE system_logs_id_seq TO oneflowe_runtime';
  END IF;
END $$;

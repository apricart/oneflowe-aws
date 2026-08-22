-- Durable per-browser registry for JWT sessions. The string subject supports
-- both ordinary UUID users and employee principals such as `emp_42`.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id uuid PRIMARY KEY,
  subject_id varchar(128) NOT NULL,
  organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  last_activity_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT auth_sessions_subject_nonempty_ck
    CHECK (length(trim(subject_id)) > 0),
  CONSTRAINT auth_sessions_time_order_ck
    CHECK (started_at <= last_activity_at AND last_activity_at <= absolute_expires_at)
);

CREATE INDEX IF NOT EXISTS auth_sessions_subject_idx
  ON auth_sessions(subject_id);
CREATE INDEX IF NOT EXISTS auth_sessions_org_idx
  ON auth_sessions(organization_id);
CREATE INDEX IF NOT EXISTS auth_sessions_absolute_expiry_idx
  ON auth_sessions(absolute_expires_at);

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_sessions TO oneflowe_runtime';

    -- The staged NOBYPASSRLS runtime-role design supplies these helpers. Keep
    -- the migration compatible with deployments that have not enabled it yet.
    IF to_regprocedure('oneflowe_rls.owner_allowed(text)') IS NOT NULL
       AND to_regprocedure('oneflowe_rls.auth_bootstrap()') IS NOT NULL THEN
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_auth_session_owner ON auth_sessions';
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_auth_session_insert ON auth_sessions';
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_auth_session_select ON auth_sessions';
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_auth_session_update ON auth_sessions';
      EXECUTE 'DROP POLICY IF EXISTS oneflowe_auth_session_delete ON auth_sessions';
      EXECUTE $policy$
        CREATE POLICY oneflowe_auth_session_insert ON auth_sessions
          FOR INSERT TO oneflowe_runtime
          WITH CHECK (
            oneflowe_rls.owner_allowed(subject_id)
            OR oneflowe_rls.auth_bootstrap()
          )
      $policy$;
      EXECUTE $policy$
        CREATE POLICY oneflowe_auth_session_select ON auth_sessions
          FOR SELECT TO oneflowe_runtime
          USING (oneflowe_rls.owner_allowed(subject_id))
      $policy$;
      EXECUTE $policy$
        CREATE POLICY oneflowe_auth_session_update ON auth_sessions
          FOR UPDATE TO oneflowe_runtime
          USING (oneflowe_rls.owner_allowed(subject_id))
          WITH CHECK (oneflowe_rls.owner_allowed(subject_id))
      $policy$;
      EXECUTE $policy$
        CREATE POLICY oneflowe_auth_session_delete ON auth_sessions
          FOR DELETE TO oneflowe_runtime
          USING (oneflowe_rls.owner_allowed(subject_id))
      $policy$;
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE auth_sessions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE auth_sessions FROM authenticated;
  END IF;
END $$;

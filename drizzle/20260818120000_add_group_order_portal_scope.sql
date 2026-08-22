-- Group Order Portal role scope.
--
-- Adds the GROUP_ORDER_PORTAL role row plus the two assignment tables that
-- define which branches such a user may order on behalf of:
--   * user_group_assignments  — whole groups (dynamic; follows group membership)
--   * user_branch_assignments — individually picked branches
--
-- Purely additive: no existing table, row, or role is modified, so every other
-- role keeps its current behaviour. Idempotent — safe to re-run.

INSERT INTO roles (name, description, permissions)
SELECT 'GROUP_ORDER_PORTAL',
       'Places and manages orders on behalf of multiple branches',
       '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'GROUP_ORDER_PORTAL');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_group_assignments (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id integer NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id),
  created_by_user_id uuid,
  created_at timestamptz DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_group_assignments_user_group_uq
  ON user_group_assignments(user_id, group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_group_assignments_user_idx
  ON user_group_assignments(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_group_assignments_group_idx
  ON user_group_assignments(group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_group_assignments_org_idx
  ON user_group_assignments(organization_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_branch_assignments (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id integer NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  organization_id integer NOT NULL REFERENCES organizations(id),
  created_by_user_id uuid,
  created_at timestamptz DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS user_branch_assignments_user_branch_uq
  ON user_branch_assignments(user_id, branch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_branch_assignments_user_idx
  ON user_branch_assignments(user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_branch_assignments_branch_idx
  ON user_branch_assignments(branch_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_branch_assignments_org_idx
  ON user_branch_assignments(organization_id);
--> statement-breakpoint
-- Match the deny-by-default posture applied to every other public table by
-- 20260709000000_enable_rls_deny_by_default, and grant the staged NOBYPASSRLS
-- runtime role where it exists.
ALTER TABLE user_group_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE user_branch_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oneflowe_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_group_assignments TO oneflowe_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE user_branch_assignments TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE user_group_assignments_id_seq TO oneflowe_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE user_branch_assignments_id_seq TO oneflowe_runtime';
  END IF;
END $$;

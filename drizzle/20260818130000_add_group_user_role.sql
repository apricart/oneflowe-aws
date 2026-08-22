-- Group User role.
--
-- Shares the multi-branch assignment tables introduced by
-- 20260818120000_add_group_order_portal_scope, and additionally decides
-- (approves/rejects) orders for the branches in its scope.
--
-- Purely additive: inserts one role row and nothing else, so no existing role,
-- user, or order behaves differently. Idempotent — safe to re-run.

INSERT INTO roles (name, description, permissions)
SELECT 'GROUP_USER',
       'Approves and manages orders on behalf of multiple branches',
       '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'GROUP_USER');

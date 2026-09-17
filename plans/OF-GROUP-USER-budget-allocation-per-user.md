# Group User budget allocation permission

## Goal

Group Users have no budget allocation access by default. A Super Admin or a Head Office administrator may enable or disable it for a Group User they are allowed to manage, during creation or editing. Enabled Group Users retain the existing assigned-branch and tenant limits.

## Implementation

1. Add a non-null `users.budget_allocation_enabled` boolean with a database default of `false`. Existing users become disabled on migration.
2. Accept the flag only for `GROUP_USER` in the strict user-create and access-update APIs. Reset it when changing to another role. Keep actor hierarchy, tenant checks, audit logging, session revocation, and assignment checks on the existing access routes.
3. Include the flag in the user listing and login/session claims. Show the create and edit switches only for Group Users; show the Budgets menu only when enabled.
4. Block disabled Group Users at the proxy and Budgets page. Check the current user row in the database for every Group User budget list/allocation request so stale sessions or direct API calls cannot bypass the flag. Preserve assigned-branch and tenant checks.
5. Remove the unconditional static `GROUP_USER` budget-management permission; this permission is now per user.

## Verification

- Unit tests for the default, schema validation, role/flag policy, sidebar and proxy behavior.
- API integration tests for default-disabled users, enable/disable transitions, tenant and actor restrictions, assigned versus foreign branches, and unchanged Head Office access.
- Run typecheck, focused unit tests, and the integration suite. Integration tests require a disposable `TEST_DATABASE_URL`; skipped tests must be reported as such.

### Completed checks

- Full unit suite: 2,484 passed, 7 skipped. `tmp/**` is excluded from test discovery because it contains generated dependencies.
- Full integration suite against migrated `oneflowe_test`: 272 passed, 7 skipped.
- Migration validation, diff check, and focused ESLint: passed (ESLint reported existing warnings only).
- Typecheck is blocked by three errors in pre-existing, untracked email-verification test files; no feature-file errors were reported.

## Rollout

Apply the new migration before deploying the application code. No data backfill is needed because the column defaults to `false` for existing users.

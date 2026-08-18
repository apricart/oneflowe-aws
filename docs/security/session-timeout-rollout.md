# Session timeout production rollout

This change is a security cutover, not a rolling-compatible application update. New instances reject pre-cutover JWTs that lack the signed policy and per-browser session ID, while old instances neither create nor validate `auth_sessions`. Do not run a mixed old/new fleet.

## Preflight

1. Schedule a short maintenance/forced-sign-in window and notify users that open sessions will end.
2. Back up the database and record the currently deployed application revision.
3. Set `INACTIVITY_TIMEOUT_MINUTES` to the approved value from 1 through 15 (recommended default: 15). Set `SESSION_VALIDATION_CACHE_TTL_SECONDS` from 0 through 30 (default: 30). The new parser safely clamps legacy in-range configuration, but the secret store should contain the intended value explicitly.
4. Inventory rows where `organization_settings.key = 'session_timeout_minutes'`. The bounds migration normalizes values below 1 to 1 and above 15 to 15 before adding its constraint; obtain business approval for any changed tenant values.
5. Confirm the production `DATABASE_URL` role. The current application uses raw Drizzle connections and does not yet establish the transaction-local context required by the staged `oneflowe_runtime` NOBYPASSRLS template. Do not switch to that staged role as part of this release. If production already uses a NOBYPASSRLS role, stop the cutover until context plumbing is implemented and tested; an owner/BYPASS deployment must still complete the runtime-role CRUD smoke check below.

## Atomic cutover

1. Drain or stop every old application instance. Old settings endpoints accept values that the new database constraint rejects, so they must not write during or after migration.
2. Apply, in order:
   - `20260815120000_enforce_session_timeout_bounds.sql`
   - `20260815121000_create_auth_sessions.sql`
3. Using the exact production runtime database role and transaction context, prove `INSERT`, `SELECT`, and `UPDATE` access to a disposable `auth_sessions` row, then roll back that verification transaction.
4. Deploy the new fleet atomically and keep old instances drained.
5. Expect every pre-cutover session to be redirected to sign in once. This is intentional; silently granting legacy JWTs a new lifetime would weaken the control.

## Smoke checks

- Sign in and sign out as SUPER_ADMIN, HEAD_OFFICE, BRANCH_ADMIN, ORDER_PORTAL, and an employee principal; include MFA-enabled flows.
- Confirm each login creates a distinct registry row, and logout sets only that row's `revoked_at` before clearing the cookie.
- Confirm copied/replayed cookies from a logged-out browser are rejected by a protected page and API.
- Confirm explicit interaction renews activity, passive `/api/auth/session` reads do not emit `Set-Cookie`, exact idle expiry is rejected, and the eight-hour deadline never moves.
- Confirm a tenant timeout decrease applies immediately and a later increase cannot revive an already expired row.
- Confirm organization/branch/employee deactivation rejects the affected session, while other tenants and roles continue normally.
- Simulate registry unavailability in a non-production environment: protected content must remain concealed, activity must not advance, session/API checks must return retryable unavailable responses, and logout must not claim success.

## Monitoring and rollback

Monitor authentication `503`s, registry query latency/errors, login failures by principal type, session-expiry reasons, and `auth_sessions` growth. Registry records contain no token material, but they are security state and need an approved retention/cleanup schedule.

If rollback is required, drain the new fleet before starting the old one. **Rotate `NEXTAUTH_SECRET` (or apply an equivalent global token-version cutover) before any old node accepts traffic.** Old code does not consult `auth_sessions`; without a secret rotation it would accept a still-signed cookie that the new registry had revoked, including a copied post-logout token. The registry table is additive and may remain, but decide explicitly whether to remove the new timeout constraint before restoring an old settings API. All users must sign in again after either direction of rollback; do not attempt to translate or grandfather JWTs between session models.

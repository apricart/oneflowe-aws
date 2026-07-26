# OneFlowe security audit: prompts 5–12

Date: 2026-07-16

Scope: stored/reflected XSS, command injection, SSRF, file uploads, CSV/formula injection, CSRF, rate limiting/resource exhaustion, and Supabase/PostgreSQL runtime roles and row-level security.

## Executive summary

The application-level issues found in the reviewed areas have been remediated and verified with unit tests, TypeScript, static searches, and a production build. The most important changes are:

- Removed the confirmed post-login open redirect/JavaScript URL path and all remaining `dangerouslySetInnerHTML` uses.
- Added centralized safe URL, redirect, filename, CSV, upload, CSRF, body-size, client-IP, and rate-limit controls.
- Replaced shell-adjacent database export behavior with fixed executable/argument execution and a restricted output path.
- Confirmed there is no application server-side fetch path controlled by users, so no application SSRF sink was found.
- Rebuilt image uploads around full decode/re-encode validation and strict raster-only limits.
- Rebuilt HTTP CSV imports as strict, bounded, all-or-nothing transactions and neutralized formula payloads in exports.
- Added cookie-authenticated same-origin mutation enforcement, secure cookie settings, endpoint-specific distributed limits, query caps, and database statement timeouts.
- Prepared—but did not apply—a staged least-privilege/RLS migration and rollback.
- Upgraded Next.js, Drizzle ORM, jsPDF, jsPDF-AutoTable, and NextAuth v4 to targeted compatible security/patch versions.

The highest remaining risk is the database role configuration: all 46 public tables have RLS enabled, but there are zero policies, while the application connects as a table-owning `BYPASSRLS` role. The application therefore currently depends on bypassing RLS. Switching directly to a restricted role would cause an outage; the staged policy and transaction-context work must be tested before cutover.

## Verification status

- `npm test`: 21 test files passed, 129 tests passed.
- Six database concurrency integration tests were skipped because no isolated `TEST_DATABASE_URL` was configured.
- `npx tsc --noEmit`: passed.
- `npm run build`: passed on Next.js 15.5.20 using a temporary build-only `NEXTAUTH_URL=https://localhost`.
- `git diff --check`: no whitespace errors; only the repository's existing LF-to-CRLF conversion warnings.
- Static sink scan: no remaining `dangerouslySetInnerHTML`, `eval`, `new Function`, `exec`, `execSync`, or `shell: true`.

The first production build attempt correctly rejected the HTTP `NEXTAUTH_URL` in `.env.local`. The successful verification did not modify `.env.local`; production must use its real HTTPS origin.

## Prompt 5 — stored and reflected XSS

### Reviewed rendering paths

The review covered:

- Login callback parameters and redirects.
- Product names, descriptions, codes, categories, image URLs, and inventory imports.
- Organization, branch, group, supplier, user, and employee credential fields.
- Order/refund fields, item descriptions, status values, and receipt/PDF content.
- Notifications, analytics/report tables, filters, and scheduled report names.
- HTML email templates for reports, orders, OTPs, and refunds.
- CSV, Excel, and PDF exports.
- Theme initialization, chart styling, and inline style blocks.

Normal JSX text rendering remains protected by React's escaping. No rich-text or Markdown feature was found, so there is no intentionally permitted HTML input requiring an HTML sanitizer.

### Findings and fixes

| Finding | Impact | Resolution |
|---|---|---|
| Login `callbackUrl` accepted values such as `javascript:` or a protocol-relative external URL | Reflected/open-redirect path that could execute script or leave the trusted origin | Added `safeInternalRedirectPath`; both the login page and NextAuth redirect callback now allow only local/same-origin destinations |
| Inline theme initialization used `dangerouslySetInnerHTML` | Avoidable script sink and weaker CSP posture | Moved the constant script to `public/theme-init.js` |
| Receipt/chart style blocks used `dangerouslySetInnerHTML` | Avoidable HTML sink; future interpolation could become executable markup | Replaced with normal React `<style>` content and constant CSS |
| Scheduled report and operational email values were interpolated into HTML | Stored email HTML injection | Added HTML escaping for every user/database-controlled field |
| Product image URL fields accepted active or insecure schemes | `javascript:`, SVG data URLs, or insecure remote sources could become browser injection/tracking paths | Centralized `normalizeSafeImageUrl`: allows same-origin relative URLs, HTTPS URLs, and raster data URLs only; rejects credentials, HTTP, JavaScript, HTML, and SVG data |
| Download filenames contained order/invoice values | Header/file-name injection and traversal risk | Added `safeFilenamePart` and applied it on server and client downloads |
| API responses could be shared-cached | Possible cross-user leakage and reflected-content persistence | API responses are now `private, no-store` |

### Content Security Policy

`middleware.ts` now sets:

- `default-src 'self'`
- `object-src 'none'`
- `base-uri 'self'`
- `form-action 'self'`
- `frame-src 'none'`
- `frame-ancestors 'none'`
- restricted `connect-src`
- production `upgrade-insecure-requests`

Production no longer includes `unsafe-eval`. `unsafe-inline` remains for scripts/styles because the current Next.js hydration/theme/style architecture still requires it. Moving to CSP nonces or hashes is a recommended follow-up.

### XSS test results

- `javascript:alert(1)`, external URLs, protocol-relative URLs, and backslash-based callback tricks resolve to `/dashboard`.
- `data:image/svg+xml` and `data:text/html` image values are rejected.
- HTML/SVG files renamed to PNG/JPEG are rejected by upload validation.
- Formula-bearing spreadsheet strings are treated as data.
- Static searches found no remaining raw HTML or dynamic JavaScript execution sinks.

## Prompt 6 — OS command injection

### Reachable command inventory

Only `scripts/export-db.ts` imports `node:child_process`. It is a local administrative CLI and is not reachable through an HTTP route.

### Remediation

The export script now:

- Executes the fixed `pg_dump` binary with an argument array.
- Uses `shell: false`.
- Restricts output to a plain `.sql` basename in the current working directory.
- Rejects path separators, `..`, shell metacharacters, and invalid extensions.
- Opens output with exclusive-create mode and does not overwrite an existing file.
- Streams output directly to a mode-`0600` file instead of buffering the dump.
- Sets a five-minute timeout and a fixed working directory.
- Deletes a partial output file when `pg_dump` fails.
- Keeps the database password in the child environment instead of command-line text.
- Returns a generic error without echoing credentials or command details.

Examples such as `..\dump.sql`, `dump.sql;whoami`, `$(whoami).sql`, and `dump.sql && calc` fail the basename/allowlist check and are never passed to a shell.

## Prompt 7 — SSRF

### Result

No application SSRF sink was found.

All reviewed `fetch` calls are browser-side calls to same-origin `/api/v1/...` routes or generic client fetch helpers receiving those same-origin paths. There is no server route that accepts a URL and then fetches, follows redirects, probes, imports, screenshots, or proxies it.

Product image URLs may be stored and rendered in a user's browser, but the OneFlowe server does not fetch those URLs. That is not server-side request forgery. The validation still rejects HTTP and active schemes to reduce browser-side abuse.

### Residual considerations

- A remote HTTPS image can make the end user's browser contact an external host. If remote images are not a business requirement, replace the current general HTTPS allowance with an explicit CDN hostname allowlist.
- If a future server-side URL fetch feature is added, it must use a DNS/IP-aware outbound policy that blocks localhost, private/link-local/reserved IPv4 and IPv6 ranges, rechecks every redirect, limits response bytes/time, and permits only approved HTTPS hosts.
- The dependency audit continues to flag newer Next.js 15 advisories, including framework-level network/request handling findings. The project is on the latest targeted compatible 15.x version selected by `npm audit`, but a future patched 15.x release or a tested Next 16/React 19 migration remains required.

## Prompt 8 — file upload security

### Upload/import surface

| Flow | Input | Storage/use |
|---|---|---|
| `/api/v1/upload/image` | Multipart raster image | Sanitized raster data URL stored with product data |
| Global inventory import | Multipart CSV | Validated rows inserted into PostgreSQL |
| Organization assignments import | Multipart CSV | Validated rows inserted into PostgreSQL |
| Inventory import | JSON product records | Validated rows inserted into PostgreSQL |
| Administrative CLI imports | CSV/XLS/XLSX | Local trusted operator workflow |
| Receipt download | Generated PDF | Response only; not an uploaded file |

The reviewed application does not currently upload these files to S3, Supabase Storage, or a public filesystem directory.

### Image controls

`lib/server/upload-security.ts` and `/api/v1/upload/image` now enforce:

- Super-admin authentication and upload-specific distributed rate limiting.
- Four-megabyte decoded input limit, with a five-megabyte request-envelope limit.
- PNG, JPEG, WebP, and GIF only.
- Declared MIME must match detected magic bytes.
- SVG, HTML, and renamed/polyglot text content are rejected.
- Header dimensions are checked before decode.
- Maximum 4096×4096 dimensions and 16 million pixels.
- Full Sharp decode with a decompression/pixel limit.
- Re-encoding to a known raster format, removing metadata and trailing/embedded payload data.
- Random UUID-based generated names; the original filename is not trusted.
- Corrupted/truncated images are rejected.

The sanitizer currently flattens animated GIFs to a sanitized raster frame. This is an intentional security/complexity tradeoff and should be documented in the UI if animation is expected.

### CSV/JSON import controls

- HTTP CSV files: two megabytes and 1,000 records maximum.
- Strict fatal UTF-8 decoding.
- RFC-style quoted comma/escaped quote handling through `csv-parse`.
- Exact required and allowed header sets, with explicit alias groups.
- Unexpected privileged fields such as `role` are rejected.
- Malformed quotes, duplicate rows, missing foreign keys, and existing conflicting rows are rejected.
- Every row is validated before writes.
- Global product/cascade writes are included in the same transaction.
- JSON inventory import is Zod-validated, capped at 1,000 records, and atomic.
- Import batch lookup is restricted to the uploader, fixing a batch-level object authorization issue.
- CLI import files are capped; user/reconcile imports are limited to 10 MB/5,000 rows and branch CSV import to 2 MB/5,000 rows.

### Upload tests

- HTML and SVG renamed as images: rejected.
- MIME/magic mismatch: rejected.
- 5,000-pixel dimension: rejected.
- Truncated PNG header: rejected during full decode.
- Valid one-pixel PNG: decoded and re-encoded successfully.
- Malformed CSV, invalid UTF-8, unknown headers, and excessive rows: rejected.

No antivirus engine was added. Raster decode/re-encode and text-only strict CSV parsing substantially reduce the need for one in the current surface, but any future arbitrary document/archive upload should add malware scanning and isolated object storage.

## Prompt 9 — CSV import/export and formula injection

### Exports covered

Formula neutralization was applied to:

- Global inventory export.
- Orders export.
- Users export.
- Branch, budget, group, order, organization, product performance, and user reports.
- Scheduled report attachments.
- Credential handoff workbooks.
- Legacy import exclusion reports.

`lib/spreadsheet.ts` prefixes an apostrophe when a text value begins—after control characters/leading whitespace—with `=`, `+`, `-`, or `@`. Numeric values remain numeric. CSV creation also applies correct quote escaping.

Payloads such as:

- `=HYPERLINK("https://attacker.example","Click")`
- `+SUM(1,2)`
- `-1+2`
- `@SUM(1,2)`

are exported as inert text.

### Atomicity and partial failure

The three HTTP import paths validate the complete input before mutation and then use database transactions. A failure rolls back the batch instead of leaving partial product, assignment, inventory, audit, or cascade state.

Administrative branch import was also wrapped in a transaction. Existing local operator scripts retain their dry-run/confirmation workflows and now have input size/row caps.

### Remaining spreadsheet dependency risk

The npm `xlsx` package has two high-severity advisories and no fixed npm release:

- Prototype pollution below 0.19.3.
- Regular-expression denial of service below 0.20.2.

Current browser usage writes application-generated workbooks rather than parsing attacker workbooks. Untrusted parsing is limited to local administrative CLI operations with file size/row caps. The preferred follow-up is to migrate XLS/XLSX parsing and writing to a maintained library or require CSV-only imports, then remove `xlsx`.

## Prompt 10 — CSRF and session security

### Controls

- NextAuth's built-in CSRF mechanism remains in place for authentication actions.
- Cookie-authenticated `/api/v1` mutations require browser-confirmed same-origin Fetch Metadata when available, with a strict same-origin `Origin` fallback for older clients. This remains reliable when a trusted reverse proxy gives Next.js an internal request URL.
- Cross-site or unverifiable cookie-authenticated POST/PUT/PATCH/DELETE requests return `403`.
- Bearer/non-cookie clients are not incorrectly subjected to cookie-CSRF logic.
- The auto-fulfill cron no longer performs a state change on `GET`; the infrastructure path uses authenticated `POST`.
- Cron-secret comparison is constant-time.
- Session, callback, and CSRF cookies are explicit `HttpOnly`, `SameSite=Lax`, path-restricted, and `Secure` in production.
- Production uses `__Secure-`/`__Host-` cookie names.
- NextAuth redirects are constrained to local/same-origin URLs.
- API responses are no-store.
- No permissive application CORS policy was found.

### CSRF test results

- Same-origin cookie-authenticated POST: allowed.
- Cross-origin cookie-authenticated POST: blocked.
- Mutation with neither `Origin` nor Fetch Metadata: blocked.
- Safe methods remain unaffected.

### Residual session risks

- Highly destructive super-admin actions do not require a recent password/MFA re-authentication event. Add step-up authentication for destructive inventory cleanup, user privilege changes, credential operations, and large refunds.
- The production build requires an HTTPS `NEXTAUTH_URL`; deployment configuration must satisfy this validation.

## Prompt 11 — rate limiting and resource exhaustion

### Distributed limits

Rate limits use shared Upstash Redis rather than per-instance memory.

| Class | Limit |
|---|---:|
| Login | 15 / 15 minutes |
| Sensitive operations | 10 / 5 minutes |
| OTP send | 5 / 15 minutes |
| OTP verify | 10 / 10 minutes |
| Upload | 20 / hour |
| Import | 5 / 10 minutes |
| Report generation/scheduling | 10 / 10 minutes |
| Order mutation | 20 / minute |
| Refund mutation | 10 / 10 minutes |
| Email/token send | 5 / 10 minutes |
| General write | 50 / minute |
| General API | 100 / minute |
| Search/list | 200 / minute |

Critical classes fail closed if Redis is unavailable. General read/search traffic remains fail open to reduce accidental application-wide outages.

### Identifier and proxy handling

- Authenticated operations use user identifiers where available.
- Anonymous authentication/MFA uses IP plus hashed account identifiers.
- CloudFront's viewer address is preferred.
- Otherwise, the client is selected from the trusted side of `X-Forwarded-For`, controlled by `RATE_LIMIT_TRUST_PROXY_HOPS`.
- Malformed or hostname forwarding values are rejected.
- Deployment must set the proxy-hop count to the actual load-balancer/CDN topology.

### Resource bounds

- Default API body: 1 MB.
- Upload envelope: 5 MB; decoded image: 4 MB.
- Import envelope: 3 MB; CSV: 2 MB/1,000 rows.
- Product mutation endpoints: 7 MB where existing payloads require it.
- Known oversized `Content-Length` is rejected in middleware.
- Route-level file/row/schema limits still apply when transfer encoding omits `Content-Length`.
- PostgreSQL statement/query timeout defaults to 60 seconds through `PG_STATEMENT_TIMEOUT_MS`.
- Orders default to 200 rows and cap at 500 with database-side search.
- Common product/inventory lists cap at 1,000.
- Itemized reports cap at 5,000.
- Users, branches, organizations, suppliers, and employee credentials cap at 500.
- Scheduled reports cap at 100; one processor invocation handles at most 50.
- Order creation retains an idempotency key/fingerprint and database uniqueness protection.
- Refund operations remain transactional and state-validated, but do not yet expose a formal idempotency key.

### Monitoring recommendations

Alert on:

- Sustained `429` rates by endpoint and account.
- Redis failures on fail-closed classes.
- Request-body `413` counts.
- Database timeout frequency.
- Upload decode failures and dimension-limit rejection spikes.
- OTP send/verify anomalies and cross-account IP concentration.
- Import rollback/error rates.
- Report processor backlog and repeated send failures.

## Prompt 12 — Supabase/PostgreSQL role and RLS audit

### Live read-only findings

The live database metadata audit found:

- 46 public tables.
- RLS enabled on all 46.
- RLS forced on zero tables.
- Zero RLS policies.
- 38 tables contain tenant/owner scope columns.
- Current and session role: `postgres`.
- The current role is not marked superuser, but it owns all 46 tables and has `BYPASSRLS`, `CREATEROLE`, and `CREATEDB`.
- `postgres` and `service_role` each have 322 table privilege rows.
- No `anon`, `authenticated`, or `PUBLIC` table grants were observed in the reviewed grant query.

This configuration means application authorization currently exists only in application queries. PostgreSQL RLS is not an active defense-in-depth boundary because the runtime role can bypass it. A non-owner/non-bypass role would see default-deny behavior with zero policies, so changing the connection role before creating/test-driving policies would break the application.

### Prepared staging design

`docs/security/supabase-runtime-role-staging.sql` creates:

- `oneflowe_runtime`: `NOLOGIN`, non-superuser, non-owner, `NOBYPASSRLS` privilege bundle.
- `oneflowe_migrator`: separate `NOLOGIN`, `NOBYPASSRLS` migration bundle.
- Transaction-local context functions for:
  - `oneflowe.role`
  - `oneflowe.user_id`
  - `oneflowe.organization_id`
  - `oneflowe.branch_id`
  - narrowly scoped authentication bootstrap
- Tenant/branch policies for directly scoped tables.
- Tenant-or-global read policies for catalogue rows.
- Owner policies for MFA, sessions, import batches, and schedules.
- Parent-join policies for child tables without direct tenant columns.
- Privileged-only policies for administrative history tables lacking reliable tenant keys.
- Global reference/config read policies and privileged write policies.

The script deliberately does not enable `FORCE ROW LEVEL SECURITY`. The proposed runtime role will not own tables and cannot bypass RLS; forcing RLS during the first migration would mainly risk breaking the owner/migrator path.

`docs/security/supabase-runtime-role-rollback.sql` removes only `oneflowe_` policies, runtime grants, and helper schema objects. It leaves the existing `ENABLE ROW LEVEL SECURITY` flags intact.

### Required staging migration plan

1. Restore a recent production snapshot into an isolated staging database.
2. Apply the staging SQL using the current owner role.
3. Create secret-managed login roles and grant membership in the runtime and migrator bundles.
4. Add an application transaction wrapper that sets all `oneflowe.*` values with `set_config(..., true)`/`SET LOCAL` before tenant queries.
5. Use the authentication-bootstrap context only for the minimal credential lookup needed before a user context exists.
6. Run every role and route against the restricted runtime login:
   - missing context returns no tenant data;
   - same-tenant reads/writes work;
   - cross-tenant reads return no rows;
   - cross-tenant inserts/updates/deletes fail;
   - branch users cannot access sibling branches;
   - head-office users stay within their organization;
   - super-admin/system jobs have the intended global access;
   - import, report, cron, MFA, session, and migration paths work.
7. Run the skipped concurrency/integration suite against the isolated database.
8. Canary the restricted role in a non-production deployment and compare authorization/query error telemetry.
9. Switch production `DATABASE_URL` only after a rollback drill.
10. Transfer object ownership to the migrator path only after all DDL/data migrations have been tested.
11. Consider `FORCE ROW LEVEL SECURITY` only after the ownership and migration model is stable.

### RLS changes not performed

No role, grant, ownership, policy, or RLS change was applied to the live database. Applying the script directly to production without transaction-context integration and staging tests would be unsafe.

## Dependency audit

Targeted upgrades applied:

- Next.js 15.2.8 → 15.5.20.
- `@next/env` 15.2.8 → 15.5.20.
- Drizzle ORM 0.45.1 → 0.45.2, resolving the reported SQL-identifier injection advisory.
- jsPDF 4.1.0 → 4.2.1, removing the prior critical jsPDF path.
- jsPDF-AutoTable 5.0.7 → 5.0.8.
- NextAuth 4.24.13 → 4.24.14.
- Sharp 0.33.5 added directly for upload decoding/re-encoding.

After these upgrades, `npm audit --omit=dev` reports:

- 0 critical.
- 3 high.
- 6 moderate.
- 1 low.
- 10 total production findings.

Remaining groups:

- `xlsx` and its Lodash path: high; no fixed npm `xlsx` release.
- Nodemailer through the NextAuth/Auth.js v4 dependency path: high; a clean fix requires testing a newer Auth.js architecture/dependency stack.
- Next.js/PostCSS: moderate findings remain with no clean non-breaking npm-audit resolution on the current React 18/Next 15 architecture.
- Auth.js cookie/UUID/transitive findings: low/moderate; migration requires authentication regression testing.
- DOMPurify through PDF dependencies: moderate; current application does not expose HTML sanitization or jsPDF active-content methods, but the transitive package should continue to be updated.

Do not run `npm audit fix --force` without a dedicated Next/Auth/React migration branch and full authentication, PDF, report, and browser regression testing.

## Remaining risk and follow-up priority

1. **Critical deployment priority:** stage and complete the restricted database role/RLS context integration. The current role bypasses all database row isolation.
2. **High:** replace `xlsx` or make administrative imports CSV-only.
3. **High:** plan a tested Auth.js dependency migration so the legacy NextAuth transitive advisories can be removed.
4. **High:** monitor Next.js security releases and plan a Next 16/React 19 compatibility migration if no patched supported 15.x release addresses the remaining audit range.
5. **Medium:** remove CSP `unsafe-inline` through nonce/hash-compatible theme and style handling.
6. **Medium:** add recent re-authentication/step-up MFA for destructive super-admin operations.
7. **Medium:** configure an isolated integration database and run the six skipped concurrency tests.
8. **Medium:** verify `RATE_LIMIT_TRUST_PROXY_HOPS`, Redis fail-closed behavior, and alerts in the real CDN/load-balancer topology.
9. **Low/medium:** decide whether remote HTTPS product images should be restricted to a CDN allowlist.
10. **Low/medium:** add formal idempotency keys for refund and other retry-prone financial mutations.


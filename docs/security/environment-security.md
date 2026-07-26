# Environment and infrastructure security

## Code-enforced boundaries

- Next.js server runtime variables are validated by `lib/server/env.ts`, which
  is protected by `server-only`.
- Edge middleware validates only `NEXTAUTH_SECRET`; it does not import the Node
  runtime module.
- The application uses only `DATABASE_URL`.
- Drizzle and schema-changing utilities use only `MIGRATION_DATABASE_URL` and
  never fall back to `DATABASE_URL`.
- The general seed does not create administrators. Administrator creation is a
  separate, confirmed, one-time bootstrap that requires explicit secure input.
- AWS SES does not construct a static credential object. The AWS SDK default
  credential provider chain supplies the workload identity.

## Required deployment migration

1. Create new environment-specific secrets. Do not reuse values across local,
   test, staging, and production environments.
2. Configure every runtime variable listed in `.env.example` except variables
   explicitly marked optional, migration-only, or bootstrap-only.
3. Configure `MIGRATION_DATABASE_URL` only in the trusted migration job or
   operator environment. Do not expose it to the running Next.js service.
4. Replace legacy `DIRECT_URL` migration configuration with
   `MIGRATION_DATABASE_URL`. There is intentionally no compatibility fallback.
5. Rename `NNAWS_REGION` or `NAWS_REGION` to `AWS_REGION`.
6. Remove `NNAWS_ACCESS_KEY_ID`, `NAWS_ACCESS_KEY_ID`,
   `NNAWS_SECRET_ACCESS_KEY`, and `NAWS_SECRET_ACCESS_KEY`. Do not rename these
   permanent keys merely to retain them; move the workload to an IAM identity.
7. Remove unused `JWT_SECRET` and `REFRESH_TOKEN_SECRET` settings after rotating
   them if they were present in a build produced by the old Next.js `env` block.
8. Configure `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` only for the
   controlled bootstrap window, run the confirmed bootstrap once, and then
   delete both variables.

## AWS Amplify Hosting SSR

Amplify Hosting console variables are available to the build container but are
not automatically available to the deployed Next.js SSR compute runtime. The
repository-level `amplify.yml` runs `scripts/write-amplify-runtime-env.mjs`
before `next build`. The script writes an ignored `.env.production` file using
an exact runtime allowlist, validates all required variable names, and never
prints their values.

The allowlist deliberately excludes `MIGRATION_DATABASE_URL`, administrator
bootstrap credentials, and permanent AWS access keys. Do not replace this with
an unrestricted `env` dump and do not restore the custom `env` object in
`next.config.mjs`.

Amplify packages `.env.production` into the server deployment artifact. It is
not included in browser JavaScript because none of these variables use the
`NEXT_PUBLIC_` prefix, but users with deployment-artifact access can read it.
Keep artifact access least-privileged, use separate values per branch, rotate
secrets on exposure, and prefer Amplify secret management or SSM Parameter
Store as the longer-term source of secrets. AWS service access must continue to
use the Amplify SSR Compute IAM role rather than static AWS access keys.

## AWS workload identity

The repository contains no CI workflow with enough account-specific information
to configure OIDC safely. Deployment owners must attach a least-privilege IAM
role to the Amplify/Lambda/ECS/EC2 runtime (as applicable) with only the SES
actions and resources the application needs.

For a future GitHub Actions deployment, create an AWS IAM role trusted by the
GitHub OIDC provider. Restrict the trust policy audience to `sts.amazonaws.com`
and the subject to this repository's exact protected environment or branch.
Store only the role ARN and `AWS_REGION` in CI configuration. After verification,
disable and delete old permanent access keys.

Legacy static AWS credential variable names were detected only in the ignored
local environment file during this refactor; values were not inspected or
recorded. Deployment configuration is external to this repository and must be
audited separately.

## PostgreSQL roles and RLS

The existing RLS migration and operational SQL state that the application uses
the `postgres` table owner/BYPASSRLS role. Therefore code changes alone cannot
claim least privilege or database-enforced tenant isolation.

A read-only privilege check on 2026-07-14 confirmed that the currently
configured runtime role is not a superuser, but it does have `BYPASSRLS` and
owns public tables. The role name and connection details were not recorded.

Use `least-privilege-database-roles.sql.example` as a reviewed starting point.
The intended runtime role is `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`,
`NOCREATEROLE`, `NOREPLICATION`, and `NOBYPASSRLS`, with schema usage, DML on
required tables, and sequence usage only. The migration role receives reviewed
DDL ownership/privileges and is available only to migration jobs.

Important: current tables have deny-by-default RLS with no application policies.
A `NOBYPASSRLS` runtime role will be denied until tenant-aware policies and a
trusted per-transaction tenant context are designed, reviewed, migrated, and
tested. Do not switch `DATABASE_URL` prematurely, do not disable RLS, and do not
add permissive policies simply to make the application work. Until this manual
database work is complete, application-level tenant checks remain the active
isolation layer and the privileged database role remains a production risk.

## Rotation

Builds produced before removal of the Next.js custom `env` block may contain
server configuration in browser JavaScript. Rotate the runtime database
credential, Upstash token, NextAuth secret, cron secret, administrator bootstrap
credential, and any AWS permanent access keys that may have been used. Rotation
of `NEXTAUTH_SECRET` invalidates existing sessions and must be coordinated.

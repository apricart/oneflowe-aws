# OF-ORDERS — Organization-level "Require order approval" switch

## Requirement

Some organizations do not want their orders to wait for a Branch Admin, Head
Office or Group User decision. A Super Admin must be able to choose, per
organization, when creating or editing it, whether new orders need approval or
are approved the moment they are created.

## Decisions

- **Column** `organizations.order_approval_required boolean NOT NULL DEFAULT true`.
  Additive; every existing tenant keeps today's workflow until a Super Admin
  switches it off.
- **Who may change it**: `SUPER_ADMIN` only — the organization create/PATCH
  routes are already `requireApiRole(["SUPER_ADMIN"])`, and the field is added
  to the strict Zod schemas in `lib/server/mutation-validation.ts` as a boolean.
  A change is audited as `UPDATE_ORDER_APPROVAL_POLICY` with the previous and
  new value.
- **Applies to future orders only.** Orders already `PENDING` stay pending and
  are decided as before. The configured approver role is kept (greyed out in
  the UI) so switching approval back on restores it.
- **One resolver for both creation paths** —
  `lib/server/order-creation-approval.ts` (`resolveInitialOrderApproval`) is
  called by `POST /api/v1/orders` and by each branch child of a Group Order
  Portal submission (`lib/server/group-order-creation.ts`). It reads the
  policy under `FOR SHARE` on the organization row; the PATCH holds
  `FOR UPDATE`, so an order commits wholly under the old or the new policy.
  No inverse lock order exists (PATCH never locks budgets), so no deadlock.
- **"Approved" means fulfilment-ready**, not just a status string. An
  auto-approved order is inserted with `status = APPROVED`, `approvedAt`, and a
  generated fulfilment token + bcrypt hash — the same columns
  `approveOrder` in `lib/server/order-decision-service.ts` writes.
  `approvedByUserId` stays null: no person approved it. Every reader of that
  column already treats it as nullable.
- **Budget and stock are unchanged.** Approval has no ledger side effect in the
  manual path (the hold is taken at creation and settled at fulfilment), so
  creating an order approved leaves the ledgers identical.
- **Notifications.** A pending order still sends `ORDER_CREATED` to its
  approvers. An auto-approved order has nobody to ask, so it sends
  `ORDER_APPROVED_ADMIN` to Super Admins (`queueSuperAdminAutoApprovalNotifications`)
  — the same event a manual approval raises, so the Super Admin still learns
  the order is ready for review. The payload carries `autoApproved: true` so the
  email reads "approved automatically" rather than naming an approver role.
- **Responses** strip `approvalTokenHash` from the create and idempotent-replay
  responses. The raiser may see its own approved order's token, as
  `canViewFulfillmentToken` already allows.

## Consequences to be aware of

- A requester can edit only a `PENDING` order, so orders in an auto-approve
  tenant cannot be edited after submission; a refund request is the route.
- Approve/reject on an auto-approved order returns the existing
  "cannot approve order in APPROVED state" response.

## Tests

- Unit: `lib/server/order-creation-approval.test.ts`,
  `lib/email/order-lifecycle.test.ts`,
  `lib/server/organization-approver-validation.test.ts`,
  `app/(portal)/organizations/page.test.tsx`.
- Contract: `lib/server/order-auto-approval-contract.test.ts` (both paths use
  the resolver and notify Super Admins; token hash not returned; deploy-test
  runs integration before deploying).
- Integration (Postgres): `tests/integration/order-auto-approval-policy.test.ts`
  (resolver under a real lock) and `tests/integration/order-auto-approval-api.test.ts`
  (real routes: Head Office 403, non-boolean 400, Super Admin change audited
  and tenant-isolated, existing pending order untouched, single-branch and
  group orders created APPROVED with a verifiable token and a Super Admin
  notification, switching back restores PENDING).
- CI: `.github/workflows/deploy-test.yml` already migrates a throwaway Postgres
  and fails on skipped integration suites before building and deploying, so
  both integration files run on every test-environment deploy.

## Database impact and rollout

- Migration `drizzle/20260930150000_add_order_approval_required.sql`
  (journal `when` = previous + 3600000). `ADD COLUMN ... DEFAULT true` on
  Postgres 11+ is metadata-only — no table rewrite, brief lock.
- **Apply the migration to the staging and production databases before the
  code reaches them.** Both creation paths read the column, so code without
  the column fails every order. No deploy workflow migrates a real database.
- Rollback: redeploy the previous image; the column can stay (default true is
  the old behaviour). Drop it only in a later release.

# Mass Assignment and Role Escalation Audit

Date: 2026-07-15

## Scope and method

The audit covered all application API routes plus server/database helpers and searched for direct request-object writes, request-object spreads, `Object.assign`, dynamic patches, and all Drizzle create/update operations. No live request object is now passed directly to `.set()` or `.values()`. A regression test scans every `app/api/**/route.ts` file for those patterns.

## Risky endpoints found and remediated

| Endpoint | Finding | Remediation |
| --- | --- | --- |
| `POST /api/v1/users` | A Head Office administrator could create another Head Office user (a peer-level role). Organization/branch consistency was not checked. | Strict role enum, strict body schema, only roles below the caller, organization existence check, and branch-to-organization check. `SUPER_ADMIN` remains bootstrap-only. |
| `PATCH /api/v1/users/:id` | Profile, password, active state, MFA, organization, and branch changes shared one body. A Head Office caller could reassign an in-tenant target to another tenant or branch. Peer password resets were possible. | The route is profile/password-only. Peer/higher users cannot be managed. Access fields are rejected as unknown. |
| `PATCH /api/v1/users/:id/access` | New dedicated administrative operation. | Rejects self-access changes; prevents peer/upward role assignment; protects Super Admin accounts; validates role enum, organization, branch ownership, and tenant scope; revokes sessions after every access change. |
| `POST /api/v1/suppliers` | Head Office could submit another organization's `organizationId`/`branchId`. | Strict schema, caller organization enforcement, and branch-to-organization validation. Supplier updates cannot change owner fields. |
| `PATCH /api/v1/branches/:id` | `groupId` could reference a group from another tenant. | Strict schema and same-organization active-group validation. |
| `POST /api/v1/orders` | Head Office could select another tenant in the request body. | Strict order schema; Head Office organization is session-scoped; branch must belong to the resulting organization. Prices, totals, creator, approval, payment, and refund fields remain server-computed. |
| `PUT /api/v1/orders` | Generic multi-action endpoint lacked complete role/resource checks and duplicated approval/fulfillment operations. | Disabled with `405`; callers must use dedicated approve, reject, and token-protected fulfill routes. |
| `PATCH /api/v1/orders/:id` | Generic status changes could bypass the dedicated fulfillment approval-token control. | Removed. |
| `PUT`/`DELETE /api/v1/inventory/global-products/:id` | Any authenticated user could update product price/status or deactivate a product because the documented Super Admin check was absent. | Explicit Super Admin check, strict schema, and direct field mapping. |
| `PUT /api/v1/head-office/branch-assignments/toggle` | Head Office could supply another tenant's `organizationId`; group-derived branches were not explicitly constrained by organization. | Head Office organization is session-scoped; branches are filtered by organization; strict schema added. |
| `POST`/`PUT /api/v1/roles/permissions` | Permission keys and bodies were not strict; arbitrary unknown permission strings could be persisted. | Strict schemas, existing-role check, explicit `Permission` enum membership, and duplicate removal. Super Admin-only authorization remains. |
| Financial/product mutation routes | Bodies were manually validated but generally did not reject unrelated hidden fields, and several used conditional object spreads. | Strict schemas and explicit mappings added for orders, refunds, payment/fulfillment state, money/quantity budgets, global products, organization products, and branch products. |

## Allowed mutation fields

| Operation | Allowed request fields |
| --- | --- |
| Create user | `firstName`, `lastName`, `email`, `username`, `password`, `role`, `organizationId`, `branchId`, `phone`, `employeeId`, `imprestHolder`, `contactPerson`, `location`, `address`, `mfaEnabled`, `isActive` |
| Update user profile | `firstName`, `lastName`, `email`, `username`, `phone`, `employeeId`, `imprestHolder`, `contactPerson`, `location`, `address`, `password` |
| Update user access | `role`, `organizationId`, `branchId`, `isActive`, `mfaEnabled` |
| Create/update branch | Create: `organizationId`, `name`, `province`, `city`, `address`, `costCenterId`, `status`. Update: `name`, `province`, `city`, `address`, `costCenterId`, `status`, `groupId`. |
| Create/update organization | Create: `name`, `code`, `status`, `budgetAllocationMode`, `priceVisibility`. Update: `name`, `code`, `status`, `budgetAllocationMode`. |
| Create/update supplier | Create: `organizationId`, `branchId`, `name`, `address`, `contact`, `email`, `description`. Update: `name`, `address`, `contact`, `email`, `description`. |
| Create order | `items[].organizationInventoryId`, `items[].quantity`, `organizationId`, `branchId`, `notes` |
| Dedicated order transitions | Approve: no body fields. Reject: `reason`. Fulfill: `approvalToken`. Payment: `paymentStatus`. Fulfillment progress: `fulfillmentStatus`. |
| Request/process refund | Request: `items[].id`, `items[].quantity`, `reason`. Admin process: `orderId`, `items[].itemId`, `items[].quantity`, `reason`, `refundRequestId`. Cancel: literal `action: "cancel"`. |
| Money budget | `branchId`, `amountAllocatedCents`, `type`, `setAbsolute`, `resetAddons`, `reason` |
| Quantity budget | Reset: `organizationId`, `branchIds`, `groupIds`, `period`. Allocate: `branchId`, `type`, `items[].branchInventoryId`, `items[].quantity`, `reason`. |
| Global product | Product code/name/description/category/image/base price/unit/status/stock/quantity settings/metadata and documented discount fields. Only Super Admin can mutate. |
| Organization product | `organizationProductId`, `isEnabled`, `customName`, `customDescription`, `customPrice`, `customImageUrl`, `tags`, `priority` |
| Branch product | `branchProductId`, `isAvailable`, `customNotes` |
| Role permissions | Create: `roleId`, `permissionKey`, `allowed`. Replace: `roleId`, `permissions`. |
| Organization setting | `organizationId`, `key`, `value`; sensitive keys retain additional Super Admin-only checks. |
| Employee credential | Create: `email`, `password`, `firstName`, `lastName`, `mfaEnabled`. Update: `id`, `email`, `password`, `firstName`, `lastName`, `isActive`. Owner/creator IDs come from the session. |
| Group | Create: `organizationId`, `name`, `description`. Update: `name`, `description`. Branch membership: `branchIds`, `newlyAddedBranchIds`. |

## Sensitive fields protected

- Role and permissions: explicit enums/permission catalog, lower-than-caller role hierarchy, protected Super Admin accounts, no self-access changes.
- Tenant and branch ownership: request IDs are either session-forced or checked against database ownership before writes.
- Approval and ownership: `approvedBy*`, `processedBy*`, `createdBy*`, `updatedBy*`, and assignment actor IDs are always derived from the authenticated session or server workflow.
- Financial state: prices, line totals, order totals, refund amounts, held/spent budget values, and payment/refund/order statuses are calculated or changed only by dedicated operations.
- Active/status flags: accepted only on documented administrative routes with role and tenant checks.

## Validation schemas added

Strict Zod schemas are centralized in `lib/server/mutation-validation.ts`. They cover user creation/profile/access, organizations, branches, suppliers, orders and transitions, refunds, budgets, products and inventory overrides, role permissions, settings, employee credentials, groups, and branch-assignment toggles. Unknown fields produce a `400` response naming the unknown key(s).

## Authorization checks added

- Strict role hierarchy with `canAssignRole` and `canManageUser`.
- Self-access-change prohibition.
- Super Admin creation/management excluded from normal HTTP user-management operations.
- Head Office tenant reassignment prohibition.
- Database validation that assigned branches and groups belong to the selected organization.
- Session revocation and `sessionVersion` bump after role, tenant, branch, active-state, or MFA access changes.
- Super Admin enforcement on global product update/deactivation.
- Dedicated order transitions; generic status mutation removed/disabled.

## Tests and results

- `lib/server/mass-assignment.test.ts`: 11 focused tests covering hidden role/tenant/permission fields, self escalation, peer/upward assignment, tenant reassignment, branch/owner injection, approval/creator injection, financial-field injection, role enum rejection, and a repository-wide direct-assignment pattern guard.
- Full Vitest suite: **14 files, 96 tests passed**.
- TypeScript: `npx tsc --noEmit` passed.
- Production build: passed with temporary build-only `AWS_REGION=us-east-1` and `NEXTAUTH_URL=https://localhost`. The first build attempt correctly failed because the local production environment lacks `AWS_REGION` while SES is configured and uses a non-HTTPS `NEXTAUTH_URL`.
- `git diff --check`: passed.

## Remaining concerns

- The tests exercise schemas, pure authorization policy, and repository patterns; they do not run authenticated HTTP requests against a disposable PostgreSQL database. End-to-end tests should be added for transactional behavior and session revocation.
- Some lower-risk catalog/import/report-schedule routes retain manual validation plus explicit field mapping and safely ignore unknown fields instead of using strict Zod schemas. The static guard prevents direct request-object database writes, but consistent strict schemas would improve error reporting.
- Database role names are stored as strings rather than a database enum/check constraint. HTTP input is validated, but a direct database client or privileged script could still create an invalid role row.
- Super Admin provisioning remains intentionally available only through the controlled bootstrap CLI; access to that operational path and its environment variables must remain restricted.


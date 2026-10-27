# OF-PRICE-CONTRACT — Organization price contract validity

## Objective

An organization's agreed prices (the products assigned to it at its price) are
valid for a period. Super Admin records the last day of that period on the
organization. As it runs out, Apricart is reminded to review the prices. It is
a **reminder only**: nothing about ordering, pricing or the catalogue changes
when a contract expires.

## Acceptance criteria

1. Create Company and Edit Company (Super Admin) have an optional
   **Price contract valid until** date. Blank = no contract date recorded.
2. The Organizations list shows, per organization with a date:
   - "Prices valid to <date>" while more than 7 days remain,
   - "Contract expires in N days" (amber) in the last 7 days (0 = today),
   - "Price contract expired" (red) once the date has passed.
3. When a contract enters its last 7 days, every active Super Admin and every
   active Apricart Executive **assigned to that organization** (Order Desk
   Team → `apricart_executive_assignments`) is emailed once, and Super Admins
   get an in-app (bell) notification. Changing the date re-arms the reminder;
   re-saving the same date does not repeat it.
4. The Super Admin dashboard and the executive workspace show an embedded alert
   listing every organization (in the viewer's reach) whose contract is
   expiring within 7 days or has expired.
5. No order, price, catalogue or budget path reads the date. Customers are
   never blocked or told.

## Decisions

- **Executives: assigned only** (decided 2026-10-27 with the user). An
  organization with no assigned executive reminds Super Admins only.
- The date is a Karachi calendar day; the contract is valid **through** it.
  `daysLeft = validUntil − today(Karachi)`; expiring when `0 ≤ daysLeft ≤ 7`,
  expired when `daysLeft < 0`.
- Only `active` organizations are reminded or listed in the dashboard alert;
  the Organizations list flags every organization regardless of status.
- Executives have no bell (their API allowlist excludes `/api/v1/notifications`),
  so their in-app notice is the embedded alert on `/executive`; no
  notification row is written for them.
- Head Office and every tenant role do not see the date: the organization GET
  routes strip it for anyone but Super Admin.

## Architecture

| Piece | Location |
|---|---|
| Pure rules: status, days left, event key, copy, roles, date validation | `lib/price-contract-validity.ts` |
| Due organizations, recipients, queueing, alert reads, send-time re-check | `lib/server/price-contract-reminders.ts` |
| Email body | `lib/email/price-contract.ts` |
| Outbox dispatch | `deliverClaimedEmail` in `lib/server/order-notifications.ts` |
| Daily sweep | `POST /api/v1/organizations/cron/price-contract-reminders` (CRON_SECRET) + `infra/price-contract-reminder-scheduler.yml` |
| Alert read | `GET /api/v1/price-contracts/alerts` (Super Admin, Apricart Executive) |
| UI | `components/organizations/price-contract-field.tsx`, `components/price-contracts/price-contract-alerts.tsx`, Organizations page, Super Admin dashboard, executive workspace |

### Queueing

`queueDuePriceContractReminders(client, now)` selects active organizations with
`price_contract_valid_until BETWEEN today AND today + 7`, and for each inserts
under event key `PRICE_CONTRACT_EXPIRING:<orgId>:<validUntil>:<userId>`:

- a `notifications` row per Super Admin (`targetRole = SUPER_ADMIN`);
- an `email_outbox` row per Super Admin and assigned executive.

Both inserts are `ON CONFLICT DO NOTHING`, so the sweep is idempotent and safe to
run any number of times. Newly inserted outbox keys are sent immediately.

It runs from the daily scheduler **and** whenever the alert endpoint is read
(the way budget reads settle add-ons): the reminder therefore goes out even
before the EventBridge schedule is deployed, the first time any Super Admin or
executive opens their dashboard in the window.

### Send-time re-check

An outbox row is sent only if the recipient is still active with the same role
(and for an executive, still assigned to the organization), the organization is
still active, still carries the same date as the payload, and that date has not
passed. Otherwise it is skipped.

## API

`GET /api/v1/price-contracts/alerts` →
`{ reminderDays: 7, items: [{ organizationId, name, code, validUntil, daysLeft, status: "expiring" | "expired" }] }`,
≤ 200 rows, expired first then soonest. 401 no session, 403 any other role.
Executive reach = its assignments, account re-read active. Added to
`APRICART_EXECUTIVE_API_RULES`.

`POST /api/v1/organizations/cron/price-contract-reminders` — bearer
`CRON_SECRET`; `{ "dry_run": true }` previews. 401 otherwise.

`POST /api/v1/organizations`, `PATCH /api/v1/organizations/[id]` accept
`priceContractValidUntil: "YYYY-MM-DD" | null | ""` (blank/null clears on PATCH).
Real calendar day, 2000-01-01..2100-12-31. A past date is allowed (recording an
already-lapsed contract).

## Data

Migration `20261103120000_organization_price_contract_validity`:
`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS price_contract_valid_until date;`
plus a partial index on it. Nullable, no default — no table rewrite, every
existing organization reads "no contract date". Rollback: drop the index and
column after reverting the code.

## Security

- Writes: Super Admin only (existing route gates). Field validated by Zod;
  allowlisted in the PATCH copy, never a spread.
- Audit: `CREATE_ORGANIZATION` carries the date; a change writes
  `UPDATE_ORGANIZATION_PRICE_CONTRACT_VALIDITY` with before/after in the PATCH
  transaction.
- Reads: alert endpoint role-checked in the handler as well as the proxy; the
  executive's organizations come from its assignment rows, never the request.
- Cron: bearer secret, same as the other sweeps.
- Email content: organization name, code and date only — no prices.

## Tests

- Unit: `lib/price-contract-validity.test.ts` (status boundaries, days left,
  validation, event key).
- Unit: alert component and field component render.
- Contract: executive allowlist test covers the new handler.
- Integration: `tests/integration/price-contract-reminders.test.ts` — create and
  PATCH with the field (role matrix, audit, clear), GET stripping for Head
  Office, alert reach (Super Admin all, executive assigned only, other roles
  403), queueing idempotency and re-arm on date change, send-time skip.

## Risks

- Low. Additive column; no ordering path reads it. Worst case a reminder is not
  sent (scheduler not deployed and nobody opens a dashboard) or is sent twice
  (impossible under the unique event keys).

## Rollout

1. Apply `20261103120000` to prod before deploying (the org routes write it).
2. Deploy.
3. Deploy `infra/price-contract-reminder-scheduler.yml` (daily 09:00 PKT).

# OF-WAREHOUSE — Select all / Unselect all in the "By city" tab

Builds on `plans/OF-WAREHOUSE-city-assignments.md` and
`plans/OF-WAREHOUSE-city-assignments-by-organization.md`.

## Problem

On Warehouse Team → Branches → By city, Super Admin ticks organizations and
then cities one at a time, and every tick is its own request. Serving fifty
organizations means fifty clicks, and fifty requests also exceed the 50-per-minute
`write` rate limit, so a client-side loop over the single-tick endpoint cannot
do it either.

## Change

- **UI** (`components/warehouse/warehouse-team-card.tsx`): above each list,
  "Select all" / "Unselect all" (organizations) and "Assign all" / "Unassign all"
  (cities), each showing how many rows it would change. They act on the rows
  the filter shows (labelled "… shown" while a filter is typed), never on hidden
  ones. "Assign all" skips a city outside the chosen organizations, which can
  only be withdrawn. Withdrawing asks for confirmation first; choosing and
  assigning do not. Which rows change is `bulkChange`, and the batch split is
  `inBatches` (`lib/warehouse-team-view.ts`).
- **API**: the two existing routes accept a bulk body as well. No new route, so
  `proxy.ts` and the sweeps need no change.
  - `PUT /api/v1/warehouse-team/[userId]/city-organizations` with
    `{ organizationIds: number[], assigned }`: 1..200 JSON integers, no repeats
    (`warehouseCityOrganizationBulkUpdateSchema`).
  - `PUT /api/v1/warehouse-team/[userId]/cities` with
    `{ cities: string[], assigned }`: 1..`WAREHOUSE_CITY_BULK_MAX` (50) cities
    (`warehouseCityAssignmentBulkUpdateSchema`). Fifty of the longest cities is
    about 5.3 KB, under the WAF's 8 KB body limit, and the dialog sends a longer
    list in batches of 50.
  - The single bodies are unchanged, and each schema still refuses the other's key.
- **Server** (`lib/server/warehouse-team.ts`): `setWarehouseCityOrganizations`
  and `setWarehouseCities`. Each runs in one transaction under the same
  `FOR UPDATE` on the target account as a single tick (`lockWarehouseTarget`,
  now shared by all four writers), and is all or nothing:
  - an unknown organization refuses the whole request (400);
  - a newly assigned city with no branch in the chosen organizations refuses the
    whole request (400), exactly the rule a single tick applies;
  - going over a per-user cap is 409.

  A row already in the wanted state changes nothing. Cities are normalised only
  in SQL (`branchCityKeySql` over `unnest`), as before.

## Audit

Each organization or city that actually changes gets the audit row a single tick
would have written, with the same action, the same `organizationId` (set for an
organization, null for a city) and before/after following on in order, plus
`context.bulk: true`. The trail, and each tenant's Head Office activity log,
therefore read exactly as if the rows had been ticked one by one.

## Authorization and isolation

No change: Super Admin only (`requireApiRole(["SUPER_ADMIN"])`), a target that
is not an undeleted warehouse account is 404, and rate limiting applies per request.

## Tests

- `lib/warehouse-access.test.ts`: the bulk schemas' bounds, and that the
  largest admitted city body fits under 8 KB.
- `lib/warehouse-team-view.test.ts`: `bulkChange`, `inBatches`.
- `components/warehouse/warehouse-team-card.test.tsx`: one request per action,
  the filter respected, the confirmation, the outside-city rule, a refusal
  leaving the reach unchanged.
- `tests/integration/warehouse-api.test.ts` ("changing several organizations or
  cities at once"): the role matrix, malformed bodies, all-or-nothing refusals,
  per-row audit, idempotent repeats, and the reach following at once.

## Database

None. No migration.

## Rollback

Revert the commit. The single-tick bodies are untouched, so nothing else depends
on the bulk form.

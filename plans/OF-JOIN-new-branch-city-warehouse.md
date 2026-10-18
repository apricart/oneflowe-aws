# OF-JOIN — A new branch's city from a list, and its warehouse at approval

Builds on `plans/OF-JOIN-department-signup-multi-user.md`,
`plans/OF-WAREHOUSE-warehouse-fulfilment-role.md` and
`plans/OF-WAREHOUSE-city-assignments.md`.

Status: implemented 2026-10-18.

## What is being asked

When Head Office approves a department sign-up that creates a branch:

1. **The city is required and chosen from a searchable list of Pakistan's
   cities**, not typed.
2. **Whichever warehouse serves that city serves the new branch**, from the
   moment the approval commits.

Before this, the city was free text, and a new branch reached no warehouse
until Super Admin assigned one on Warehouse Team. Its approved orders appeared
in no warehouse queue and sent no warehouse notification, and nothing told
anyone.

## Decisions

| # | Decision |
|---|---|
| C1 | **The list is a code constant**, `PAKISTAN_CITIES` in `lib/pakistan-cities.ts`: each city with its province, one spelling each. Provinces: Punjab, Sindh, Khyber Pakhtunkhwa, Balochistan, Islamabad Capital Territory, Gilgit-Baltistan, Azad Jammu and Kashmir. No dependency is added. A missing town is added to the list; until then Head Office picks the nearest listed city. |
| C2 | **The server refuses a city not on the list** (400, `departmentJoinDecisionSchema`, and again in `createRequestedBranch`), and stores the list's own spelling. The page is presentation. |
| C3 | **The province follows the city.** The dialog fills it in and shows it read-only; the server refuses a province that is not the city's (400), rather than silently replacing what was sent. |
| C4 | **"Serves the city"** means an active, undeleted `WAREHOUSE` account that either holds the city as a whole-city assignment (`warehouse_city_assignments`), or is assigned one by one to an active branch in that city, **in any organization**. A warehouse is Apricart's and its reach is geography; city assignments are already cross-organization. Matched by `branchCityKeySql`, in SQL, on both sides, as every warehouse city comparison is. |
| C5 | **A whole-city warehouse needs no write**: the branch is in its reach the moment it exists. A warehouse that serves the city through single branches gets a `warehouse_assignments` row for the new branch. **Every** such warehouse is given it; none is chosen over another. |
| C6 | **No warehouse serves the city → the approval still goes through.** The dialog warns Head Office before approving, and Super Admin assigns one later, as today. Delivery coverage never blocks a person from joining. |
| C7 | **Head Office never learns who the warehouse is.** The review answers, per listed city, only how many Apricart warehouses serve it; no account, name or email. The activity log already anonymises Apricart staff to Head Office (`lib/activity-log-reach.ts`). |
| C8 | Only branches **created by this approval** are attached. A CRC mapped onto an existing branch, and an existing branch picked by name, keep whatever reach they have. |
| C9 | `region` stays Super Admin's (`branches_region_ck`; both branch write routes refuse it from Head Office). Not derived from the city. |

### The authorization change

Until now only Super Admin wrote `warehouse_assignments`
(`replaceWarehouseBranches`). The join approval, a Head Office action, now
writes one too. It is fenced so it cannot be used to steer a warehouse:

* the branch is one the same transaction has just created in Head Office's own
  organization;
* the warehouses are derived on the server from assignments Super Admin
  already made; nothing in the request names a warehouse or a city key;
* it only adds, never removes, and only for a warehouse that already serves
  that city;
* the change is audited exactly as Super Admin's is
  (`UPDATE_WAREHOUSE_ASSIGNMENTS`, before/after branch ids in that
  organization), with `source: DEPARTMENT_JOIN_APPROVAL` and the join request id.

`lib/warehouse-access.test.ts` now lists the modules allowed to insert into
`warehouse_assignments`: `lib/server/warehouse-team.ts` and
`lib/server/warehouse-city-coverage.ts`.

## Design

* `lib/pakistan-cities.ts` (pure): `PAKISTAN_PROVINCES`, `PAKISTAN_CITIES`,
  `findPakistanCity` (list membership, case and spacing aside; not a warehouse
  key comparison).
* `lib/join-department-signup.ts`: `newBranchDraftErrors` also says "Choose the
  city from the list" and names a province that does not match.
* `lib/server/mutation-validation.ts`: the decision schema's new-branch city
  must be listed, and its province the city's.
* `lib/server/warehouse-city-coverage.ts` (server-only):
  * `loadWarehouseServedCities(executor, names)`: the listed cities an active
    warehouse serves, with how many, for the review;
  * `attachNewBranchToCityWarehouses(tx, …)`: inside the approval. Reads the
    serving warehouses, takes their user rows `FOR SHARE` in id order (Super
    Admin's `replaceWarehouseBranches` takes the same row `FOR UPDATE`, so a
    replacement cannot delete the new row behind the approval), re-reads their
    assignments under the lock, inserts and audits.
* `lib/server/organization-join-department.ts`: the review carries
  `warehouseCities`; the approval canonicalises the city, then attaches each
  created branch after the branches are resolved. The join audit records
  per-branch counts (`warehouseCoverage`), never accounts.
* `components/join/pakistan-city-combobox.tsx`: Popover + Command, as
  `components/ui/category-selector.tsx`; `modal` so the list scrolls inside the
  dialog.
* `components/join/department-join-review-dialog.tsx`: the city picker, the
  province read-only, and the coverage line under the city.

### Lock order in the approval

Request `FOR UPDATE` → approvers' accounts `FOR UPDATE` → organization
`FOR SHARE` → branch advisory lock → serving warehouse accounts `FOR SHARE`.
Nothing that takes a warehouse account's lock takes any of the earlier ones.

## Tests

* Unit: the list (unique spellings, known provinces, lookup); the draft errors;
  the decision schema (unlisted city, mismatched province, canonical spelling).
* Contract: the writers of `warehouse_assignments`.
* Component: the dialog picks the city from the list, fills the province, shows
  coverage, and sends the canonical city.
* Integration (`tests/integration/organization-join-department.test.ts`): a
  whole-city warehouse reaches the new branch with no row written; a warehouse
  serving the city through a branch in another organization is given the branch,
  audited; an inactive warehouse is not; an unlisted city and a mismatched
  province are 400 and create nothing; the review counts serving warehouses and
  names none.

## Risk and rollback

* A town missing from the list blocks that approval until it is added or a
  nearby city is chosen (C1).
* Matching is by spelling. An existing branch typed "Wah Cantt" does not match
  the listed "Wah Cantonment", so a warehouse serving it by that branch is not
  found. Super Admin's whole-city assignment uses the same key, so the fix is
  the same there: correct the branch's city.
* Rollback: revert the code. Assignments already written are ordinary rows
  Super Admin can withdraw on Warehouse Team. No migration.

## Not in scope

* `POST /api/v1/branches` (Super Admin's and Head Office's own branch creation)
  keeps a typed city.
* Telling Super Admin when an approval created a branch no warehouse serves.

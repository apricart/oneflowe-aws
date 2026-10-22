# OF-JOIN — The applicant gives a new branch's city and province

Builds on `plans/OF-JOIN-department-signup-multi-user.md` and
`plans/OF-JOIN-new-branch-city-warehouse.md`.

Status: implemented 2026-10-19.

## What is being asked

On the department sign-up (`/join`), when an applicant adds a branch that is
not listed, the form asked only for the new branch's name and its CRC. Head
Office then had to find out its city at review, from nothing. **The applicant
now gives the city and province too.**

## Decisions

| # | Decision |
|---|---|
| A1 | **The city is required for every new branch on the public form** and chosen from the same list Head Office uses, `PAKISTAN_CITIES` (`components/join/pakistan-city-combobox.tsx`). Nothing typed is taken as a city. |
| A2 | **The province follows the city.** The form fills it in and shows it read-only. The body carries both; `departmentJoinSubmitSchema` refuses an unlisted city, a province that is not the city's own, or one half without the other (400), and stores the list's spelling. A city is refused on an existing branch (`.strict()`). |
| A3 | **Stored on the request's branch row**: `organization_join_request_branches.requested_branch_city` and `requested_branch_province`, nullable. The province stored is the list's (`requestedBranchLocation`), never the caller's. `organization_join_request_branches_location_ck` allows a location only on a CRC row and only whole. |
| A4 | **Head Office still decides.** The review returns `requestedCity` / `requestedProvince`, and the approval dialog starts the new branch's city and province from them; Head Office may change the city. The approval itself is unchanged: the decision body names the city, `departmentJoinDecisionSchema` and `createRequestedBranch` check it, and the warehouse attachment (`plans/OF-JOIN-new-branch-city-warehouse.md`) follows the city Head Office approved. |
| A5 | **Head Office's edit keeps the city.** `departmentJoinUpdateSchema` accepts an optional listed city and province on a CRC entry; an edit that sends none keeps the stored one, an edit that sends another moves it (`planRequestBranchEdit` → `relocations`) on the same row. A CRC Head Office adds in the edit carries no city; it is chosen at approval, as before. |
| A6 | **Older requests are untouched**: their rows read null and the dialog starts the city blank, exactly as before. |

## Size

Ten new branches with the longest listed city and province ("Islamabad",
"Islamabad Capital Territory") stay under the WAF's 8 KB; both worst-case tests
carry them.

## Rollout

Apply migration `20261026120000_join_request_branch_city` before deploying: the
join reads select both columns. Additive and nullable; rollback in the
migration header.

## Tests

- `lib/join-department-signup.test.ts` — `requestedNewBranches`,
  `requestedBranchLocation`, `requestedBranchCityError`.
- `lib/join-department-signup-form.test.ts`, `components/join/department-signup-form.test.tsx`
  — the form asks for the city, fills the province, refuses a branch without one, sends both.
- `lib/server/department-join-submit-schema.test.ts`, `lib/server/department-join-update-schema.test.ts`.
- `lib/join-department-edit.test.ts` — keep, give and move a city on edit.
- `components/join/department-join-review-dialog.test.tsx` — the dialog starts from the applicant's city.
- `tests/integration/organization-join-department.test.ts` — stored row and review.
- `tests/integration/organization-join-department-edge-cases.test.ts` — refusals,
  the edit, and the database check.

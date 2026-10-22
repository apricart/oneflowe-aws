# OF-JOIN — A new branch on the department sign-up is a parent, a child, or standalone

Builds on `plans/OF-JOIN-department-signup-multi-user.md`,
`plans/OF-JOIN-applicant-new-branch-city.md` and
`plans/OF-BRANCH-parent-child-label.md`.

Status: implemented 2026-10-21.

## What is being asked

On the department sign-up (`/join`, organizations with order approval levels
on), an applicant who adds a branch that is not listed gives its name, CRC and
city. Create / Edit Branch already ask for a **Branch type** — Standalone,
Parent, or Child of a parent branch. The sign-up should ask the same for a new
branch.

The label is still **a label only** (`plans/OF-BRANCH-parent-child-label.md`):
nothing about access, approval, budget, price, catalogue or warehouse reach
reads it.

## Decisions

| # | Decision |
|---|---|
| H1 | **Every new branch on `/join` gets a Branch type**: Standalone (default), Parent, or Child. An existing branch picked by name is never re-typed — it keeps its own type, exactly as a CRC mapped onto an existing branch keeps its city. |
| H2 | **A child's parent is one of two things**: an *existing* parent branch of the organization, or *another new branch on the same request* marked Parent (a department opening a parent and its children together). Never both, never itself. The lookup answers `parentBranchIds` — which of the listed active branches are parents — so the page can offer them; no other branch detail is added to the public answer. |
| H3 | **Stored on the request's branch row** as the applicant's proposal: `requested_hierarchy_role`, `requested_parent_branch_id`, `requested_parent_crc`, all nullable (null = none given: every older request, every existing-branch row). `organization_join_request_branches_hierarchy_ck` holds the shape (CRC rows only; Child ⇔ exactly one parent; a parent CRC is never the row's own) and `organization_join_request_branches_parent_org_fk` keeps an existing parent in the request's own organization. |
| H4 | **The submission is held to every rule**, judged on the whole list (`requestedBranchHierarchyError`): a child names exactly one parent; a parent CRC is another new branch on the request marked Parent (checked or not, it must be sent); an existing parent is an active **Parent** branch of the code's organization (400 otherwise, the same message whether it does not exist, is in another tenant, or is not a parent). |
| H5 | **Head Office still decides.** The review answers the proposal (`requestedHierarchyRole`, `requestedParentBranchId`, `requestedParentBranchName`, `requestedParentCrc`); the review dialog starts each branch to create from it and may change it. The decision body carries `hierarchyRole` and either `parentBranchId` (an existing branch) or `parentRequestBranchId` (another branch this approval creates as Parent). Absent = Standalone, as `createBranchInTx` already treats it. |
| H6 | **The approval creates parents before children** in its one transaction, so a child can name a parent created a moment earlier. An existing parent goes through `createBranchInTx`'s own `parentBranchRefusal` (same tenant, a Parent, taken `FOR SHARE`); a refusal rolls the whole approval back with its message. A `parentRequestBranchId` must name a branch this same decision creates as Parent (400 otherwise). Mapping a CRC onto an existing branch carries no type. |
| H7 | **Head Office's edit carries the proposal through.** `departmentJoinUpdateSchema` accepts the same three optional fields on a CRC entry; absent keeps the stored proposal, present replaces it; the resulting set is validated as a whole (H4), with an existing parent fenced to the tenant only — its current type is judged at approval, where Head Office chooses. The edit form does not change a type (the review dialog does); removing a Parent there makes its children on the request Standalone, visibly, before saving. |
| H8 | **Older requests are untouched**: their rows read null and the dialog starts every new branch Standalone, as before. |

## API

- `POST /api/v1/join/lookup` — department answer adds `parentBranchIds: number[]`.
- `POST /api/v1/join/requests` (version 2) — a new-branch entry may carry
  `hierarchyRole` (`STANDALONE` | `PARENT` | `CHILD`), `parentBranchId`,
  `parentCrc`. Strict; pairing errors are 400.
- `PATCH /api/v1/join-requests/[id]` `{ update }` — same three optional fields.
- `PATCH /api/v1/join-requests/[id]` decision — a create entry may carry
  `hierarchyRole`, `parentBranchId`, `parentRequestBranchId`; a mapped entry
  carries none (400).

## Data

Migration `20261028120000_join_request_branch_hierarchy`, additive, nullable,
small table (check validated at once). Rollback in its header. **Apply before
deploying**: the join reads select the columns.

## Security

- Public path: no new endpoint. The lookup discloses which listed branches are
  parents — a label on names it already discloses to a holder of the code.
- Tenant: an existing parent id is checked in the code's organization at
  submission, Head Office's own at edit, and by `parentBranchRefusal` (and the
  composite key, and the `branches_hierarchy_guard` trigger) at approval.
  Another tenant's id reads exactly as a missing one.
- Mass assignment: every field named in strict Zod schemas; nothing spread.
- No access, price, budget or warehouse rule reads the new columns.

## Size

Ten Child branches with a 32-character parent CRC add about 700 bytes; the
worst-case WAF tests carry them and stay under 8 KB.

## Tests

- `lib/join-department-signup.test.ts` — `requestedHierarchyOf`,
  `requestedBranchHierarchyError`, `newBranchDecisionHierarchyError`,
  `orderNewBranchChoicesParentsFirst`.
- `lib/join-department-signup-form.test.ts` — chip rules, payload, worst case.
- `lib/server/department-join-{submit,update,decision}-schema.test.ts`.
- `lib/join-department-edit.test.ts` — keep, set, clear; removing a parent.
- `components/join/department-signup-form.test.tsx`,
  `components/join/department-join-review-dialog.test.tsx`.
- `tests/integration/organization-join-department-edge-cases.test.ts` — stored
  rows, refusals (non-parent, other tenant), the database check, approval
  creating a parent and its child together, an existing parent, a refused
  parent rolling the approval back.
- `tests/integration/tenant-composite-foreign-keys.test.ts` — 41 → 42.

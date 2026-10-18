# OF-JOIN — a typed CRC an existing branch carries is decided at review, not folded at submission

Amends `plans/OF-JOIN-department-signup-multi-user.md` ("Branch names", "Storage").

## Problem

On 2026-10-16 a department sign-up for K-E-Demo (production join request 1)
asked for a new branch with CRC `0001`. Airport Branch already carries CRC
`0001`, so the submission stored the entry as that existing branch and dropped
the name the applicant gave. Head Office's review listed it as an ordinary
existing branch, the approval created the accounts on Airport Branch, and no
branch was created. Nobody was told the request had been changed.

The applicant is deliberately never told (the public path never reveals which
CRCs exist), and Head Office could not tell either, because the request no
longer held the CRC or the name.

## Change

* **Submission and Head Office's edit** store every typed new branch as a CRC
  row with its name (`existing_branch_id` null), whether or not a branch
  carries that CRC. `matchCrcsToBranches` is no longer called on either path.
  The public answer is unchanged, so the CRC set still never leaks.
* **Review** (`loadDepartmentJoinReview`) answers `crcMatch: { branchId, name }`
  for each unresolved CRC row of a **pending** request that exactly one active
  branch of the organization carries; null otherwise (no match, a CRC shared by
  several branches, a decided request). Head Office of that organization only,
  which already reads its branches.
* **Review dialog**: a matched row starts **undecided** — neither "use the
  branch" nor "create a new one" is chosen for Head Office. An amber note names
  the branch and the name the applicant asked for; the select offers
  "Use existing: <branch> (has CRC …)" and "Create a new branch". Approve is
  refused in the dialog until a choice is made.
* **Approval** is unchanged: every CRC row already needs either `mapToBranchId`
  or full new-branch details in the decision (400 otherwise), so the server
  never guesses. Creating a new branch with a CRC another branch carries is
  allowed (CRCs were never unique on `branches`); the CRC then matches two
  branches and later requests are left for Head Office to map, as for any
  shared CRC.

## Consequences

* The initiator's role at submission counts a matched CRC as one branch, as
  before; `branchCountAfterReview` still recounts after Head Office's mapping.
* The approver preview treats an undecided CRC as a new branch, as for any
  CRC; `sameResolution` already tolerates the difference a mapping makes.
  A Branch Admin approver whose own branch is the matched one is previewed as
  converting until Head Office maps it — the existing behaviour for any CRC.
* Requests already stored as an existing branch are not rewritten. Production
  request 1 is approved; its missing branch is created by hand if wanted.

No schema change, no migration.

## Tests

* `components/join/department-join-review-dialog.test.tsx` — undecided start,
  the refusal, both choices' bodies, the matched branch offered once.
* `tests/integration/organization-join-department.test.ts` — submission keeps
  the CRC and name, the review names the match, approval by mapping and by
  creating; no match once decided.
* `tests/integration/organization-join-department-edge-cases.test.ts` — the
  edit keeps typed CRCs as CRCs; the review names only the unambiguous match.

# OF-BRANCH — a contact phone on the branch

## Why

Branches carry a name, address, city and province, but no phone. The customer
delivery-address workbook (2026-10-22) gives one phone per branch, and the
warehouse has to be able to ring the branch it delivers to. Today the only phone
in the model is on `branch_delivery_addresses.contact_phone`, which belongs to a
requested delivery destination, not to the branch, and needs a requesting user.

## What

- `branches.contact_phone varchar(32)`, nullable, no default (null = not
  provided, every existing branch). Same length as
  `branch_delivery_addresses.contact_phone`.
- One rule, `lib/branch-contact-phone.ts`: blank is null; otherwise only digits,
  spaces and `+ - ( ) / .`, at most 32 characters, 7 to 15 digits. The forms use
  it to refuse before submitting; the API uses it in `branchCreateSchema` and
  `branchUpdateSchema` (`contactPhone`, nullable, optional; `null` clears).
- Written by exactly the callers that already write a branch: `POST
  /api/v1/branches` and `PATCH /api/v1/branches/[id]` — Super Admin anywhere,
  Head Office in its own organization. No new role, no new route. The creation
  audit row (`CREATE_BRANCH`) records it; `UPDATE_BRANCH` already records every
  touched field with its previous value.
- Read wherever the branch is read: the branch list, the single-branch read,
  the Super Admin and Head Office Create/Edit Branch forms, and the Branches
  page detail view.
- The department sign-up creates branches through `createBranchInTx` without a
  phone (null); nothing there changes.

## Not in scope

- Validating that a number is reachable, or normalising it to E.164. Stored as
  typed (trimmed, inner spaces collapsed).
- Showing it on the warehouse's order sheet. A follow-up if wanted.

## Security

- Authorization unchanged: the two write routes' role and tenant checks apply.
- It is a business contact number, readable by whoever may read the branch.
  The sheet's numbers are often a branch officer's mobile; this is the number
  the customer gave as the branch contact.
- Validated server-side with Zod (`.strict()` schemas); the form check is UX.

## Database

Additive: `ALTER TABLE branches ADD COLUMN IF NOT EXISTS contact_phone
varchar(32)`. Nullable, no default, so no table rewrite. Migration
`20261030120000_branch_contact_phone`. **Apply before deploying**: the branch
reads select the column.

Rollback (after reverting the code that reads it):
`ALTER TABLE branches DROP COLUMN IF EXISTS contact_phone;`

## Tests

- `lib/branch-contact-phone.test.ts`: the rule's boundaries.
- Schema tests: create/update accept a phone, null, absence; refuse letters,
  too few/many digits, over-long text.
- Dialog tests (Head Office create/edit): the field is sent, blank is null,
  an invalid number blocks submit.
- Integration (`tests/integration/branches-api.test.ts`): Super Admin and Head
  Office set and clear it; Head Office cannot set it on another tenant's branch.

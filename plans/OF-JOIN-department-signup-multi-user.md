# OF-JOIN — Department sign-up and amount-based order approval

Builds on `plans/OF-JOIN-organization-self-service-join.md` and
`plans/OF-JOIN-email-domain-lock.md`. Status: **plan, awaiting decisions D1–D7
below.** Nothing is implemented.

## What is being asked

1. The public join form (`/join`) is restyled and restructured to match the
   attached `Apricart Department_Signup_Portal.html`.
2. One submission can create **several accounts**:
   * the **main user** (the "Order Initiator") from the main form;
   * three **Financial Approvers** (levels 1–3), each given by email and
     designation.
3. **An approver level is an amount band.** Each of the main user's orders is
   decided by the one approver whose band its amount falls in:

   | Order amount (PKR) | Decided by |
   |---|---|
   | below 40,000 | Level 3 approver |
   | 40,000 to 80,000 | Level 2 approver |
   | above 80,000 | Level 1 approver |

   This is **not** a sequential chain. One order needs one approval, by the
   approver for its band.
4. For each approver level:
   * if the email already belongs to a user, that user becomes the main user's
     approver at that level;
   * if that approver does not already reach the main user's branches, they
     are given those branches.
5. **CRC means branch** (CRC is UBL's name for a cost centre). While the
   applicant types, existing branches of the organization are suggested.
   * A chosen existing branch is assigned to the main user.
   * A branch that does not exist is **created**, with full branch details
     including the cost-centre (CRC) number.
   * **Several branches → `GROUP_ORDER_PORTAL`. One branch → `BRANCH_ADMIN`.**
     (The second half is discussed in D3.)
6. **Nothing is created until Head Office approves.** That covers users,
   branches, approver assignments and addresses.
7. Usernames are derived from email addresses.
8. **Amount-based approval is a per-organization feature.** Super Admin
   switches it on or off, and sets the band limits, in the **Create / Edit
   Organization** form.

## What already exists, and what it means for this

### The order side

| Fact | Where | Consequence |
|---|---|---|
| Approval is **per branch**, never per requester. An order is decided by the tenant's configured role (`BRANCH_ADMIN` of the order's branch, or `HEAD_OFFICE`) or by any `GROUP_USER` assigned to the branch. | `canMakeOrderDecision` in `lib/order-approver-role.ts` | "The approver for *this user*, for *this amount*" does not exist. It is a new rule. |
| Approval is one decision by one person: `PENDING → APPROVED`. | `lib/server/order-decision-service.ts` | This fits the bands: each order still needs exactly one approval. **No new order states are needed.** |
| Every decision path goes through `authorizeOrderDecision`: approve, reject, return for correction, the group-portal bulk decide, and the executive path. | `lib/server/order-decision-policy.ts` | The band rule lives in **one place**, and `lib/server/order-approver-contract.test.ts` already pins that choke point. |
| The order row is read **without a lock** during a decision. The approval only requires the order to still be `PENDING`. | `approveOrder`, line ~137 | If the band were worked out from a row read earlier, a requester's edit (35,000 → 90,000) landing between that read and the approval would let the Level 3 approver approve a Level 1 order. **The band has to be stored on the order, and the approval has to re-check it.** |
| Approve/reject/return buttons are granted **per role**, not per order (`getOrderDecisionCapabilities`). | orders list and detail, group-portal approvals | The screens need a per-order "can I decide this?" answer, or a Level 3 approver sees an Approve button on a 90,000 order that the server then refuses. |
| "Awaiting approval" emails go **only** to the tenant's configured approver role (Branch Admin of the branch, or Head Office). Group Users are not emailed at all. | `queueOrderCreatedNotifications` in `lib/server/order-notifications.ts` | The email must go to the approver for the band instead. The re-check at send time (`currentApproverConditionFor`) must accept that approver. |
| Auto-approval is an organization switch (`orders.order_approval_required`). Order Desk orders already override it and always wait. | `resolveInitialOrderApproval` | There is precedent for "this kind of order always waits, whatever the switch says" (D1.7). |
| A group submission becomes **one order per branch**, each with its own total. | `lib/server/group-order-creation.ts` | Banding each branch order separately would let a 100,000 request split across three branches reach no one above Level 3 (D1.5). |
| Pending orders hold budget. | `CLAUDE.md`, consumption rules | An order with no approver to decide it holds money until someone fixes it (D1.6). |
| No self-approval guard exists. | `order-decision-policy.ts`, `order-approver-role.ts` | Relevant to D3. |

### The join side

| Fact | Where | Consequence |
|---|---|---|
| Join code → organization, server-side; no `organizationId` is ever accepted | `lib/server/organization-join.ts`, `app/api/v1/join/*` | Kept as is. The HTML's "UBL Master Code" **is** the join code (D5). |
| Email locked to the organization's domain | `lib/organization-email-domain.ts`, `joinEmailDomainRefusal` | Kept, and applied to the approver emails too. |
| Lookup already returns the organization's active branches as `{id, name}` (up to 500) and **deliberately withholds cost centres** | `loadJoinFormOptions` | A name-based typeahead needs no new endpoint (D4). |
| Approval is one transaction with the request row taken `FOR UPDATE` | `decideJoinRequest` | Extended to create the whole package or nothing. |
| `branches.cost_center_id`, indexed, **not unique** | `db/schema.ts:137` | CRC maps onto it with no new column. A duplicate CRC is flagged to Head Office, not refused. |
| Branch creation logic is **written inside the route handler** | `app/api/v1/branches/route.ts:246` | Must be moved to `lib/server/branch-creation.ts` and shared. |
| `HEAD_OFFICE` may already create branches | `lib/server/branch-creation-access.ts` | Head Office approving branch creation stays inside its existing authority. |
| A new branch has **no catalogue** and a **zero budget baseline** | `lib/server/group-order-catalog.ts`, `branches.baseline_budget_cents` | An approved user at a new branch sees an empty shop (D6). |
| Extra delivery addresses are per branch and approved by Head Office | `branch_delivery_addresses` | The form's addresses map onto this table, but each needs a branch. |
| `replaceMultiBranchScope` **replaces** a user's branch list wholesale | `lib/server/multi-branch-scope.ts:135` | Extending an existing approver needs a new **additive** helper. |
| Usernames are globally unique. Emails are unique in the application but not in the database (K-Electric mirrored accounts share an email across rows). | `db/schema.ts:272`, `lib/user-uniqueness.ts` | A lookup by approver email can return more than one row. |
| App password rule: 12+ characters with upper, lower, digit and special | `passwordSchema` | Stricter than the HTML's. The app rule is kept. |
| Production WAF refuses any JSON body over **8 KB** with an opaque 403 | memory: WAF note; `lib/product-request.ts` | The submission needs hard bounds and a client-side size guard. |

## Decisions needed before implementation

Each has a recommendation.

### D1 — How the amount bands work

| # | Question | Recommendation |
|---|---|---|
| **D1.1** | Exactly 40,000 and exactly 80,000 are not covered by "below 40,000 / above 80,000". Which level decides them? | Each level's limit is **inclusive**: up to and including 40,000 → Level 3; 40,000.01 to 80,000 → Level 2; above 80,000 → Level 1. This is the usual "may approve up to X" rule. |
| **D1.2** | Strict bands, or ceilings? | **Strict, as you wrote it.** Level 1 decides only orders above 80,000, and so on. The alternative ("ceiling") lets a higher level also approve smaller orders, which gives cover when a Level 3 approver is away. With strict bands, an absent approver's orders wait until Head Office reassigns that level. |
| **D1.3** | Which amount? | The order total **including tax** (`orders.total_cents`): the figure the requester and approver both see. |
| **D1.4** | Can anyone else approve these orders: Head Office, the branch's Branch Admin, another Group User at the branch? | **No.** For a requester who has approvers, only the approver for the band may approve, reject or return the order. Otherwise anyone with branch access could approve a 100,000 order and the bands would mean nothing. Head Office's control is to **reassign** a level (audited). It does not decide in that approver's place. |
| **D1.5** | Splitting. A 100,000 group submission across three branches becomes three orders of about 33,000 each. | Band every branch order of a group submission by the **submission's total**, so the whole request reaches the approver it would have reached as one order. Splitting by placing several small single-branch orders over a few days is **not** prevented in this release. If needed, it can be surfaced later in a report. |
| **D1.6** | No approver at the needed level, or that approver is inactive. | **Refuse the order at creation** (409, "No Level N approver is set for you; contact Head Office"), because a pending order holds budget. If an approver is deactivated after an order is placed, the order waits. Head Office sees a warning on that user and reassigns the level, and the order then goes to the new approver. |
| **D1.7** | Tenants with auto-approval switched on. | Orders from a requester who has approvers **always wait for approval**, whatever the switch says. This matches the Order Desk precedent. Having approvers *is* the approval policy for that person. |
| **D1.8** | Are the 40,000 / 80,000 limits fixed for everyone? Who can change them? | **Decided:** per organization, set by **Super Admin** in the Create / Edit Organization form, together with an on/off switch. Defaults are 40,000 and 80,000. Head Office can see them but not change them. The switch's behaviour is in D7. |
| **D1.9** | The same person at two levels? | **Not allowed**, as in the HTML (its validation rejects duplicates). |

### D2 — Which role does an approver have, and why branches are still given

New approvers are created as **`GROUP_USER`**. Under D1.4, the right to decide
a requester's orders comes from being their approver for the band, not from a
role. Branch access is still needed so the approver can **see** those orders:
order reads are branch-scoped. That is why the main user's branches are
added, as you asked.

One side effect, shown to Head Office at approval: a `GROUP_USER` with a
branch can also decide orders at that branch from people who have **no**
approvers (the existing rule). If every UBL user comes through this form, every
UBL order is banded and that never happens.

For an **existing** user found by approver email:

| Existing role (same organization) | Proposal |
|---|---|
| `GROUP_USER` | Add only the branches they lack (additive). Never remove any. |
| `HEAD_OFFICE` | Nothing to add: they already see the whole tenant. Under D1.4 they decide the orders routed to them, whatever the tenant's configured approver role. |
| `BRANCH_ADMIN` | Sees only their own branch, so they could not see the requester's orders at other branches. Head Office chooses at approval: convert to `GROUP_USER` (their branch plus the new ones), or choose another approver. A conversion is refused while they have orders in flight (`OF-ROLE-branch-admin-order-portal-switch`). Never converted automatically. |
| Any other role (`ORDER_PORTAL`, `GROUP_ORDER_PORTAL`, …) | Cannot approve: these roles have no approval screens. Flagged; Head Office replaces that level. |
| Inactive, deleted, or several matching rows | Flagged; Head Office resolves it. |
| Email belongs to **another organization** | Unavailable. Flagged to Head Office, **never shown to the applicant**. |

Approver emails must be at the organization's domain, distinct from each other
(D1.9), and distinct from the main user's email.

### D3 — One branch → `BRANCH_ADMIN`, or `ORDER_PORTAL`?

The bands change this question. Under D1.4, a requester's banded orders can be
decided only by their approvers. So a Branch Admin requester **cannot approve
their own orders**, which was the main risk raised earlier.

What remains:

* **Portal.** `BRANCH_ADMIN` uses the admin portal (dashboard, orders page).
  `ORDER_PORTAL` uses the shop, which is the single-branch counterpart of the
  storefront `GROUP_ORDER_PORTAL` uses.
* **Residual approval right.** In a tenant whose approver role is
  `BRANCH_ADMIN`, the main user could still decide *other* people's unbanded
  orders at their branch.

Recommendation: **`ORDER_PORTAL`**, so a one-branch and a several-branch
initiator get the same kind of experience. `BRANCH_ADMIN` is acceptable if
single-branch initiators should see the admin portal. Check UBL's
`order_approver_role` before deciding.

### D4 — How does the branch (CRC) typeahead match?

* **Recommended.** Match on **branch name**, using the list the lookup already
  returns. There is no new public endpoint and nothing new is disclosed.
* Matching on **CRC number** means either sending every branch's cost centre
  to anyone with the code, or adding a new public search endpoint. Typing would
  quickly use up the 15-per-15-minutes rate limit.
* Middle ground: at review, Head Office is warned when a requested new
  branch's CRC already belongs to an existing branch.

### D5 — The master code

The HTML checks `1020265000` **in the browser**, so anyone can read it from
the page source. That must not ship. The existing server-checked **join code**
takes its place.

* It stays the **first step**, styled like the HTML card, because branch
  suggestions need the organization first.
* The master-code field is removed from the bottom of the form.
* Head Office should set a fresh code if that HTML was ever public.

### D6 — New branches after approval

A new branch has no products and no budget.

* **Recommended.** Show Head Office a "next steps" notice after approval
  (assign products, allocate budget), and let Head Office set the branch's
  group at approval.
* Copying another branch's catalogue, or setting a baseline budget, at approval
  is a later step.

### D7 — What the on/off switch does

Super Admin sets `organizations.order_approval_bands_enabled` in Create / Edit
Organization. It is off by default, for existing tenants and new ones.

| # | Question | Recommendation |
|---|---|---|
| **D7.1** | Super Admin **switches it off** while banded orders are pending. Who decides them? | **The normal approvers, immediately.** The switch is read at decision time, as the tenant's configured approver role already is (changing that role re-routes pending orders today). "Off" therefore means the app behaves exactly as before, for every order. Each order keeps its stored band, so switching back on routes those still pending to their band approvers again. The alternative, fixing each order's routing when it is created (as `budget_tracked` does for budgets), would leave a disabled feature still controlling orders. The budget precedent exists to keep the money ledger consistent, which is not at stake here. |
| **D7.2** | Super Admin **switches it on**. What changes? | **New orders only.** An order placed while the feature was off has no band and keeps the normal rules. A requester with no approvers set keeps the normal rules too, so switching on never stops anyone ordering. Head Office's Users screen lists who has no approvers yet. |
| **D7.3** | Can the limits be changed while the feature is off? | **Yes**, so a tenant can be set up before it is switched on. This matches the ordering-block limits. A pending order keeps the band it was given. Its band is worked out again only if the order is edited, and then with the new limits. |
| **D7.4** | Does the join form ask for approvers while the feature is off? | **No.** The lookup tells the page whether the feature is on and what the limits are. While off, the approver section is hidden and the server refuses approver fields (400). While on, all three levels are required. |
| **D7.5** | A request sent while the feature was on is decided after it is switched off, or the other way round. | **Approve it as it was sent.** Approvers on the request are still created and recorded, and take effect whenever the feature is on. A request with no approvers is approved without them, and Head Office can add them later. The review dialog states which case applies. |
| **D7.6** | Can Head Office edit a user's approvers while the feature is off? | **Yes**, with a "not in effect: amount-based approval is off for your organization" notice. |

What switching off does **not** do: it does not email the normal approvers
about orders already pending. Those orders simply appear in their queue.

### Smaller choices (defaults proposed; say if any is wrong)

* **New user columns.** `department`, `ip_extension` and `designation` are
  added to `users` as nullable columns.
* **Department list.** The HTML's fixed list is held as a constant in `lib/`.
* **Email shape.** Domain lock only. The HTML's stricter `first.last@` rule
  becomes an optional per-organization switch, or is dropped.
* **Username.** Derived on the server as the email's local part, lower-cased.
  The page shows it read-only. If it is taken (only possible by someone at
  another domain), approval proposes `<local>.<orgcode>` and Head Office
  confirms.
* **New approver's name.** Derived from the email (`huzaifa.abid` → "Huzaifa
  Abid"). Head Office can edit it at approval.
* **Addresses.** Each address gets a branch selector, hidden when there is
  one branch. On approval each is written to `branch_delivery_addresses` as
  approved.
* **Terms checkbox.** Kept, required, stored as `terms_accepted_at`. The links
  are omitted until a Terms page exists.
* **Bounds** (for the 8 KB WAF limit):
  * at most 10 branches, of which at most 5 are new;
  * at most 5 addresses of 300 characters each;
  * exactly 3 approver levels (every band needs an approver);
  * a client-side encoded-body size guard, as in
    `lib/product-request-form.ts`.

## Design (assuming the recommendations)

The work splits cleanly in two. The order side is useful on its own: it lets
Head Office set approvers for existing users too. The join side writes what the
order side reads.

### Part A — Amount-based approval on orders

#### Data — migration `drizzle/<ts>_order_approval_bands.sql`

Additive only.

* `user_order_approvers` (new)
  * `organization_id`, `user_id` (the requester), `approver_user_id`,
    `level 1..3`, `created_by_user_id`, `created_at`, `updated_at`
  * `UNIQUE(user_id, level)` and `UNIQUE(user_id, approver_user_id)` (D1.9)
  * a check that `user_id <> approver_user_id`
  * Both users must belong to `organization_id`, enforced in the writer and
    re-checked in the authorizer.
* `organizations`
  * `order_approval_bands_enabled boolean NOT NULL DEFAULT false`: the switch
    (D7)
  * `approval_level3_max_cents bigint NOT NULL DEFAULT 4000000` (40,000.00)
  * `approval_level2_max_cents bigint NOT NULL DEFAULT 8000000` (80,000.00)
  * `organizations_approval_band_limits_ck`: `0 < level3 < level2`, plus an
    upper bound held in `lib/order-approval-band.ts`
  * Defaulted, so no tenant's behaviour changes. A band applies only when the
    switch is on **and** the requester has rows in `user_order_approvers`.
  * `GET /api/v1/organizations` returns the whole row to tenant roles. That is
    acceptable for these columns: none of them is secret, and the limits are
    shown on the join form anyway.
* `orders`
  * `approval_level smallint NULL CHECK (approval_level BETWEEN 1 AND 3)`
  * `approval_basis_cents bigint NULL`: the amount the band was worked out
    from (the submission total for a group order)
  * Both null on every existing order and on every order from a requester
    without approvers. **Null means "decided exactly as today".**
  * Nullable with no default, so the `ALTER` is a metadata change on the live
    `orders` table.

#### Pure logic

* `lib/order-approval-band.ts`:
  * `approvalLevelForAmount(cents, limits)`: the D1.1 boundaries, in integer
    cents;
  * `bandLabel`;
  * `canDecideBandedOrder({ actorUserId, approverForLevel })`;
  * `orderIsBanded({ bandsEnabled, approvalLevel })`: the one statement of
    "this order is decided by band" (switch on **and** a stored level, D7.1).
    No reader restates it.
  * the limits' bounds and defaults;
  * `parseApprovalBandLimitDraft`: PKR text from the form → integer cents.
    Digits with at most two decimals; anything else is refused, never coerced.
    No floating-point arithmetic.
  * the audit action names.

  Pure, shared by the authorizer, the screens, the creation paths and the
  organization form, as `lib/ordering-block-threshold.ts` is for the ordering
  blocks.

#### Server logic

* **Order creation.** Both creation paths: `POST /api/v1/orders` and
  `lib/server/group-order-creation.ts`. The switch and the limits are read in
  the same `FOR SHARE` read of the organization row that
  `resolveInitialOrderApproval` already takes. A Super Admin edit (which holds
  `FOR UPDATE`) therefore lands wholly before or wholly after an order. If the
  switch is on and the creator has approvers:
  1. work out the level from the priced total (for a group order, the
     submission total);
  2. confirm the approver at that level exists and is active, or refuse with
     409 (D1.6);
  3. create the order `PENDING` whatever the auto-approval switch (D1.7);
  4. store `approval_level` and `approval_basis_cents`.

  All inside the creation transaction, before the transaction commits its
  holds.
* **Order edits.** Every path that rewrites a pending order's total works out
  the level again, with the current limits, for any order that already has
  one, whether the switch is on or off. Its band is then correct whenever the
  feature is on (D7.1). Today that path is `PATCH /api/v1/orders/[id]`; the
  Order Desk edit is never banded. If the level changes while the switch is
  on, the new approver is emailed. A contract test lists these writers.
* **Authorizer.** `authorizeOrderDecision` already reads the organization row
  `FOR SHARE`, so it also reads the switch there, and a switch flip waits for
  an in-flight decision. A new branch, checked before the existing role rules:
  if `orderIsBanded` holds, re-read the requester's approver at that level
  (`FOR SHARE`, so a concurrent reassignment waits). The caller must be that active user in the same
  organization; anyone else is refused (D1.4). The level is returned with the
  authorization, and **every claim** (approve, reject, return) adds
  `approval_level = <that level>` to its `WHERE`. An edit that moved the order
  into another band in the meantime then makes the decision a 409, not a
  wrong-level approval. Unbanded orders take the existing path unchanged.
* **Per-order decision flag.** The orders list, order detail and group-portal
  approvals responses carry `canDecide` for each order, from the same pure
  rule. The page-level role capability stays for navigation only.
* **Notifications.** For a banded order:
  * "awaiting approval" (on creation, on resubmission, and on an edit that
    changes the level) goes to **the approver for the band only**;
  * the send-time re-check accepts that approver.
* **Audit.** Every decision on a banded order records `approvalLevel` and
  `approvalBasisCents`.

#### Head Office: managing approvers

* Users screen → an **Approvers** section on an `ORDER_PORTAL` /
  `GROUP_ORDER_PORTAL` user: Level 1–3, picked from the organization's users.
* Written through `PUT /api/v1/users/[id]/order-approvers`:
  * Head Office only, own organization (`getRequestScope`);
  * strict Zod;
  * audited `UPDATE_USER_ORDER_APPROVERS` with the before and after values;
  * applies the same branch-extension rule as the join approval
    (`planApproverResolution`, below).
* A warning when a user's approver is inactive, or when deactivating someone
  who is another user's approver.
* The Approvers section and the "no approvers yet" list carry the D7.6
  "not in effect" notice while the switch is off.

#### Super Admin: the switch and limits in Create / Edit Organization

* **Form** (`app/(portal)/organizations/page.tsx`): an "Amount-based order
  approval" section with:
  * an on/off switch;
  * two PKR inputs, "Level 3 approves up to" and "Level 2 approves up to",
    with "Level 1 approves above the Level 2 limit" stated beneath them.

  The inputs stay editable while the switch is off (D7.3). They are validated
  inline with `parseApprovalBandLimitDraft` and the `level3 < level2` rule.
  Create defaults the switch to off.
* **Endpoints.** These fields are written only through
  `POST /api/v1/organizations` and `PATCH /api/v1/organizations/[id]`, which
  are already Super Admin only:
  * `organizationCreateSchema` and `organizationUpdateSchema` gain
    `orderApprovalBandsEnabled` (boolean),
    `approvalLevel3MaxCents` and `approvalLevel2MaxCents` (JSON integers in
    cents; strings refused).
  * The PATCH checks `level3 < level2` against the **merged** values (what
    was sent, otherwise what is stored), so sending only one limit cannot
    produce an inverted pair. Inverted → 400.
  * The PATCH already locks the organization row `FOR UPDATE`. Each change is
    audited in that transaction:
    * `UPDATE_ORDER_APPROVAL_BANDS_ENABLED` (before and after);
    * `UPDATE_ORDER_APPROVAL_BAND_LIMITS` (before and after for both limits).
  * `CREATE_ORGANIZATION` metadata records the initial values.
* **Head Office** sees the switch state and limits read-only on its Users
  screen. It never writes them.
* `lib/server/order-approval-band-contract.test.ts` pins:
  * the two writers of these columns;
  * every reader of the switch (both creation paths, the authorizer,
    notifications, the per-order decision flag, the join lookup and submit),
    each going through `orderIsBanded` rather than restating it.

### Part B — Department sign-up

#### Data — migration `drizzle/<ts>_join_department_signup.sql`

Additive, except one replaced check constraint.

* `organization_join_requests`
  * `form_version smallint NOT NULL DEFAULT 1`
  * `department`, `ip_extension`, `terms_accepted_at`, all nullable
  * `organization_join_requests_scope_shape_ck` is replaced by
    `form_version = 1 AND (the old rule) OR form_version = 2`. Every existing
    row is version 1 and passes unchanged.
* `organization_join_request_branches` (new)
  * either `existing_branch_id`, or the new-branch fields (`name`,
    `cost_center_id`, `province`, `city`, `address`), never both
  * `created_branch_id`, set at approval
  * composite tenant FK, and added to
    `tests/integration/tenant-composite-foreign-keys.test.ts`
* `organization_join_request_approvers` (new)
  * `request_id`, `level 1..3`, `email`, `designation`
  * at decision: `resolution` and `approver_user_id`
* `organization_join_request_addresses` (new)
  * `request_id`, `request_branch_id`, `address`
* `users`: `department`, `ip_extension`, `designation`, all nullable.

#### Pure logic

* `lib/join-department-signup.ts`:
  * `deriveUsernameFromEmail`, `deriveNameFromEmail`;
  * `roleForBranchCount` (D3);
  * `approverEmailsError`;
  * the bounds and the department list.
* `lib/join-approver-resolution.ts`: `planApproverResolution(existingRows,
  branchIds)` returns, per level, `reuse` / `extend(branchIds)` / `create` /
  `blocked(reason)` from the D2 table. It is shared by the review preview, the
  join approval, and Head Office's Approvers editor, so what Head Office sees
  is what gets written.

#### Server logic

* `lib/server/branch-creation.ts`: `createBranchInTx`, moved out of
  `POST /api/v1/branches` with its behaviour unchanged.
* `lib/server/multi-branch-scope.ts`: `addBranchesToScope`, additive and
  idempotent.
* `createJoinRequest` (version 2):
  * stores the package;
  * **never looks approver emails up**, so the public answer cannot reveal
    whether a colleague has an account.
* `loadJoinReview`: a new Head Office read returning the package plus the
  preview (approver matches and conflicts, duplicate branch names and CRCs,
  username conflicts).
* `decideJoinRequest` (version 2), in **one transaction**:
  1. Lock the request `FOR UPDATE`.
  2. Create the new branches, or map a new branch onto an existing one if
     Head Office chooses.
  3. Create the main user and its branch scope.
  4. Create the addresses.
  5. For each level, re-run `planApproverResolution`. If the outcome differs
     from what Head Office reviewed, stop with a 409. Otherwise extend or
     create the approver.
  6. Write `user_order_approvers` (Part A).
  7. Mark the request approved; write one audit row per object.

  Any failure rolls the whole package back. After commit:
  * the decision email to the main user;
  * a welcome email with credentials to each **new** approver (generated
    password, `must_change_password = true`);
  * a notice to existing approvers who gained branches.

#### Endpoints

| Route | Change |
|---|---|
| `POST /api/v1/join/lookup` | Also returns `approvalBandsEnabled` and the two limits (D7.4). |
| `POST /api/v1/join/requests` | Version 2 body: strict, no `username`, no `role`, no organization id. Approvers required when the switch is on, refused (400) when off, judged against the switch re-read on that request, never what the page sends back. Same rate limits and generic messages. |
| `GET /api/v1/join-requests/[id]` | **New.** Head Office, own organization: package and preview. |
| `PATCH /api/v1/join-requests/[id]` | Version 2 decision: per-level choices, new → existing branch mapping, group per new branch, username override. All re-validated. |

#### UI

* `app/join/page.tsx` and `components/join/join-request-form.tsx`: rebuilt to
  the HTML. The code comes first (D5). The CRC field is a branch combobox with
  "Create new branch…". The approver panel states each level's band ("Level 3
  — orders up to PKR 40,000"), read from the organization. The panel is shown
  only when the organization has the feature on.
* `components/join/join-decision-dialog.tsx`: a version 2 review with person,
  branches, approvers with their bands and resolution, addresses, and next
  steps. Version 1 requests keep the current dialog.

## Security

* **Authorization.** The band rule is enforced in `authorizeOrderDecision`,
  the single choke point, and re-checked by the claim's `WHERE`. Hiding the
  Approve button is presentation only.
* **Race.** A level change between the authorization read and the approval
  becomes a 409. A reassignment waits on the `FOR SHARE` read.
* **Tenant isolation.**
  * Approver rows are fenced to the organization at write time and again at
    decision time.
  * The join organization still comes only from the code.
  * The new tables carry composite tenant FKs.
* **Privilege.**
  * The applicant cannot pick a role.
  * Approvers are created by Head Office's approval, never by the applicant.
  * Only Head Office sets approvers; only Super Admin sets the band limits.
* **Money.** Amounts are integer cents. Banded orders always wait, regardless
  of the auto-approval switch. An order without an available approver is
  refused before it holds budget.
* **Enumeration.** Approver lookups happen only on the authenticated Head
  Office read.
* **Accepted.** Splitting purchases across several single-branch orders is
  not blocked (D1.5). Account creation for colleagues' addresses is bounded by
  the domain lock, Head Office approval, and credentials going only to the
  mailbox itself.
* **WAF.** Hard bounds and a client-side size guard.

## Tests

* **Unit.** `approvalLevelForAmount` at 0, 39,999.99, 40,000.00, 40,000.01,
  80,000.00, 80,000.01 and at custom limits; `canDecideBandedOrder`;
  `planApproverResolution` across the D2 table; username and name derivation;
  form bounds including the 8 KB worst case.
* **Contract.**
  * The authorizer's band check runs before the role rules.
  * Every claim matches `approval_level`.
  * The list of creation and edit paths that write `approval_level`.
  * `organization-join-contract.test.ts`'s "exactly one user insert" rule
    **is deliberately changed**, and says why.
* **Integration** (`tests/integration/order-approval-bands-api.test.ts` and
  `organization-join-v2.test.ts`):
  * Each level decides only its band. Head Office, the Branch Admin and other
    Group Users are refused on banded orders. Unbanded orders behave as today.
  * The switch:
    * off → no band stored at creation, and auto-approval honoured;
    * switched off with banded orders pending → the normal approvers can
      decide them at once;
    * switched back on → they return to their band approvers;
    * an order placed while off stays unbanded after switching on.
  * Organization endpoints:
    * 401/403 for every role but Super Admin on the switch and limits;
    * an inverted pair refused, including a one-sided PATCH;
    * string, negative and over-bound values refused;
    * the audit rows with before and after values;
    * the check constraint refusing a raw write.
  * Join with the switch off: approvers refused. With it on: approvers
    required.
  * An edit across a band boundary → 409 for the old approver, and an email to
    the new one.
  * A group submission banded on its total.
  * A missing or inactive approver → 409 at creation, with no hold taken.
  * Auto-approval tenant: banded orders still pending.
  * Reassignment moves a waiting order.
  * Cross-tenant approver refused.
  * The join package approved and rejected atomically, including each
    approver resolution case.
  * Audit rows.
* **E2E.** Sign-up with three approvers → Head Office approves → the main user
  places orders of 30,000, 60,000 and 100,000 → each reaches only the right
  approver.

## Phasing

1. **Part A**: amount bands on orders, plus Head Office's Approvers editor.
   Usable at once for existing users.
2. **Part B**: the department sign-up form and package approval, which write
   the approvers Part A reads.
3. Later: catalogue copy and baseline budget at approval (D6); a report on
   possible purchase splitting (D1.5).

## Risk and rollback

* Nothing changes for any organization until Super Admin switches the
  feature on, and then only for requesters with approvers.
* **The switch is the first line of rollback.** Switching it off returns
  every order in that organization to the normal approvers at once, with no
  deploy (D7.1).
* Rollback, Part A: revert the code. Banded pending orders then fall back to
  the existing branch rules (the columns are simply ignored). Drop the columns
  and table afterwards.
* Rollback, Part B: revert the code, reject any pending version 2 requests,
  drop the new tables and columns, and restore the old check. Users and
  branches already approved are ordinary rows and stay.

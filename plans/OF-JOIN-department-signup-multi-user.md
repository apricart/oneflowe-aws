# OF-JOIN — Department sign-up for organizations with approval levels

Builds on `plans/OF-JOIN-organization-self-service-join.md`,
`plans/OF-JOIN-email-domain-lock.md`,
`plans/OF-APPROVAL-LEVELS-organization-approval-levels.md` (phase 1) and
`plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md` (phase 2a).

Status: **department sign-up implemented 2026-10-15** (migration
`20261019120000_join_department_signup`). Phase 2b, routing orders by level,
is not built; see *Dependency on phase 2b*.

> **Revision 2026-10-15.** The first draft (2026-10-13) designed its own
> approval machinery: fixed three bands with "up to" limits on the
> `organizations` row, a per-requester `user_order_approvers` table, and a
> Super Admin form section for the limits. Phases 1 and 2a have since shipped
> a different model: a per-organization list of 1–10 levels, and **a level held
> by the approver** (`users.order_approval_level`), not a link from a requester
> to an approver. This revision drops everything the shipped model replaces
> and re-designs the join side around it. The superseded design is in git
> history (`git log -- plans/OF-JOIN-department-signup-multi-user.md`).

## What is being asked

1. **The join form depends on the organization's approval-levels setting.**
   * **Approval levels off** (or approval not required): the current join
     form, unchanged. The applicant picks a role and a branch or groups, as
     today.
   * **Approval levels on:** a new form, the *department sign-up*, restyled
     to match `Apricart Department_Signup_Portal.html`.
2. One department sign-up creates, on Head Office's approval:
   * the **Order Initiator** (the main user) from the main form;
   * one **Financial Approver per level** the organization has configured,
     each given by email and designation. An approver who already has an
     account is reused; one who does not is created.
3. **CRC means branch** (UBL's cost centre). While typing, the applicant is
   offered the organization's existing branches. A chosen branch is assigned;
   an unknown one is **created** with its details and CRC number.
   **Several branches → `GROUP_ORDER_PORTAL`; one branch → see D2.**
4. **Nothing is created until Head Office approves**: no user, branch,
   approver, level or address.
5. Usernames are derived from email addresses.

## What the shipped approval levels mean for this plan

| Shipped fact | Where | Consequence for the join |
|---|---|---|
| Levels are per organization: 1–10, Level 1 highest, each level one **strict band** (≥ its amount and below the level above; the lowest level also takes everything below its own amount). | `approvalLevelBands` in `lib/order-approval-levels.ts` | The form asks for **one approver per configured level**, not a fixed three, and shows each level's band. |
| A level belongs to the **approver**: `users.order_approval_level`, at most one per user. | `lib/server/user-approval-level.ts` | An approver is not "Ali's approver". A Level 2 holder approves Level 2 orders **at every branch they reach**, for everyone at those branches. Head Office must see that at review. |
| A user may hold a level only if the organization requires approval **and** has levels on, and the role is `GROUP_USER` or the organization's `order_approver_role`. | `canHoldApprovalLevel` | Decides which existing accounts can be reused as approvers, and which form the page shows. |
| A user holding a *different* level cannot also hold this one. | phase 2a decision 3 | A new conflict case at review. |
| Every assignment takes the organization row `FOR SHARE`; the levels save takes it `FOR UPDATE` and refuses to remove a held level. | phase 2a decision 6 | The join approval assigns through the same helper, under the same locks. |
| **Nothing in the order path reads levels yet.** Routing, enforcement and notifications are phase 2b, not built. | `lib/server/order-approval-levels-contract.test.ts` | See *Dependency on phase 2b*: without it, the approvers this form names can approve **any** amount at the initiator's branches. |

## The rule that picks the form

`joinUsesApprovalLevels(organization)` in `lib/organization-join.ts`:
`orderApprovalRequired && orderApprovalLevelsEnabled && levels.length > 0`,
read from the organization the code resolves to. It is the organization half
of `canHoldApprovalLevel` plus "at least one level". Pure, shared by:

* **the lookup**, which tells the page which form to show;
* **the submit endpoint**, which re-reads the organization on that request and
  **refuses the wrong form (400)**: a version 1 body while levels are on (or an
  applicant could skip naming approvers), a version 2 body while they are off.
  Never judged on what the page sends back;
* **the decision**, which re-reads it again (see D7).

## Decisions

Settled by the 2026-10-14/15 discussions:

| # | Decision |
|---|---|
| **S1** | Levels are strict bands (`approvalLevelBands`). |
| **S2** | Routing is by **branch + amount**: an order goes to the holders of its band who reach its branch. No per-requester approver table. |
| **S3** | The form variant follows `joinUsesApprovalLevels`; off = today's form, unchanged. |
| **S4** | The master code in the HTML is replaced by the existing server-checked **join code**, kept as the first step. The HTML's in-page code check must never ship. |
| **S5** | Email domain lock applies to the initiator **and** every approver email. |
| **S6** | The app's password rule (12+ chars, upper, lower, digit, special) is kept over the HTML's. |

Decided 2026-10-15:

| # | Decision |
|---|---|
| **D1** | **Every configured level must have an approver** on the form. Strict bands mean an order in a band with no holder at its branch has no one to decide it. |
| **D2** | **One branch (one CRC) → `ORDER_PORTAL`; more than one → `GROUP_ORDER_PORTAL`.** Derived on the server from the branches finally assigned at approval, never chosen by the applicant. |
| **D3** | **A new approver gets its password the way every new user does**: a random password from `generateRandomPassword`, `must_change_password = true`, and `sendWelcomeEmail` (username + temporary password) after the approval commits, exactly as `POST /api/v1/users` does. The HTML's "Login credentials will be sent to this email" is shown on each level. |
| **D4** | An existing user holding a **different** level is **blocked at review**, never changed automatically. Head Office replaces that level's email at review, or rejects. |
| **D5** | The public lookup shows each level's **band** for a levels-enabled organization, so the applicant can pick the right person. This widens disclosure of the amounts to code holders, deliberately. |
| **D6** | Head Office or a non-level approver deciding a levelled order: **no**. A phase 2b rule. |
| **D7** | The setting changes between submission and decision: the request is decided **as the version it was sent as**. A version 2 request decided while levels are now off (or a level named no longer exists) creates the initiator, branches and addresses, and **assigns no level**; those approver lines are recorded `not_applied`. |
| **D8** | **Everything in this plan applies only to an organization with order approval levels on** (`joinUsesApprovalLevels`). Every other organization keeps today's join form and approval, untouched, and the server refuses a version 2 body for it. |

What the design file (`Apricart Department_Signup_Portal.html`) fixes, and how
each field maps:

| HTML field | Here |
|---|---|
| Complete Name | One field; split into first name (first word) and last name (the rest) |
| Email (`name.surname@ubl.com.pk`) | Local part typed, the organization's own domain fixed as the suffix (the existing domain lock). The `first.last` shape is not enforced: it is UBL's, and the form serves any levels-enabled tenant |
| Username (auto, read-only) | Local part of the email, lower-cased, derived on the server |
| Phone (11 digits) | Required, `0` + 10 digits |
| IP Extension No (3–6 digits) | Required, stored on the user |
| Employee ID | Required |
| Department | Required, one of the HTML's nine values (`DEPARTMENTS`) |
| Role "Order Initiator" (read-only) | Display only; the role is D2 |
| Financial Approver Levels | One card per configured level (not fixed at 3): email (domain-locked), username (auto, read-only), designation; titled with the level's band |
| CRC No (multiple, chips with a checkbox) | Each checked CRC becomes a branch. While typing, existing branches are suggested **by name** from the lookup list (no CRC number ever leaves the server); picking one adds it as a chip. A typed CRC is matched by the server to an existing branch with that cost centre if exactly one exists; otherwise Head Office creates the branch at approval, filling in its name, province, city and address (the HTML collects only the CRC) |
| Delivery Address (multiple, chips with a checkbox) | Each checked address is stored on the request; at approval Head Office assigns each to one of the initiator's branches (automatic when there is one), and it is written to `branch_delivery_addresses` as approved |
| Password / Confirm | The app's rule (12+, upper, lower, digit, symbol) |
| UBL Master Code | **Removed.** The join code, checked on the server, is the first step |
| Terms checkbox | Required, stored as `terms_accepted_at`; the links are omitted until a Terms page exists |

Kept from the first draft unchanged: new branches get a "next steps: assign
products, allocate budget" notice; copying a catalogue or setting a baseline
is later work.

## Design

### Data — `drizzle/<ts>_join_department_signup.sql`

Additive except one replaced check. Hand-written, journal `when` = last + 3600000.

* `organization_join_requests`
  * `form_version smallint NOT NULL DEFAULT 1`
  * `department varchar(80)`, `designation varchar(80)`,
    `ip_extension varchar(16)`, `terms_accepted_at timestamptz`, all nullable
  * `approval_levels_snapshot jsonb`: the bands shown to the applicant
    (`[{level, fromCents, belowCents}]`). Used only so the review shows what the
    applicant agreed to; never read by order routing.
  * `organization_join_requests_scope_shape_ck` becomes
    `(form_version = 1 AND <old rule>) OR (form_version = 2 AND requested_role IN ('ORDER_PORTAL','GROUP_ORDER_PORTAL'))`.
    Every existing row is version 1 and passes.
  * `organization_join_requests_form_version_ck`: `form_version IN (1, 2)`.
* `organization_join_request_branches` (new)
  * `request_id → organization_join_requests ON DELETE CASCADE`, `organization_id`
  * either `existing_branch_id` (picked by name, or a typed CRC the server
    matched to exactly one branch) or `cost_center_id` (a CRC to create),
    never both (check)
  * `resolved_branch_id`, set at approval: the branch created for the CRC, or
    the existing branch Head Office mapped it onto
  * composite tenant keys `(existing_branch_id, organization_id)` and
    `(resolved_branch_id, organization_id)` → `branches (id, organization_id)`;
    added to `tests/integration/tenant-composite-foreign-keys.test.ts`
* `organization_join_request_approvers` (new)
  * `request_id`, `level smallint CHECK (level BETWEEN 1 AND 10)`, `email`,
    `designation`, `UNIQUE (request_id, level)`, `UNIQUE (request_id, email)`
  * at decision: `resolution` (`created` / `assigned` / `extended` /
    `covered` / `not_applied`) and `approver_user_id`
* `organization_join_request_addresses` (new)
  * `request_id`, `organization_id`, `address` (≤ 200)
  * at approval: `branch_id` (Head Office's assignment) and
    `delivery_address_id` (the `branch_delivery_addresses` row written),
    composite tenant key on `(branch_id, organization_id)`
* `users`: `department varchar(80)`, `designation varchar(80)`,
  `ip_extension varchar(16)`, all nullable. No default: an instant `ALTER`.

No `orders` column here: an order's level snapshot belongs to phase 2b.

### Pure logic

* `lib/organization-join.ts`
  * `joinUsesApprovalLevels`
  * `JOIN_FORM_VERSIONS`, the version 2 messages
* `lib/join-department-signup.ts` (new)
  * `deriveUsernameFromEmail` (local part, lower-cased), `deriveNameFromEmail`
    (`huzaifa.abid` → "Huzaifa Abid")
  * `initiatorRoleForBranchCount` (D2)
  * `approverEmailsError`: one per level, at the domain, distinct from each
    other and from the initiator
  * `DEPARTMENTS`, the bounds below, `estimateSubmissionBytes`
* `lib/join-approver-resolution.ts` (new): `planApproverResolution({ level,
  initiatorBranchIds, candidates, organization })`. It returns one of:
  * `create` (no account at that email);
  * `assign` (eligible, holds no level);
  * `extend(branchIds)` (eligible, holds this level, lacks some branches);
  * `covered` (holds this level and already reaches every branch);
  * `blocked(reason)`.

  The `blocked` reasons:
  * another organization;
  * inactive or deleted;
  * several accounts share the email (K-Electric mirrored accounts);
  * a role that cannot hold a level;
  * holds a different level (D4);
  * a `BRANCH_ADMIN` whose one branch does not cover the initiator's branches;
  * is the deciding Head Office user (no self-assignment).

  A `HEAD_OFFICE` holder (approver role `HEAD_OFFICE`) reaches the whole
  tenant and is never extended. Shared by the review preview and the approval,
  so what Head Office sees is what is written.

### Server

* `lib/server/branch-creation.ts`: `createBranchInTx(tx, …)`, moved out of
  `POST /api/v1/branches`, behaviour unchanged. That includes the per-tenant
  advisory lock, the duplicate-name check and the `{ORGCODE}-NN` code. The
  route calls it.
* `lib/server/multi-branch-scope.ts`: `addBranchesToScope(tx, …)`, additive
  and idempotent (`ON CONFLICT DO NOTHING` on
  `user_branch_assignments_user_branch_uq`). Never `replaceMultiBranchScope`
  on an existing approver.
* `lib/server/user-approval-level.ts`: extract the body of
  `setUserApprovalLevel` into `assignApprovalLevelInTx(tx, …)`, which both
  the existing route and the join approval call. One writer of
  `orderApprovalLevel`, one refusal rule, one `ASSIGN_ORDER_APPROVAL_LEVEL`
  audit. The writers list in `order-approval-levels-contract.test.ts` stays
  as it is.
* `createJoinRequest`, version 2: stores the package. It **never looks
  approver emails up**, so the public answer cannot reveal whether a colleague
  has an account. Initiator identity conflicts keep the one flattened message.
* `loadJoinReview` (new): the package plus the preview, for Head Office only:
  * the per-level resolution;
  * who else each approver will approve for ("Level 2 for everyone at Branch
    A, Branch B");
  * duplicate branch names and CRC numbers;
  * username conflicts;
  * which D7 case applies.
* `decideJoinRequest`, version 2, in **one transaction**, locks in the order
  the existing writers use:
  1. Lock the request `FOR UPDATE`. Refuse unless `pending`.
  2. Lock the existing approver users `FOR UPDATE`, in id order. This is the
     same user → organization order as `setUserApprovalLevel`, so the two
     cannot deadlock behind a levels save's `FOR UPDATE`.
  3. Read the organization `FOR SHARE`: approval switch, levels switch,
     approver role and level count.
  4. Create the new branches through `createBranchInTx`, or map them onto
     existing ones as Head Office chose. Set each new branch's group if Head
     Office picked one.
  5. Create the initiator with its role and scope. A one-branch initiator gets
     `branch_id`; a multi-branch one gets `addBranchesToScope`.
  6. Write the addresses to `branch_delivery_addresses` as approved, with
     `requested_by_user_id` = the initiator.
  7. For each level, re-run `planApproverResolution`. If the outcome differs
     from what Head Office reviewed, stop with a 409. Otherwise apply it:
     * create the user (`GROUP_USER`, random temporary password,
       `must_change_password`, D3) and assign its branches;
     * or add the missing branches;
     * then `assignApprovalLevelInTx`.
     `covered` and `not_applied` (D7) write nothing.
  8. Record each resolution on the request's approver rows, mark the request
     approved, and write one audit row per object.

  Any failure rolls the whole package back. After commit, through `after()`:
  * the decision email to the initiator;
  * `sendWelcomeEmail` to each new approver with its temporary password (D3);
  * a notice to each existing approver who gained branches or a level.

### Endpoints

| Route | Change |
|---|---|
| `POST /api/v1/join/lookup` | Also returns `form: "standard" \| "department"` and, for `department`, `approvalLevels: [{ level, fromCents, belowCents }]` (D5) and `departments`. Unchanged for `standard`. |
| `POST /api/v1/join/requests` | Accepts the version 1 body (unchanged) or a version 2 body (`formVersion: 2`, strict). The version must match `joinUsesApprovalLevels` re-read on this request, otherwise 400. Version 2 has no `role`, `username` or organization id, and its `approvers` must cover exactly levels `1..N` of the organization's current levels. Same rate limits, same flattened identity message. |
| `GET /api/v1/join-requests/[id]` | **New.** Head Office, own organization (`resolveJoinManagementScope`), any other is 404: the package and the review preview. |
| `PATCH /api/v1/join-requests/[id]` | Dispatches on the **stored** version. Version 2 takes either `{ replaceApprover: { level, email, designation } }` (Head Office names a different approver for a pending request, audited `REPLACE_ORGANIZATION_JOIN_REQUEST_APPROVER`), or a decision: `newBranches` (details, or `mapToBranchId`, per CRC to create), `addressBranches`, an optional initiator `username`, and the `expectedResolutions` reviewed (required to approve). Strict, re-validated, picked field by field. Version 1 decisions unchanged, and the version 1 path refuses a version 2 request. |

### UI

* `app/join/page.tsx`: the code step is unchanged. After lookup, render
  `JoinRequestForm` (today's form) for `standard`, or the new
  `DepartmentSignupForm` for `department`.
* `components/join/department-signup-form.tsx` (new), to the HTML:
  * initiator fields;
  * a department select;
  * a branch/CRC combobox with "Create new branch…";
  * addresses, each with a branch selector (hidden when there is one branch);
  * one approver row per level, labelled with its band;
  * terms;
  * the username shown read-only, derived from the email;
  * the 8 KB size guard (below).
* `components/join/join-decision-dialog.tsx`: version 1 unchanged. Version 2
  gets a review layout (person, branches, approvers with their bands and
  resolutions, the "also approves for" line, addresses, D7 notice, next steps)
  fed by `GET /api/v1/join-requests/[id]`.

### Bounds (production WAF refuses JSON bodies over 8 KB)

| Field | Bound |
|---|---|
| Approvers | one per level (≤ 10); email ≤ 120; designation ≤ 60 |
| Branches (existing ids and CRCs together) | ≤ 10; a CRC ≤ 32, letters, digits and inner dashes |
| Addresses | ≤ 5, each 5–200 |
| Initiator | complete name ≤ 120, employee ID ≤ 64, phone `0` + 10 digits, IP extension 3–6 digits |

New branch details are given by Head Office at review, not by the applicant.

At these bounds the worst-case ASCII body is about 5.7 KB. A unit test builds
it from the bounds and asserts it stays under 7,500 bytes. The form also
measures the encoded body (`TextEncoder`, so non-Latin text counts at its real
size) and refuses over 8,000 bytes, as `lib/product-request-form.ts` does.

## Dependency on phase 2b (order routing)

This plan writes levels; it does not route orders by them. Until phase 2b
(`plans/OF-APPROVAL-LEVELS-route-orders-by-level.md`, to be written) ships, an
initiator's orders are decided exactly as today. The decider is the branch's
Branch Admin or Head Office (the approver role), or **any** Group User
assigned to the branch. Every approver this form creates is such a Group User,
so **each could approve any amount** at the initiator's branches, whatever
their level.

Phase 2b scope, as far as this plan needs it:

* store the band on the order at creation (`orders.approval_level`, basis
  cents; a group submission is banded on its total);
* in `authorizeOrderDecision`, a levelled order may be decided only by an
  active holder of exactly that level who reaches the branch. No one else may,
  Head Office included (D6). Every claim matches `approval_level`;
* refuse an order at creation when no holder of its band reaches the branch,
  before any hold is taken;
* add a creator ≠ decider guard (D2);
* refuse to remove a level while pending orders sit at it;
* send "awaiting approval" notifications to the band's holders;
* show Head Office a coverage view: for each branch, which levels have no
  holder.

## Security

* **Tenant.** The organization comes only from the code. Every branch id is
  re-checked against it at submission and inside the approval. The new tables
  carry composite tenant keys.
* **Privilege.** The applicant chooses no role, no level and no username. The
  initiator's role is derived from the branch count. Approvers are created
  and levels assigned only by Head Office's approval, through the shipped
  assignment rule. No self-assignment.
* **Enumeration.** Approver emails are looked up only on the authenticated
  Head Office read. The public answers are unchanged: one identity message,
  one unknown-code message.
* **Credentials.** No password is emailed (D3).
* **Disclosure.** The level bands are shown to code holders (D5). The CRC
  numbers of existing branches are never sent to the public page.
* **Races.** Request `FOR UPDATE`, approver users `FOR UPDATE`, organization
  `FOR SHARE`, per-tenant branch advisory lock, and a re-check against the
  reviewed resolution (409 on drift).
* **WAF.** Hard bounds plus the client size guard.

## Tests

* **Unit.**
  * `joinUsesApprovalLevels`;
  * username and name derivation;
  * `approverEmailsError`;
  * `initiatorRoleForBranchCount`;
  * every `planApproverResolution` outcome;
  * the worst-case body size.
* **Contract.**
  * the submit route checks the version against the re-read organization;
  * no approver lookup on the public path;
  * one writer of `order_approval_level` (unchanged list);
  * `lib/server/organization-join.ts` added deliberately to the
    approval-levels readers list;
  * the "exactly one user insert" rule in `organization-join-contract.test.ts`
    is changed on purpose, with the reason stated.
* **Integration** (`tests/integration/organization-join-v2.test.ts`):
  * levels off → version 2 refused and version 1 works as today; levels on →
    version 1 refused;
  * approvers must cover exactly the configured levels;
  * domain lock on approver emails;
  * the package approved and rejected atomically, with each resolution case;
  * a level holder who gained branches;
  * a new approver created with no usable password;
  * a different-level conflict blocked;
  * a cross-tenant email blocked;
  * mirrored-account emails blocked;
  * self-assignment refused;
  * drift between review and approval → 409;
  * D7 in both directions;
  * a levels save racing an approval;
  * Head Office of another tenant gets 404;
  * the audit rows.
* **E2E.** A sign-up with three approvers → Head Office approves → the
  initiator and approvers sign in. Routing assertions are added with phase 2b.

## Phasing

1. **Phase 2b: order routing by level**, its own plan. Recommended before or
   alongside this, so the sign-up's approvers mean what the customer expects.
2. **Join version 2, server and data**: migration, pure modules, branch-creation
   extraction, assignment helper extraction, submit, review, decision.
3. **Join version 2, UI**: the department form and the review dialog.
4. Later: catalogue copy and baseline budget at approval; a report on possible
   purchase splitting.

## Risk and rollback

* Nothing changes for an organization with levels off: it keeps today's form
  and today's approval.
* Rollback: revert the code; pending version 2 requests are rejected by
  script or left. Drop the new tables and columns, and restore the old check.
  Users, branches, addresses and levels already approved are ordinary rows and
  stay.

## Open items

1. **Phase 2b is not built.** Until it is, the sign-up's approvers do not
   enforce amounts (see *Dependency on phase 2b*).
2. The design file was supplied in conversation on 2026-10-15; its field list
   is recorded above.

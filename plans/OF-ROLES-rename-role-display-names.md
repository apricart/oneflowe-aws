# OF-ROLES — Rename four roles' display names

## What changes

| Role code (unchanged) | Was shown as | Now shown as |
|---|---|---|
| `ORDER_PORTAL` | Order Portal / Order Portal User | **Order Initiator** |
| `BRANCH_ADMIN` | Branch Admin | **Financial Approver** |
| `GROUP_ORDER_PORTAL` | Group Order Portal / Group Order Portal User | **Group Order Initiator** |
| `GROUP_USER` | Group User | **Group Financial Approver** |

The two storefronts are renamed with them: `/shop` is the **Order Initiator
Portal**, `/group-portal` the **Group Order Initiator Portal**. The "User"
suffix is dropped.

## What does not change, and why

The role **codes** are the identity of a role everywhere it matters: `roles.name`,
the session token, `rolePermissions`, `organizations.order_approver_role`,
`orders.created_by_role`, `organization_join_requests.requested_role`, every
audit and log row, three check constraints, `proxy.ts` routing and every
authorization rule. Renaming a code would need a data migration, sign every user
out, and rewrite history. So only labels change:

- no migration, no backfill, no session impact;
- `npm run db:seed` writes and looks up roles by code (`Object.keys(ROLE_TEMPLATES)`)
  and never writes a template's display `name`, so it behaves exactly as before;
- usernames keep their `-ba` / `-op` suffixes (`lib/username-generation.ts`
  keys on codes);
- URLs (`/shop`, `/group-portal`), HTML ids and setting keys
  (`hide_prices_for_branch_admin`, …) are identifiers and stay;
- the K-Electric sync and import scripts match roles by code.

No code compares against, parses, or stores a display label (checked by search),
with one exception: spreadsheet user import reads role names typed by people,
so it now accepts "Order Initiator" and "Financial Approver" **as well as** the
old names and the codes.

## Text already in the database

Read-only scan of the local snapshot: labels appear only in already-written
text — Super Admin notification sentences (`notifications.message`), and demo
users' own names. Old notifications keep the wording they were written with;
new ones use the new names. Queued emails store the role code and build their
wording when sent, so they go out with the new names. No row is rewritten.

## Where the names live

`lib/role-display-names.ts` (`ROLE_DISPLAY_NAMES`, `ORDER_PORTAL_NAME`,
`GROUP_ORDER_PORTAL_NAME`, `renamedRoleName`). Every label map that names one of
these roles reads from it — `ROLE_TEMPLATES`, `ORDER_APPROVER_ROLE_LABELS`,
`ORDER_DECISION_ROLE_LABELS`, `ACTOR_ROLE_LABEL`, `JOINABLE_ROLE_LABELS`, the
delivery timeline, order-correction and users-table labels — and screens that
built a label from the code (settings, shop profile menu, budget-burn watchlist,
order page heading) ask `renamedRoleName` first. Sentences carry the new words
directly. `lib/role-display-names.test.ts` pins the names and that the role
templates agree.

## Telling people: the one-time notice after sign-in

After each sign-in the landing page shows a short notice: "This is only a name
change", that nothing else is affected, and each rename as *old name → new
name*, the new name highlighted. Who sees what (`roleRenamesToAnnounce` in
`lib/role-rename-notice.ts`):

| Signed in as | Sees |
|---|---|
| `GROUP_USER`, `GROUP_ORDER_PORTAL` | the two group renames |
| `BRANCH_ADMIN`, `ORDER_PORTAL` | the two branch renames |
| Head Office and every other role | all four |

Mechanics: the login page marks the notice due in the tab's `sessionStorage`
(`markRoleRenameNoticeDue`) just before it redirects; the notice
(`components/shell/role-rename-notice.tsx`) is mounted by every landing area —
`PortalShell` and the shop, group-portal, order-desk, executive and warehouse
layouts — and shows when the session is signed in and the mark is set. "Got it"
or the close button clears the mark, so it appears once per sign-in and never
mid-session; a reload does not bring it back. Blocked storage means no notice,
never an error. Nothing is stored on the server and nothing is decided by it.
Switch it off with `ROLE_RENAME_NOTICE_ENABLED` once people are used to the
names.

Because the notice is modal, every Playwright journey that signs in through the
form registers `closeRoleRenameNoticeWhenShown` (`tests/e2e/support/session.ts`),
which closes it the way a person would; `tests/e2e/role-rename-notice.spec.ts`
is the journey about the notice itself and does not.

## Risk and rollback

Display only. Rolling back is reverting the commit; nothing persisted depends on
the new words. Users will see new names in screens and emails from deploy time.

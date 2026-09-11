# OF-KE-PARITY — Bring production K-Electric to parity with the legacy platform

**Status:** draft, pending review
**Scope:** organization 10 (`K-Electric`, code `0001`) in the production database only
**Author:** drafted 2026-09-10 from the read-only investigation in `deliverables/investigation/`

---

## 1. Goal

K-Electric's data in the production database should represent what the legacy
logistics platform (`https://logistics.oneflowe.com`) holds today, expressed in
the OneFlowe schema.

Production is already close. Money reconciles exactly — **all 916 shared orders
match legacy's `GrandTotal` to the cent, zero drift**. All 136 legacy branches
exist and are correctly pinned by `external_id` with no name differences. All
148 legacy people exist. All 152 catalogue items trace to legacy via
`legacy_product_mappings`.

The remaining divergence is concentrated in order **status**, account
**identity**, and the **organization price tier**.

## 2. Decisions taken

Recorded here because they determine the whole shape of the work.

| # | Decision | Consequence |
|---|---|---|
| D1 | **Legacy is authoritative for order status as it stands today.** | 82 orders must be re-stated from legacy's current `DeliveryStatus`. Budget spend/held must be recomputed afterwards. |
| D2 | **Legacy is authoritative for accounts.** | The 8 soft-deleted identities legacy still lists are restored; the 10 identities production has that legacy does not are retired, after their 19 orders are reattributed. |
| D3 | **Global product prices stay exactly as they are in production. The K-Electric *organization* tier carries legacy's prices.** | Writes go to `organization_inventory.custom_price_cents` for organization 10. `global_products.base_price_cents` is never touched. |

### Why D3 is the correct instruction, not merely an acceptable one

31 of K-Electric's 148 products are **shared global products**:

| Tenant | Shared products |
|---|---|
| K-E-Demo (org 2) | 25 |
| UBL (org 6) | 16 |
| EFU (org 7) | 3 |

Writing legacy prices into `global_products.base_price_cents` would have
repriced UBL's and EFU's live catalogues as a side effect. The organization tier
is tenant-scoped, so it cannot. This also matches the price ladder in
`lib/server/effective-price.ts` and the downward rule in `CLAUDE.md`: setting an
organization price touches neither the global tier above it nor — since
K-Electric has **zero** rows in `group_inventory_prices` — any group below it.
Every one of the 137 branches inherits the organization price directly.

## 3. Current state (evidence)

Measured read-only on 2026-09-10 against production and the live legacy API.
Source data: `deliverables/investigation/reconcile-to-legacy.txt`,
`ke-sync-2026-09-09.json`, `ke-budget-spend-backfill-preflight.json`.

| Entity | Legacy | Production | Divergence |
|---|---|---|---|
| Branches | 136 | 137 | 1 extra (`Technical`, id 245, no `external_id`) |
| Groups | 4 | 4 | 2 branch→group assignments pending |
| People | 148 | 158 identities (+8 soft-deleted) | 10 with no legacy counterpart |
| Products (KE inventory) | 157 | 145 mapped | 12 to create, 2 with no legacy price |
| Orders (live) | 930 | 929 imported | 14 missing; 13 anomalous; 82 status-drifted; **0 total-drifted** |
| Org price tier | per-product | 146 rows set to global base, 2 unset | 60 differ from legacy |
| Budget spend | — | ₨51.76M recorded | ₨1.2M understated |

### The blocker

`readCurrent()` in `scripts/sync-ke.ts:234` filters `deleted_at is null`, so the
sync cannot see the 8 accounts soft-deleted on 2026-09-05 and plans to insert
them. `users_username_idx` is `CREATE UNIQUE INDEX ... ON public.users (username)`
— no partial predicate, so soft-deleted rows still hold their usernames. The
commit would raise `23505` and roll the whole transaction back.

Under D2 this resolves itself: restoring the 8 accounts (WS1) makes them visible
to `readCurrent`, and `peopleToCreate` falls to 0. **All 8 own zero orders**, so
restoring them is safe and needs no reattribution.

## 4. Workstreams

Ordered. WS4 must precede WS7 — budget spend depends on whether an order counts
as spent or held, which is exactly what WS4 changes.

### WS1 — Restore the 8 soft-deleted identities *(new, small)*

Clear `deleted_at` and restore `is_active` for the 8 accounts whose passcodes
legacy still lists: `12297`, `7676648`, `15377084`, `09418` (×2 roles each).

- Verified: all 8 own **zero** orders, so nothing is reattributed.
- Must be reversible and must write a `system_logs` row per account.
- **Unblocks WS2.**

### WS2 — `sync:ke` against `--organization-code=0001` *(existing tool)*

Delivers: 12 products, 59 budget rows for 2026-09, 6 branch moves, 2 group
assignments. Refuses to touch prices, deletes nothing.

- **Run twice.** People at branches created in the same run are skipped as
  `BRANCH_NOT_PINNED`; a second pass picks them up. A third should report
  nothing to do.
- Re-run the dry run at commit time — today's digest
  (`0b8c5644…`) expires the moment anything moves.

### WS3 — `import:ke-orders` *(existing tool)*

Delivers the 14 orders from 2026-09-07→09 (₨625,324). Dry run reported
**0 rejected, 0 unresolved** across the entire 1,078-row history.

### WS4 — Order status resync *(NEW TOOLING REQUIRED)*

No existing script does this: `ALREADY_IMPORTED` is a skip reason, so the
importer never revisits an order it has already written.

82 orders disagree with legacy today:

| production | legacy today | orders |
|---|---|---|
| APPROVED / NOT_STARTED | APPROVED / IN_PROCESS | 30 |
| APPROVED / NOT_STARTED | FULFILLED / DELIVERED | 25 |
| APPROVED / IN_PROCESS | FULFILLED / DELIVERED | 21 |
| APPROVED / NOT_STARTED | APPROVED / OUT_FOR_DELIVERY | 3 |
| APPROVED / OUT_FOR_DELIVERY | FULFILLED / DELIVERED | 1 |
| FULFILLED / DELIVERED | APPROVED / OUT_FOR_DELIVERY | 1 |
| REFUNDED / DELIVERED | FULFILLED / DELIVERED | 1 |

Design:

- Pure planner in `lib/legacy-import/ke-status-resync.ts`, unit-tested, reusing
  the exported `mapDeliveryStatus` from `ke-orders-api.ts` — **do not
  reimplement the mapping**.
- Script `scripts/resync-ke-order-status.ts`: dry-run default, plan-digest
  gated, one transaction, `system_logs` per order, `--rollback` from the
  committed report. Follow `backfill-ke-budget-spend.ts` as the template.
- Must **not** touch `total_cents`, `order_items`, stock, invoice sequences, or
  send email. This is a ledger correction, not an order lifecycle event.
- The two backwards transitions (legacy orders **619** and **1155**) are
  reported for human review and **excluded from the automatic pass** — a
  `REFUNDED` order in production that legacy thinks is merely `FULFILLED` is a
  fact legacy does not know about, and D1 should not silently erase a refund.

### WS5 — Identity merge *(BLOCKED — needs a decision, see §8.1)*

**Investigation during implementation invalidated this workstream's original
design.** It is not a merge of duplicates. Legacy has **recycled employee
passcodes between people**, and production is holding the older assignment.

Matching all 142 mirrored K-Electric emails against legacy's `Passcode`:

| | count |
|---|---|
| production `external_id` agrees with legacy | 123 |
| **disagrees** | **12** |
| production email absent from legacy entirely | 7 |

The 12 disagreements are two different problems:

**(a) Same person, different code — 5 cases.** Legacy simply uses another
passcode for them. `15377`→`15377084`, `7676`→`7676648`, `9418`→`09418`,
`16291`→`12297`, and Syed Kashif Raza `11631`→`17124`. Production already holds
both codes for each of these people.

**(b) Recycled codes — 7 cases.** Each synthetic `ke<n>` account maps by email
to exactly one legacy person with a real passcode — but **production already
holds that passcode under a different person**, and those people own 30 orders:

| passcode | legacy says | production holds | prod orders | in legacy? |
|---|---|---|---|---|
| `18979` | Muhammad Shafique | Mohatashim | 0 | **absent** |
| `16476` | Malaika Fayyaz Khan | Danyal Ahmed Siddiqui | 3 | **absent** |
| `12973` | Shaima Rizwan | M Zeeshan | 8 | **absent** |
| `11820` | Imran-ul-Hassan | Syed Samar Abbass | 6 | **absent** |
| `11631` | Syed Musharaf Hassan | Syed Kashif Raza | 3 | yes, now `17124` |
| `16701` | Irfa Qadir | Waheed Rehman | 0 | **absent** |
| `18716` | Hamza Ali Shareef | SHEHRYAR AMAN | 10 | **absent** |

Six of the seven displaced people **do not exist in legacy at all** — they are
almost certainly departed staff whose codes were reissued. Their orders are real
and their history must be preserved.

`users_org_external_identity_role_uq` is
`(organization_id, external_source, external_id, role_id)`, so the new holder
cannot take the passcode while the old one still carries it. Any fix has to
decide what happens to the departed person's identity first — most likely
de-mirroring them (`external_source` → null) so they become a local historical
account that keeps its orders and releases the code.

**This is not safe to automate on the evidence available.** It reassigns
identity between real people and moves ₨-value spend between them. It needs
K-Electric to confirm the departures. Deferred; nothing is built for it.

### WS6 — Organization price tier from legacy *(NEW TOOLING REQUIRED)*

Implements D3.

- Target column: `organization_inventory.custom_price_cents`, organization 10.
- Source: the legacy modal price per product — the same value
  `planProducts()` already computes. `ProductPlan.priceDrift` exposes it as
  `legacyModalCents` for the 60 that differ; for the other 85 the modal price
  already equals the current value. **Extend `ExistingProduct` in
  `lib/legacy-import/ke-products.ts` to carry `legacyModalCents` for every
  mapped product** rather than inferring "no drift means equal" — the inference
  is correct today and silently wrong the day the comparison base changes.
- Expected writes: ~148 rows, all **updates** — 146 already hold a
  `custom_price_cents` and 2 active rows hold `NULL`; the row itself exists in
  every case, so nothing is inserted. Only ~60 actually change a value; the rest
  are no-ops and should be planned as such, not written.
- **Never writes `global_products.base_price_cents`.** Add an explicit assertion,
  and a test that fails if the script can reach that column.
- Legacy prices vary per branch; the sync's modal-price rule and its outlier
  reporting apply unchanged. The last dry run reported
  `productsWithPriceOutliers: 0`, so today every product's branches agree.
- **RBAC:** this is a price write. It must route through
  `lib/pricing-access.ts` (`canMutatePrices`), and the operator must be an
  active `SUPER_ADMIN` — the same gate `sync-ke.ts` applies via
  `--actor-user-id`. If any of this is ever exposed as an endpoint, it must also
  be added to the route list in `lib/pricing-access.test.ts`.

### WS7 — `backfill:ke-budget-spend` *(existing tool)*

**Runs after WS4**, because 76 of the 82 status corrections move value from
*held* to *spent*.

Last preflight (pre-WS4): 74 updates, 23 inserts, 76 allocations raised, target
spent ₨52.97M against ₨51.76M recorded. These numbers **will change** once WS3
and WS4 land — re-run the preflight and use its fresh digest.

Only ever raises an allocation, never lowers, so it cannot trip
`budgets_values_valid_ck`.

### WS8 — Adjudicate the 13 anomalous orders *(decision, then possibly tooling)*

- **6 orders with no legacy row at all** (`41, 44, 51, 53, 60, 87`, all Jan
  2025) — imported by the original one-off migration from a snapshot the legacy
  list endpoint no longer serves. Under D1, does "legacy is authoritative" mean
  these should be removed, or that legacy's *list endpoint* has simply aged out?
  **Recommend: keep, and record why.** Deleting real historical spend because an
  API window moved is not obviously right.
- **7 orders whose legacy row is now non-live**: five `REFUNDED` totalling
  ₨1.15M against legacy `StatusID 4` (test), two `FULFILLED` against
  `StatusID 1` (draft). Needs a human look at each.

### WS9 — Placeholder-attributed orders *(decision)*

15 `legacy_ke_*@historical.invalid` accounts own 35 orders (₨700k). Legacy could
not attribute them to a person at import time. Either resolve them to real users
or accept them as permanent. No tool exists; scope after WS5, which may resolve
some of them incidentally.

### WS10 — Branch `Technical` (id 245) *(small)*

In production, not in legacy. 2 users (both leaving via WS2's branch moves), 0
orders, 1 budget. After WS2 it is empty. Deactivate rather than delete — the
budget row references it.

## 5. Order of execution

```
WS1  restore 8 accounts            → unblocks WS2
WS2  sync:ke  (run twice)          → branches, groups, products, 2026-09 budgets
WS3  import:ke-orders              → 14 orders
WS4  status resync   [NEW]         → 82 orders  (must precede WS7)
WS5  identity merge  [NEW]         → 19 orders reattributed, 20 accounts retired
WS6  org price tier  [NEW]         → ~148 organization_inventory rows
WS7  backfill:ke-budget-spend      → recompute spend/held from corrected state
WS8-10  adjudicate and tidy
```

## 6. Verification

After each workstream, re-run
`deliverables/investigation/reconcile-to-legacy.ts` (read-only). Parity is
reached when it reports:

- branches: 0 extra, 0 missing, 0 renamed
- people: 0 legacy identities missing, 0 production-only identities
- orders: 0 legacy-live-not-in-production, 0 status drift, 0 total drift
- and `sync:ke` dry run prints *"Nothing to sync: OneFlowe already matches the
  legacy platform."*

For WS6 specifically, assert that
`SELECT count(*) FROM global_products WHERE updated_at > <run start>` is **zero**.

## 7. Risk and rollback

- Every step is dry-run by default and digest-gated. Every new script gets a
  `--rollback` mode reading its own committed report, following
  `backfill-ke-budget-spend.ts` and `regenerate-usernames.ts`.
- **Take a database backup before WS1** and confirm the restore path. Several of
  these steps are not individually reversible once a later step builds on them —
  in particular WS7 recomputes from whatever WS4 left behind.
- **Blast radius:** organization 10 only. Organization 2 (`K-E-Demo`) shares 211
  email addresses and 25 global products with K-Electric and must never be
  touched — every script here is tenant-gated by `--organization-code` and must
  assert `organization_id = 10` on every write.
- Production carries four other live tenants (UBL took an order 2026-09-09).
  Nothing in this plan is a whole-database operation.
- Do not run any of this against the test database expecting the same digests;
  its K-Electric is organization 3 with different ids throughout.

## 8. Open questions

### 8.1 Recycled passcodes — blocks WS1, WS2 and WS5

The one that matters. K-Electric needs to confirm, for the seven people in
§WS5(b), that the displaced holder has left and the code was reissued. Until
then:

- **WS5 cannot run** — it would move one person's spend onto another's identity.
- **WS1 must not run alone.** Restoring `7676648`, `15377084` and `09418` while
  `7676`, `15377` and `9418` are still active re-creates the very duplicate
  accounts someone cleaned up on 2026-09-05. WS1 is only safe as the first half
  of a WS1+WS5 pair in one maintenance window.
- **WS2 stays blocked** behind WS1, so the 12 products, 59 budgets and 6 branch
  moves wait with it.

WS4 and WS6 are independent of all this and are ready now.

### 8.2 Resolved during implementation

- **Refunds — settled: legacy is *not* authoritative.**
  `scripts/clear-ke-unsubstantiated-refunds.ts` records why: legacy's
  `RefundPrice` reconstructs the billed line but is not a per-order refund
  figure — at one branch the same product carries the same `RefundPrice` on four
  orders, summing past the order total. It was deliberately never imported. A
  dry run confirms production currently holds **0** unsubstantiated refund
  amounts, so all 65 of its refunds came from the separately reconciled source
  and are correct. This is why the status resync refuses to restate a `REFUNDED`
  order (legacy order 619).

### 8.3 Still open, but blocking nothing

- **Two products with no legacy price** (`Green Tea Material (Spices)`,
  `Toothbrush Colgate`) — every legacy row carries zero. WS6 reports and skips
  them rather than writing zero. Confirm they should stay at their current
  price, or be deactivated.
- **Two products with an ambiguous legacy price** — WS6's planner found two
  inventory rows where legacy's item list and price history disagree. Reported
  and skipped; needs a look.
- **WS8** — keep or remove the 6 orders legacy no longer lists.

## 9. Implementation status

| Workstream | State |
|---|---|
| WS4 order status resync | **Built, tested, dry run clean** — `lib/legacy-import/ke-status-resync.ts` (16 tests), `scripts/resync-ke-order-status.ts` |
| WS6 organization prices | **Built, tested, dry run clean** — `lib/legacy-import/ke-org-prices.ts` (15 tests), `scripts/set-ke-organization-prices.ts`; `ExistingProduct.legacyModalCents` added to `ke-products.ts` |
| WS1, WS2, WS3, WS5 | Blocked on §8.1 |
| WS7 | Waits on WS3/WS4 landing |
| WS8, WS9, WS10 | Decisions outstanding |

### Verified dry runs (2026-09-10, nothing written)

**WS4 — `scripts/resync-ke-order-status.ts`**

```
ordersConsidered 929 | toChange 80 | unchanged 834 | held 9 | missingFromLegacy 6
  APPROVED/NOT_STARTED    -> APPROVED/IN_PROCESS       30
  APPROVED/NOT_STARTED    -> FULFILLED/DELIVERED       25
  APPROVED/IN_PROCESS     -> FULFILLED/DELIVERED       21
  APPROVED/NOT_STARTED    -> APPROVED/OUT_FOR_DELIVERY  3
  APPROVED/OUT_FOR_DELIVERY -> FULFILLED/DELIVERED      1
  held: LEGACY_NOT_LIVE 7, REFUNDED_LOCALLY 1, BACKWARD_TRANSITION 1
```

**WS6 — `scripts/set-ke-organization-prices.ts`**

```
rowsConsidered 148 | toChange 58 | unchanged 81 | skipped 9 | fromInherited 1
  effect on what branches pay: 37 increases, 21 decreases
  skipped: NOT_IN_LEGACY 5, AMBIGUOUS_LEGACY_PRICE 2, LEGACY_HAS_NO_PRICE 2
```

Both scripts refuse to commit without `--confirm-organization`,
`--confirm-plan-sha256` and `--expected-changes`, rebuild the plan under an
advisory lock and abort if the digest moved, write an `audit_logs` row, compare
before/after fingerprints of the global tier and every other tenant, and support
`--rollback` from their committed report. The price script additionally requires
an `--actor-user-id` that `canMutatePrices` accepts, i.e. an active
`SUPER_ADMIN`.

## 10. Security note (out of scope, raise separately)



`GET /api/SubUser/0/1` on the legacy platform returns all 148 staff records —
names, emails, phone numbers, **and passwords in plaintext** — to an
unauthenticated caller. Every endpoint the sync uses is open. This is a live
exposure of the client's data and should be raised with K-Electric independently
of this migration.

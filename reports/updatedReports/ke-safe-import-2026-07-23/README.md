# K-Electric safe incremental import source

This directory contains the reviewed 2026-07-23 incremental source for
organization `10`, code `0001`, name `K-Electric`.

- Candidate orders: 51
- Item rows: 505
- Quantity: 3,839
- Total: PKR 3,832,147.00
- Tax: PKR 0.00
- Source system: `KE_LOGISTICS`

The source deliberately excludes:

- every order already present in `legacy_order_imports`;
- refunded and non-final orders;
- orders with unresolved prices or financial mismatches;
- legacy IDs `250`, `1165`, and `1177`, which contain zero-quantity item
  artifacts;
- post-2026-07-10 summary-only activity without authoritative order IDs and
  item-level order totals.

`candidate-manifest.json` records the exact allowlist, totals, construction
rules, source hashes, and generated-file hashes. The `reports/` subdirectory is
the immutable input consumed by the guarded importer.

## Import result

The source was committed atomically to K-Electric on 2026-07-23.

- Batch ID: `8b9acdb1-808d-4dd7-a951-185de0257809`
- Source manifest digest:
  `3a0e8217b1406aac86bca6cb5b9efe2a461086041e44667bf6a4e70c7185fd02`
- Post-import validation: `PASS`
- Post-import idempotency: 51 already imported, 0 ready, 0 blockers

The checksum-protected immediate baseline is
`backups/ke-import-state-2026-07-23-pre-incremental-51-orders.json`.

# K-Electric remaining legacy orders report

Generated: 2026-07-23T08:53:57.954Z

## Executive summary

The known legacy universe contains **811 unique order IDs**. The verified live K-Electric import ledger contains **645 unique IDs** (594 from the original import plus 51 from the safe incremental batch). Therefore, **166 known legacy orders remain and are not safe to import with the current evidence**.

| Exclusive blocker | Orders |
|---|---:|
| Final delivered status is not confirmed | 92 |
| Refund activity exists | 25 |
| Item prices and quantities do not reconcile to the subtotal | 19 |
| A trustworthy item price cannot be resolved | 13 |
| Previously known order is omitted from both updated order and sales exports | 7 |
| Sales lines exist but the authoritative order header is missing | 6 |
| Order contains zero-quantity item lines | 3 |
| Authoritative header has no item lines | 1 |
| **Total** | **166** |

The categories are mutually exclusive: every one of the 166 remaining legacy IDs appears exactly once.

## Reasons and exact legacy IDs

### Final delivered status is not confirmed — 92

**Reason:** The authoritative header is not in the only normal fulfilled state accepted by the importer (StatusID 2 and DeliveryStatus 507).

**Needed before import:** A corrected authoritative order header proving the order reached final delivered status, or a separate migration policy for non-fulfilled orders.

**Detail:** StatusID/DeliveryStatus breakdown: 2/503 = 1, 2/505 = 1, 2/506 = 2, 5/501 = 88.

**Legacy order IDs:** 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 172, 175, 176, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 196, 197, 198, 199, 204, 210, 211, 212, 213, 214, 248, 407, 408, 409, 633, 722, 723, 729, 731, 754, 755, 756, 757, 758, 759, 760, 765, 778, 877, 878, 879, 894, 897, 898, 906, 912, 924, 925, 926, 937, 983, 1008, 1009, 1010, 1011, 1012, 1013, 1037, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1050, 1105, 1142, 1155, 1164, 1187, 1189, 1190

### Refund activity exists — 25

**Reason:** The refund report identifies the order. Importing it as an ordinary fulfilled sale would overstate sales and lose the refund history.

**Needed before import:** A refund-aware migration design with authoritative item, refund amount, timestamp, and final-state evidence.

**Legacy order IDs:** 43, 173, 174, 177, 192, 238, 362, 421, 515, 520, 574, 580, 616, 619, 640, 675, 683, 702, 753, 811, 827, 987, 1015, 1085, 1100

### Item prices and quantities do not reconcile to the subtotal — 19

**Reason:** The reconstructed sum of item price multiplied by quantity differs from the authoritative order subtotal.

**Needed before import:** Corrected line-level quantity and unit-price evidence that reconciles exactly to the order subtotal.

**Legacy order IDs:** 118, 154, 158, 159, 161, 216, 217, 628, 704, 936, 997, 1029, 1032, 1083, 1099, 1102, 1112, 1131, 1156

### A trustworthy item price cannot be resolved — 13

**Reason:** Available reports conflict or do not contain enough evidence to select an exact unit price without guessing.

**Needed before import:** A consistent authoritative unit price for every item line, with totals that reconcile to the header.

**Legacy order IDs:** 145, 400, 406, 485, 672, 677, 712, 727, 771, 777, 989, 1018, 1117

### Previously known order is omitted from both updated order and sales exports — 7

**Reason:** The legacy ID existed in the earlier reports but disappeared from the updated authoritative order and sales data.

**Needed before import:** A synchronized export containing the authoritative header and item lines for the missing legacy ID.

**Legacy order IDs:** 1168, 1169, 1170, 1171, 1172, 1173, 1184

### Sales lines exist but the authoritative order header is missing — 6

**Reason:** The sales export contains the legacy ID, but the updated order export has no matching header with final status, totals, refund state, and timestamps.

**Needed before import:** The original authoritative order header matching the existing sales lines.

**Legacy order IDs:** 41, 44, 51, 53, 60, 87

### Order contains zero-quantity item lines — 3

**Reason:** The reports otherwise reconcile, but importing a zero-quantity order line would create a misleading order record.

**Needed before import:** A corrected line export with positive quantities, or explicit approval and a documented rule to remove zero-quantity artifacts before import.

**Legacy order IDs:** 250, 1165, 1177

### Authoritative header has no item lines — 1

**Reason:** The order header exists, but no matching item detail is available to construct the order.

**Needed before import:** The complete line-level sales report for the legacy order.

**Legacy order IDs:** 415

## Later summary-only activity is not included in the 166-order count

`productSummery.json` contains 213 rows dated 2026-07-13T00:00:00 through 2026-07-23T00:00:00 that are not present in `UserProductSummary.json`. They can be grouped into 16 location/user/date/status combinations, but those are only analytical groupings—not authoritative orders.

- Row statuses: Delivered 68, Order Placed 10, Out For Delivery 135.
- Group statuses: Delivered 6, Order Placed 3, Out For Delivery 7.
- They have no legacy order ID, authoritative header, or complete order-level totals, so they cannot be counted or imported as exact orders.

## Conclusion

None of these 166 identified legacy IDs should be imported as a normal fulfilled K-Electric order using the current evidence. The three zero-quantity cases are closest to importable, but they still require corrected quantities or an explicitly approved cleanup policy. Refund and non-final workflow records require a separate migration treatment rather than the normal fulfilled-order importer.

Evidence: `reports\updatedReports\ke-safe-import-2026-07-23\post-import-validation.json`, `tmp\ke-updated-investigation\reports\order.json`, `tmp\ke-updated-investigation\reports\sales-report.json`, and `reports\updatedReports\refundReport.json`.

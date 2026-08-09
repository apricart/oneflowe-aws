# OneFlowe production load-test report

- Started: 2026-08-09T06:57:27.589Z
- Finished: 2026-08-09T07:01:39.795Z
- Target: https://oneflowe.apricart.com
- Peak concurrent virtual users: 1000
- Workload: 50% BRANCH_ADMIN, 50% ORDER_PORTAL; read-only user journeys
- Request timeout: 20000 ms

## Overall result

- Verdict: **FAIL**
- Requests: 6527
- Completed-request throughput: 30.68 requests/second
- Successful-request throughput: 12.62 requests/second
- Errors: 3843 (58.88%)
- Latency p50 / p95 / p99: 20001.56 / 20022.85 / 20059.84 ms

Pass criteria: the test reaches 1,000 VUs, HTTP/request errors remain below 1%, and p95 latency remains below 2,000 ms.

## Stage results

| Stage | Target VUs | Requests | Completed RPS | Successful RPS | Errors | p50 | p95 | p99 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| warmup-10 | 10 | 35 | 2.49 | 2.49 | 0% | 655.77 ms | 8280.45 ms | 9895.48 ms |
| load-100 | 100 | 400 | 11.69 | 9.61 | 17.75% | 1100.04 ms | 20006.04 ms | 20012.67 ms |
| load-250 | 250 | 888 | 22.54 | 16.73 | 25.79% | 3329.57 ms | 20008.28 ms | 20016.97 ms |
| load-500 | 500 | 1341 | 30.14 | 17.93 | 40.49% | 10368.76 ms | 20012.18 ms | 20024 ms |
| load-1000 | 1000 | 2927 | 48.33 | 14.10 | 70.82% | 20003.71 ms | 20039.05 ms | 20078.63 ms |

## Endpoint results

| Endpoint | Requests | Errors | Average | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| branch_admin/orders | 654 | 69.11% | 15297.85 ms | 20026.17 ms | 20078.63 ms |
| order_portal/shop_page | 218 | 5.05% | 3378.67 ms | 10743.46 ms | 15262.31 ms |
| branch_admin/categories | 352 | 12.22% | 4857.99 ms | 20001.98 ms | 20018 ms |
| order_portal/session | 283 | 16.61% | 5420.96 ms | 20007.23 ms | 20014.07 ms |
| branch_admin/notifications | 506 | 65.02% | 14125.39 ms | 20025.86 ms | 20056.85 ms |
| order_portal/budgets | 677 | 36.19% | 11236.55 ms | 20015.23 ms | 20040.09 ms |
| branch_admin/dashboard_page | 295 | 5.42% | 3331.6 ms | 10755.94 ms | 20009.06 ms |
| order_portal/orders | 885 | 65.42% | 15118.26 ms | 20032 ms | 20065.58 ms |
| branch_admin/dashboard_analytics | 602 | 53.49% | 13724.25 ms | 20026.94 ms | 20066.05 ms |
| branch_admin/session | 282 | 10.99% | 4531.62 ms | 20003.89 ms | 20010.5 ms |
| order_portal/visible_inventory | 1047 | 99.71% | 19517.61 ms | 20028.01 ms | 20075.83 ms |
| branch_admin/branch_inventory | 726 | 99.72% | 19536.43 ms | 20026.63 ms | 20064.36 ms |

## Notes

- This was a read-only, mixed-role test: 50% branch-admin and 50% order-portal virtual users.
- The two supplied sessions were reused; authentication itself was not multiplied 1,000 times.
- Results include application, database/cache, TLS/network, and single-generator effects.
- No order creation, approval, inventory mutation, or other write endpoint was exercised.

## Findings and recovery

- The first clearly failing stage was 100 VUs: 17.75% errors and a p95 at the 20-second timeout.
- At 1,000 VUs, only 854 of 2,927 requests completed successfully (14.10 successful requests/second); 70.82% failed.
- Across the whole run, failures were 3,535 response timeouts and 308 connection timeouts. No HTTP 4xx or 5xx response was recorded.
- Both inventory endpoints were effectively unavailable under load: 99.72% errors for branch-admin inventory and 99.71% for order-portal visible inventory.
- The source strongly suggests database/pool saturation amplified by an inventory cache stampede: the checked-in local environment uses a 10-connection application pool (the production override was not observed); inventory cache entries expire after five seconds; cache misses are not coalesced; and inventory requests perform database setting/budget checks before the cached listing lookup. This is an inference from source and test behavior, not a substitute for AWS/RDS metrics.
- After the test, three database-backed health checks returned HTTP 200 in 2.62, 1.92, and 1.43 seconds. The login page returned HTTP 200 in 0.65 seconds, confirming recovery.

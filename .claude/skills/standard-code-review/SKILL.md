---
name: standard-code-review
description: Review a change against the Engineering Development & Security Standard review checklist - requirements, architecture, correctness, tests, security, authorization, database impact, performance, observability, maintainability and migration/rollback risk - reported by severity. Use when reviewing a PR, a diff, or your own work before submitting it.
---

# Code Review

**Do not modify files during a review.** Report findings; fix only when asked.

## Input

Review the diff, but read enough surrounding code to judge it — a change is
correct or not in context, and a reviewer who has read only the diff cannot
tell.

## Checklist

### Requirements

Does the change satisfy the acceptance criteria? Does it do anything the ticket
did not ask for? Is anything in the ticket left undone and unmentioned?

### Architecture

Layers respected (rule 01)? Business logic in `lib/`, not in a route handler or
a component? Does this reimplement something that already exists —
`lib/error-handler.ts`, `lib/rate-limiter.ts`, `lib/permissions.ts`,
`lib/server/effective-price.ts`, `lib/inventory-cascade.ts`? A new abstraction
introduced where an existing pattern would have served?

### Correctness

Trace the logic. Off-by-one; null and undefined; empty collection; integer vs
float on money; timezone; rounding; unhandled promise rejection; an error path
that swallows. What happens on the second concurrent call?

### Security

Run the `standard-security-check` skill. At minimum here: is authorization
asserted server-side, is every tenant query scoped, is untrusted input
validated, is anything secret leaking into a client payload or a log?

### Authorization

The permission checked matches the sensitivity of the action. No inline role
comparison where a `Permission` exists. No trust in a client-supplied id.

### Tests

Do the new tests cover the new behaviour, or do they restate the
implementation? Are authorization and tenant-isolation cases present? Was an
existing test deleted, skipped, or weakened — and why? Do contract-test route
lists include the new routes?

### Database

Migration additive and reversible? Index for the new filter or sort? Query
bounded? Transaction where a read-then-write happens? Lock duration on a large
table? Rollback plan stated?

### Performance

N+1 queries in a list endpoint. Unbounded result sets. Work in a loop that
belongs in one query. A blocking call on a request path. Cache keys correctly
scoped and invalidated.

### Observability

Privileged and financial actions audited. Errors logged with enough context to
diagnose and no secrets. Correlation ids present.

### Maintainability

Names that say what the thing is. Functions doing one thing. Comments
explaining why, not what. Dead code, debug statements, and TODOs without a
ticket removed. Does this match how the surrounding code is written?

### Migration and rollback risk

What happens to in-flight requests and existing rows during deploy? Can this be
reverted without data loss? Is there a state where old code meets new data?

## Report

Findings grouped by severity, most serious first:

- **Critical** — must not merge: security hole, data loss, breaks production.
- **High** — fix before merge: incorrect behaviour, missing authorization test,
  unsafe migration.
- **Medium** — should fix: missing test case, performance risk, poor error
  handling.
- **Low** — worth fixing: naming, duplication, clarity.

Each finding: file and line, what is wrong, why it matters, what to do instead.
List missing tests separately. Then say plainly whether the change is ready to
merge.

Distinguish what you verified from what you inferred, and do not pad the review
with findings you are not confident in.

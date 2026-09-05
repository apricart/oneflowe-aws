---
name: standard-feature-development
description: Build a feature end-to-end under the Engineering Development & Security Standard - read requirements, write a plan under plans/, implement against existing patterns, add unit and integration tests, run the security and quality gates, and prepare the PR. Use when starting any non-trivial change, a new endpoint, a schema change, or work tracked by a Jira ticket.
---

# Feature Development

The standard lifecycle: **Jira → Plan → Implement → Test → Security → Quality
gates → PR**. Do not skip to implementation on non-trivial work.

## 1. Understand before writing

- Read the ticket: objective, acceptance criteria, dependencies, API/UI
  requirements, data impact, security considerations, error and edge-case
  behaviour. If acceptance criteria are missing or ambiguous, say so now — not
  after the code is written.
- Read the code you will change **and its `.test.ts` sibling**. The test states
  the current guarantee.
- Read `CLAUDE.md` for architecture and the load-bearing domain rules
  (pricing tiers, K-Electric import, mirrored accounts).
- Identify: which route handlers, which `lib/` modules, which tables, which
  roles and permissions, which existing patterns already solve part of this.

## 2. Plan

For anything non-trivial — a new endpoint, a schema change, a change to
authorization or pricing, or a change spanning several modules — write
`plans/<JIRA-ID>-<feature>.md` covering:

- **Objective and acceptance criteria**
- **Architecture** — which layer each piece belongs in (rule 01); anything new
  and why an existing pattern does not fit
- **API** — endpoints, methods, request/response shapes, status codes
- **Data** — schema changes, migration, backfill, rollback
- **Security** — authentication, permission required, tenant scoping,
  validation, rate limiting, audit; the threats considered (rule 04)
- **Tests** — what will be unit-tested, what needs integration, what needs E2E
- **Risks** — what breaks if this is wrong; blast radius on live tenants
- **Steps** — ordered, each independently verifiable

Confirm the plan before implementing anything substantial.

## 3. Implement

- Follow existing patterns. Route through `lib/error-handler.ts`,
  `lib/rate-limiter.ts`, `lib/permissions.ts`, `lib/server/effective-price.ts`,
  `lib/inventory-cascade.ts`, `lib/global-logger.ts` rather than reimplementing.
- Business logic in `lib/`; route handlers stay thin (rule 01).
- Work in verifiable increments. Run the relevant tests as you go, not at the
  end.
- For a protected endpoint, use the `standard-api-endpoint` skill.

## 4. Test

Use the `standard-testing` skill. Minimum:

- Unit tests beside the code for every new or changed business rule.
- Integration tests in `tests/integration/` where a boundary changed — SQL,
  constraints, a route handler.
- Authorization and tenant-isolation tests for anything protected.
- If you added a route in a category covered by a contract test
  (`lib/pricing-access.test.ts`, `lib/server/security-boundaries.test.ts`), add
  it to that route list.

## 5. Security review

Use the `standard-security-check` skill on the diff before opening the PR.

## 6. Quality gates

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Plus `npm run test:integration` when the change touched SQL, schema, or a route
handler — and check it did not skip.

## 7. Close out

- Re-read the acceptance criteria and confirm each one, explicitly.
- Update the plan if the implementation diverged.
- Update `CLAUDE.md` if you introduced or changed a load-bearing rule.
- Prepare the PR per rule 07: what, why, testing evidence, security impact,
  database impact, risk and rollback.

## Report

State what changed, which tests were added, which commands you ran and their
real results, what the security impact is, and anything you could not finish.
If a check failed, say so with the output — never report a gate as passing
without having run it.

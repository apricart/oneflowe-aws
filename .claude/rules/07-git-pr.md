# 07 — Git and Pull Requests

## Branches and commits

- Branch names contain the Jira ID: `feature/OF-123-budget-carryforward`,
  `fix/OF-456-order-duplicate`.
- Commits are focused and buildable. One logical change per commit.
- The commit message says what changed and why, not "fixes".
- **Never commit**: `.env.local`, credentials, tokens, keys, customer data
  exports, `.xls`/`.json` dumps of real orders or users, `node_modules`,
  `.next`, build artefacts.
- Do not commit or push unless asked to.

## Pull requests

A PR states:

1. **What** changed and **why** — with the Jira link.
2. **How it was tested** — commands run, and what the integration suite
   actually did (it skips silently without `TEST_DATABASE_URL`; say if it
   skipped).
3. **Security impact** — authentication, authorization, tenant isolation,
   input validation, secrets, audit. "None" is an acceptable answer only when
   it is true and you checked.
4. **Database impact** — schema change, migration, backfill, index, lock
   duration, rollback plan.
5. **Risk and rollback** — what breaks if this is wrong, and how it is undone.
6. **Screenshots** for UI changes.

## CI gates

`.github/workflows/dev-check.yml` must pass before merge:

`npm ci --ignore-scripts` → `npm audit --audit-level=high` → `npm test` →
`npm run typecheck` → `npm run lint` → `npm run build`, plus a gitleaks secret
scan whose findings appear in the job summary.

- A PR does not merge on a failing required check.
- The gitleaks scan is report-only — **read the job summary**. A finding there
  is a real finding even though the job is green.
- Do not bypass required review or CI. Do not disable a lint rule inline to get
  a green build; fix the code or raise the exception properly (rule 08).
- A failing check is diagnosed, not retried.

## Review

Every PR gets a human review against rule 04 (security) and the code-review
skill. AI-assisted review supplements it and does not replace it — the author
and the reviewer remain accountable for the merged code.

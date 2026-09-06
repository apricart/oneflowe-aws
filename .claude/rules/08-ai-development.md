# 08 — AI-Assisted Development

Claude may be used for planning, implementation, testing, review, and
documentation. The rules below are conditions of that use.

## Accountability

- **The developer who merges the code owns the code.** "Claude wrote it" is
  never an explanation for a defect, a security hole, or a design you cannot
  justify in review.
- Read and understand every generated line before committing it. If you cannot
  explain what a block does and why it is there, it does not go in.
- AI-generated tests are still reviewed. A test that asserts the implementation
  it was generated alongside proves nothing.
- Verify framework APIs against `node_modules/next/dist/docs/` or existing
  repository usage. This Next.js version differs from model training data
  (see `AGENTS.md`) — a plausible-looking API may not exist.

## Data handling

Never provide to an AI tool:

- production credentials, connection strings, private keys, session tokens
- customer PII — real names, emails, phone numbers, addresses, employee codes
- exported production data (the `*.xls` / `orders*.json` files in the repo root
  are exactly this)
- anything regulated, without explicit approval under the data-handling policy

Use synthetic or redacted data when you need a realistic example. Before
pasting a file, ask whether it would be acceptable in a public issue tracker.

## Workflow

For non-trivial work:

1. Plan first — `plans/<JIRA-ID>-<feature>.md`. Use the
   `standard-feature-development` skill.
2. Implement incrementally against existing patterns.
3. Test — use `standard-testing`.
4. Security review — use `standard-security-check`.
5. Self-review — use `standard-code-review`.
6. Human review at the PR.

## Boundaries for the agent

- Do not weaken, disable, or delete a security control, a test, or a lint rule
  to make something pass. Report the conflict instead.
- Do not run destructive or data-mutating commands against a real database.
- Do not commit, push, or open a PR unless explicitly asked.
- Do not add a dependency without saying so.
- When a requirement conflicts with these rules, stop and say so rather than
  quietly choosing one.

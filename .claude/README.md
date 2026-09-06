# Engineering Development & Security Standard — OneFlowe adaptation

The organization's Engineering Development & Security Standard v1.0 was written
for **Python + Poetry + Ruff + Black + Pytest**, delivered as **Cursor** rules
(`.cursor/rules/*.mdc`) and skills. This directory is that standard adapted to
this repository's stack — **Next.js App Router + TypeScript + Drizzle/Postgres
+ NextAuth + Vitest** — and to **Claude Code**.

Nothing normative was dropped. Every mandatory requirement in the source
standard is carried here; the tooling and the examples are this repository's.

## Layout

```
.claude/
  rules/     mandatory rules, imported into CLAUDE.md and always in context
  skills/    workflow skills, invoked on demand by name
```

Rules are loaded automatically through the `@` imports at the bottom of
`CLAUDE.md`. Skills are invoked explicitly:

| Skill | Use it when |
|---|---|
| `/standard-feature-development` | starting any non-trivial change |
| `/standard-api-endpoint` | adding or changing a route handler or Server Action |
| `/standard-testing` | writing tests or judging coverage |
| `/standard-security-check` | before opening a PR; reviewing sensitive code |
| `/standard-code-review` | reviewing a diff or your own work |

The skill names are prefixed `standard-` so they do not collide with Claude
Code's built-in `/code-review` and `/security-review`, and so the whole set
groups together in the skill list.

## Mapping from the source standard

| Source (Cursor / Python) | Here | Change |
|---|---|---|
| `.cursor/rules/00-project-overview.mdc` | `rules/00-project-overview.md` | Reading order for this repo; production-safety note; the Next.js version caveat from `AGENTS.md` |
| `01-architecture.mdc` | `rules/01-architecture.md` | Layer table for App Router: route handlers / `lib/` / `lib/server/` / `db/` / components; `proxy.ts` named as *not* the authorization boundary; multi-tenant scoping |
| `02-python-standards.mdc` | `rules/02-typescript-standards.md` | Poetry/Ruff/Black/Pytest → npm / TypeScript / ESLint / Vitest / Next build. Adds money-in-cents, no floating promises, no `any` at trust boundaries |
| `03-testing.mdc` | `rules/03-testing.md` | Pytest → the two Vitest projects plus Playwright. Adds the repo's contract-test pattern and the silent-skip trap in the integration suite |
| `04-security.mdc` | `rules/04-security.md` | Expanded from 4 lines to the full section-8 threat catalogue, rewritten in this codebase's terms (Drizzle `sql.raw`, S3 keys, NextAuth sessions, `lib/pricing-access.ts`, Redis cache keys) |
| `05-api-standards.mdc` | `rules/05-api-standards.md` | The required order for a protected handler, a status-code table, mass-assignment and idempotency rules, caching |
| `06-database.mdc` | `rules/06-database.md` | SQLAlchemy-neutral → Drizzle/Postgres: the three database identities, transaction rules, live-migration rules, the dry-run script pattern |
| `07-git-pr.mdc` | `rules/07-git-pr.md` | Points at the real gates in `.github/workflows/dev-check.yml`, including that the gitleaks scan is report-only and its summary must be read |
| `08-ai-development.mdc` | `rules/08-ai-development.md` | Cursor/Claude → Claude Code. Adds explicit agent boundaries and names the production data files that must never be pasted into a tool |
| — | `rules/09-frontend.md` | **New.** The source standard assumed a Python backend and had no frontend rules. In a Next.js app the client/server boundary carries real security weight |
| `skills/feature-development` | `skills/standard-feature-development` | Same lifecycle, this repo's commands and plan contents |
| `skills/testing` | `skills/standard-testing` | Same coverage matrix, Vitest projects, contract tests |
| `skills/security` | `skills/standard-security-check` | Same categories, expanded with concrete checks and a severity model |
| `skills/code-review` | `skills/standard-code-review` | Same checklist, expanded into what to actually look for |
| — | `skills/standard-api-endpoint` | **New.** This app has ~89 route handlers; the protected-endpoint requirements in section 9 of the standard deserved their own procedure |

## Not yet ported

The source repository also contains `STANDARD.md`, a `Makefile`, a CI workflow,
a PR template, a plan template, and the `docs/` matrices (RBAC, database
access, developer checklist, Jira workflow). Those were out of scope for this
pass, which covers rules and skills only.

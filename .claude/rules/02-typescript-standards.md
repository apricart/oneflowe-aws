# 02 — TypeScript Standards

Replaces the Python/Poetry/Ruff/Black section of the standard.

## Toolchain

| Concern | Tool | Command |
|---|---|---|
| Package management | npm (lockfile committed) | `npm ci` |
| Types | TypeScript | `npm run typecheck` |
| Lint | ESLint 10 (flat config, `typescript-eslint`, `sonarjs`, `react-hooks`) | `npm run lint` |
| Unit/contract tests | Vitest (jsdom) | `npm test` |
| Integration tests | Vitest (node) | `npm run test:integration` |
| E2E | Playwright | `npm run e2e` |
| Build | Next.js | `npm run build` |

## Required local checks before opening a PR

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Run `npm run test:integration` as well when the change touches SQL, schema,
constraints, or a route handler — CI runs it against a throwaway Postgres on
every PR to `dev` and every production deploy, and fails if the suites skip.
These are the same checks `.github/workflows/dev-check.yml` runs, so a green
local run predicts a green CI run.

## Code rules

- **Type the boundaries.** Exported functions get explicit parameter and return
  types. Inference is fine inside a function body.
- **`any` is a defect at a trust boundary.** Untrusted input — request bodies,
  query parameters, external API responses, CSV rows — is parsed with a Zod
  schema (see `lib/server/mutation-validation.ts`) and typed from the parse
  result. `any` in older internal code is tolerated; do not add more of it on
  the path of new data.
- Prefer small cohesive functions with explicit dependencies over large
  functions reading module state.
- No mutable module-level state. Caches go through `lib/cache-utils.ts`.
- Money is handled in **integer cents** (`*Cents` suffix). Never float
  arithmetic on currency. Quantities go through `lib/quantity.ts`.
- Dates crossing a boundary are ISO strings or `Date`, never locale-formatted
  strings.
- No `console.log` in committed code. Use `lib/global-logger.ts`.
- No dead code, commented-out blocks, or debug scaffolding in a PR.
- Do not add a dependency without a reason recorded in the PR. Pin it; the
  `overrides` block in `package.json` exists to hold transitive versions down
  and must not be loosened casually.

## Async and errors

- Every `await` that can reject is either handled or deliberately allowed to
  propagate to `handleError`. No floating promises.
- Errors surfaced to a client go through `lib/error-handler.ts`. Never return a
  raw error message, a stack trace, or a database error string to a caller.
- Use `safeAsync` from `lib/error-handler.ts` where a failure is expected and
  recoverable.

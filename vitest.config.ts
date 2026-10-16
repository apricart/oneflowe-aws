import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { domTsTestPatterns } from './tests/support/unit-test-environments'
import { projectRoot, sharedAlias, sharedCoverage, sharedExclude } from './vitest.shared'

/**
 * Unit and contract tests: everything that runs with no external service.
 *
 * These must stay runnable on a laptop with nothing installed and in CI with no
 * database, so anything needing Postgres lives under `tests/integration/` and is
 * excluded here — run it with `npm run test:integration`.
 *
 * Two projects share these settings and differ only in environment: component
 * tests and any `.ts` test that touches a browser global run under jsdom, the
 * rest under node, which starts far faster. The split is decided by
 * `tests/support/unit-test-environments.ts`.
 */
const unitExclude = [
    ...sharedExclude,
    'tests/e2e/**',
    // Needs a live Postgres; `npm run test:integration` runs these.
    'tests/integration/**',
]

const domTsTests = domTsTestPatterns(projectRoot)

export default defineConfig({
    plugins: [react()],
    test: {
        globals: true,
        // password-hasher.test.ts hashes with real bcrypt at cost 10 and 12.
        // That is ~2s of actual work, but under full-suite parallelism on a
        // 2-core CI runner it overruns the 5s default and times out.
        testTimeout: 30000,
        // Throwaway server env so a unit test may import code under
        // `lib/server/`. Points the database at an address nothing listens on —
        // unit tests must never reach one.
        setupFiles: ['./tests/setup/unit-env.ts'],
        exclude: unitExclude,
        alias: sharedAlias,
        coverage: sharedCoverage('coverage/unit'),
        projects: [
            {
                extends: true,
                test: {
                    name: 'dom',
                    environment: 'jsdom',
                    include: ['**/*.test.tsx', ...domTsTests],
                },
            },
            {
                extends: true,
                test: {
                    name: 'node',
                    environment: 'node',
                    include: ['**/*.test.ts', '**/*.test.mjs'],
                    exclude: [...unitExclude, ...domTsTests],
                },
            },
        ],
    },
})

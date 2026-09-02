import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { sharedAlias, sharedExclude } from './vitest.shared'

/**
 * Unit and contract tests: everything that runs with no external service.
 *
 * These must stay runnable on a laptop with nothing installed and in CI with no
 * database, so anything needing Postgres lives under `tests/integration/` and is
 * excluded here — run it with `npm run test:integration`.
 */
export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        // password-hasher.test.ts hashes with real bcrypt at cost 10 and 12.
        // That is ~2s of actual work, but under full-suite parallelism on a
        // 2-core CI runner it overruns the 5s default and times out.
        testTimeout: 30000,
        // Throwaway server env so a unit test may import code under
        // `lib/server/`. Points the database at an address nothing listens on —
        // unit tests must never reach one.
        setupFiles: ['./tests/setup/unit-env.ts'],
        exclude: [
            ...sharedExclude,
            'tests/e2e/**',
            // Needs a live Postgres; `npm run test:integration` runs these.
            'tests/integration/**',
        ],
        alias: sharedAlias,
    },
})

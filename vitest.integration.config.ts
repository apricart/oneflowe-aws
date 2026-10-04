import { defineConfig } from 'vitest/config'

import { sharedAlias, sharedCoverage, sharedExclude } from './vitest.shared'

/**
 * Integration tests: real code against a real Postgres.
 *
 * Differences from the unit project, all of them deliberate:
 *
 *  * **node, not jsdom** — this exercises server modules and SQL, and jsdom's
 *    fetch/URL shims only get in the way.
 *  * **One file at a time** (`fileParallelism: false`). The tests share one
 *    database; running files in parallel would let one suite's cleanup delete
 *    another's fixtures.
 *  * **A setup file that fills the server env** before any module loads, so
 *    importing `@/lib/db` resolves to the throwaway test database and never to
 *    a developer's real `DATABASE_URL`.
 *
 * With no `TEST_DATABASE_URL` set, every suite here skips itself and reports
 * why, so this stays runnable — and green — on a machine with no database.
 */
export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['tests/integration/**/*.test.ts'],
        exclude: sharedExclude,
        setupFiles: ['./tests/setup/integration-env.ts'],
        // Schema setup and multi-row fixtures are slower than a unit test, and
        // a cold connection to a remote database can take a few seconds.
        testTimeout: 60000,
        hookTimeout: 60000,
        fileParallelism: false,
        alias: sharedAlias,
        coverage: sharedCoverage('coverage/integration'),
    },
})

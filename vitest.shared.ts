import path from 'node:path'
import { fileURLToPath } from 'node:url'

const configDirectory = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = configDirectory

/**
 * Module aliases every Vitest project shares.
 *
 * `@` mirrors the `tsconfig.json` path alias. `server-only` is redirected to an
 * empty module so a test may import code under `lib/server/`: the real package
 * throws on import outside a React Server Component, and it still does so in
 * the application build — only Vitest sees the stub.
 */
export const sharedAlias = {
  '@': path.resolve(configDirectory, './'),
  'server-only': path.resolve(configDirectory, './tests/support/server-only-stub.ts'),
}

/**
 * Coverage settings both projects share. Collected only when a run passes
 * `--coverage` (`npm run test:coverage`, `npm run test:integration:coverage`),
 * so an ordinary `npm test` is unchanged. Both measure the same application
 * code and write lcov, which SonarCloud reads and merges: unit tests cover the
 * pure rules, integration tests cover the route handlers and SQL.
 */
export function sharedCoverage(reportsDirectory: string) {
  return {
    provider: 'v8' as const,
    reporter: ['lcov', 'text-summary'],
    reportsDirectory,
    include: [
      'app/**/*.{ts,tsx}',
      'components/**/*.{ts,tsx}',
      'db/**/*.ts',
      'hooks/**/*.{ts,tsx}',
      'lib/**/*.{ts,tsx}',
      'proxy.ts',
    ],
    exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
  }
}

/** Directories that never contain tests, for either project. */
export const sharedExclude = [
  'node_modules/**',
  '.next/**',
  // The Playwright suite's own dev-server build dir (`NEXT_DIST_DIR`).
  '.next-e2e/**',
  'dist/**',
  'tmp/**',
]

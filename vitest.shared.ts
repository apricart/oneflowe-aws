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

/** Directories that never contain tests, for either project. */
export const sharedExclude = [
  'node_modules/**',
  '.next/**',
  // The Playwright suite's own dev-server build dir (`NEXT_DIST_DIR`).
  '.next-e2e/**',
  'dist/**',
  'tmp/**',
]

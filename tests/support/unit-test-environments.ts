import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Which unit test files need a browser-like environment.
 *
 * Booting jsdom costs every test file real time, and most of the unit suite
 * is pure rules and source contracts that never touch the DOM. So the unit
 * project runs in two environments: every `.test.tsx` file, and every `.ts`
 * test that mentions a browser global, run under jsdom; everything else runs
 * under node.
 *
 * The rule reads the test file itself, so a new test that reaches for
 * `window` or `localStorage` lands in jsdom without anyone maintaining a
 * list. It errs towards jsdom: a word like "document" in a comment only costs
 * that file the slower environment. A per-file `@vitest-environment` pragma
 * still overrides either choice.
 */
export const DOM_GLOBAL_PATTERN =
  /\b(window|document|localStorage|sessionStorage|navigator|renderHook|@testing-library|HTMLElement|jsdom)\b/

/** Directories that never hold unit tests. Skipped so the walk stays fast. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'coverage',
  'dist',
  'tmp',
  'backups',
  'outputs',
  'playwright-report',
  'test-results',
])

function isSkippedDirectory(name: string): boolean {
  return SKIPPED_DIRECTORIES.has(name) || name.startsWith('.next-')
}

function collectTsTestFiles(root: string, relativeDirectory: string, found: string[]): void {
  const absolute = path.join(root, relativeDirectory)
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (!isSkippedDirectory(entry.name)) collectTsTestFiles(root, relative, found)
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      found.push(relative)
    }
  }
}

/** Escapes a literal path so a glob matcher reads it as itself. */
export function escapeGlob(literal: string): string {
  return literal.replace(/[()[\]{}*?!+@|]/g, '\\$&')
}

/**
 * Project-relative `.test.ts` paths, as glob patterns, whose source mentions a
 * browser global. The integration and browser suites are not unit tests and
 * are left out.
 */
export function domTsTestPatterns(root: string): string[] {
  const files: string[] = []
  collectTsTestFiles(root, '', files)
  return files
    .filter((file) => !file.startsWith('tests/integration/') && !file.startsWith('tests/e2e/'))
    .filter((file) => DOM_GLOBAL_PATTERN.test(readFileSync(path.join(root, file), 'utf8')))
    .sort()
    .map(escapeGlob)
}

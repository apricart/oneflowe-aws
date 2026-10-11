import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadEnvConfig } from '@next/env'
import { parse } from 'dotenv'

import { MIGRATION_ENV_FILES, type MigrationEnvironment } from '../migration-target'
import { parseMigrationEnv } from './env-validation'

export function loadMigrationEnv() {
  loadEnvConfig(process.cwd())
  return parseMigrationEnv(process.env)
}

/**
 * The environment a per-environment migration run sees: only that
 * environment's files (`MIGRATION_ENV_FILES`), an earlier file winning over a
 * later one, and the shell winning over every file. Nothing is written to
 * `process.env`, and `.env.local` is never read unless the environment lists it.
 */
export function readMigrationEnvFor(
  environment: MigrationEnvironment,
  cwd: string = process.cwd(),
): { env: Record<string, string | undefined>; filesRead: string[] } {
  const merged: Record<string, string | undefined> = {}
  const filesRead: string[] = []

  for (const file of [...MIGRATION_ENV_FILES[environment]].reverse()) {
    const path = join(cwd, file)
    if (!existsSync(path)) continue
    Object.assign(merged, parse(readFileSync(path)))
    filesRead.unshift(file)
  }

  return { env: { ...merged, ...process.env }, filesRead }
}

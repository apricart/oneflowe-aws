import { loadEnvConfig } from '@next/env'

import { parseMigrationEnv } from './env-validation'

export function loadMigrationEnv() {
  loadEnvConfig(process.cwd())
  return parseMigrationEnv(process.env)
}


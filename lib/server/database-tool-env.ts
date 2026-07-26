import { loadEnvConfig } from '@next/env'

import { parseDatabaseToolEnv } from './env-validation'

// Standalone `tsx` tools do not receive Next.js environment loading.
loadEnvConfig(process.cwd())

export const databaseToolEnv = parseDatabaseToolEnv(process.env)


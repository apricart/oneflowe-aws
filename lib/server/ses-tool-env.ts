import { loadEnvConfig } from '@next/env'

import { parseSesToolEnv } from './env-validation'

// Standalone tsx tools do not receive Next.js environment loading.
loadEnvConfig(process.cwd())

export const sesToolEnv = parseSesToolEnv(process.env)

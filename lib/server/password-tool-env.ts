import { loadEnvConfig } from '@next/env'

import { parsePasswordToolEnv } from './env-validation'

// Standalone tsx tools do not receive Next.js environment loading.
loadEnvConfig(process.cwd())

export const passwordToolEnv = parsePasswordToolEnv(process.env)

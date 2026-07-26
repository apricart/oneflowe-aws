import { loadEnvConfig } from '@next/env'

import { parseBootstrapEnv } from './env-validation'

export function loadBootstrapEnv() {
  loadEnvConfig(process.cwd())
  return parseBootstrapEnv(process.env)
}


import { loadEnvConfig } from '@next/env'
import { Redis } from '@upstash/redis'

import { parseOptionalRedisToolEnv } from '@/lib/server/env-validation'

// Standalone cache-maintenance utilities cannot import the Next.js-only
// `server-only` runtime module.
loadEnvConfig(process.cwd())
const redisToolEnv = parseOptionalRedisToolEnv(process.env)

export const redis = redisToolEnv
  ? new Redis({
      url: redisToolEnv.UPSTASH_REDIS_REST_URL,
      token: redisToolEnv.UPSTASH_REDIS_REST_TOKEN,
    })
  : null

import 'server-only'

import { createDatabaseConnection } from '@/lib/db-core'
import { env } from '@/lib/server/env'

const connection = createDatabaseConnection({
  databaseUrl: env.DATABASE_URL,
  nodeEnv: env.NODE_ENV,
  poolMax: env.PGPOOL_MAX,
  idleTimeoutMs: env.PGPOOL_IDLE_MS,
  connectionTimeoutMs: env.PGPOOL_CONN_TIMEOUT_MS,
  statementTimeoutMs: env.PG_STATEMENT_TIMEOUT_MS,
})

export const db = connection.db
export const pool = connection.pool
export const testConnection = connection.testConnection
export const closePool = connection.closePool
export const getPoolStats = connection.getPoolStats

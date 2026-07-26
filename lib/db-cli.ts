import { createDatabaseConnection } from '@/lib/db-core'
import { databaseToolEnv } from '@/lib/server/database-tool-env'

/** Database connection for standalone `tsx` utilities only. */
const connection = createDatabaseConnection({
  databaseUrl: databaseToolEnv.DATABASE_URL,
  nodeEnv: databaseToolEnv.NODE_ENV,
  poolMax: databaseToolEnv.PGPOOL_MAX,
  idleTimeoutMs: databaseToolEnv.PGPOOL_IDLE_MS,
  connectionTimeoutMs: databaseToolEnv.PGPOOL_CONN_TIMEOUT_MS,
  statementTimeoutMs: databaseToolEnv.PG_STATEMENT_TIMEOUT_MS,
  // Import and maintenance commands can query personal or credential-adjacent
  // values. Keep SQL parameters out of terminal logs unless explicitly opted in.
  logQueries: process.env.DATABASE_CLI_LOG_QUERIES === 'true',
})

export const db = connection.db
export const pool = connection.pool
export const testConnection = connection.testConnection
export const closePool = connection.closePool
export const getPoolStats = connection.getPoolStats

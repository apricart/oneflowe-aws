import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool, type PoolClient, type PoolConfig } from 'pg'

import * as schema from '@/db/schema'

export type DatabaseConnectionConfig = {
  databaseUrl: string
  nodeEnv: 'development' | 'test' | 'production'
  poolMax: number
  idleTimeoutMs: number
  connectionTimeoutMs: number
  statementTimeoutMs: number
  logQueries?: boolean
}

function parseDatabaseUrl(
  databaseUrl: string,
  nodeEnv: DatabaseConnectionConfig['nodeEnv'],
): PoolConfig {
  const parsed = new URL(databaseUrl)
  const port = parsed.port ? Number(parsed.port) : 5432
  const isSupabase = parsed.hostname.includes('supabase')

  return {
    host: parsed.hostname,
    port,
    database: parsed.pathname.slice(1),
    user: parsed.username ? decodeURIComponent(parsed.username) : 'postgres',
    password: parsed.password ? decodeURIComponent(parsed.password) : '',
    // Preserve the existing Supabase pooler behavior. Other production
    // databases must present a certificate trusted by the Node.js runtime.
    ssl: isSupabase
      ? { rejectUnauthorized: false }
      : nodeEnv === 'production'
        ? { rejectUnauthorized: true }
        : false,
  }
}

export function createDatabaseConnection(config: DatabaseConnectionConfig) {
  const logQueries = config.logQueries ?? config.nodeEnv === 'development'
  const pool = new Pool({
    ...parseDatabaseUrl(config.databaseUrl, config.nodeEnv),
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs,
    allowExitOnIdle: true,
  })

  pool.on('error', (error) => {
    console.error('Unexpected error on idle database client', {
      type: error.name,
      timestamp: new Date().toISOString(),
    })
  })

  if (logQueries) {
    pool.on('connect', () => console.log('Database client connected'))
    pool.on('acquire', () => console.log('Database client acquired from pool'))
    pool.on('remove', () => console.log('Database client removed from pool'))
  }

  const db = drizzle(pool, {
    schema,
    logger: logQueries,
  })

  async function testConnection(): Promise<boolean> {
    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      await client.query('SELECT 1')
      return true
    } catch {
      console.error('Database connection test failed')
      return false
    } finally {
      client?.release()
    }
  }

  async function closePool(): Promise<void> {
    await pool.end()
  }

  function getPoolStats() {
    return {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      timestamp: new Date().toISOString(),
    }
  }

  return { db, pool, testConnection, closePool, getPoolStats }
}

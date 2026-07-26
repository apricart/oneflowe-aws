#!/usr/bin/env tsx
/**
 * Export the runtime database to a SQL file.
 * Usage: tsx scripts/export-db.ts [output-file.sql]
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { databaseToolEnv } from '../lib/server/database-tool-env'

const parsedUrl = new URL(databaseToolEnv.DATABASE_URL)
const databaseConfig = {
  host: parsedUrl.hostname,
  port: parsedUrl.port || '5432',
  database: parsedUrl.pathname.slice(1),
  user: decodeURIComponent(parsedUrl.username),
  password: decodeURIComponent(parsedUrl.password),
}

const outputFile =
  process.argv[2] || `database-export-${new Date().toISOString().split('T')[0]}.sql`
if (
  outputFile !== basename(outputFile) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.sql$/.test(outputFile) ||
  outputFile.includes('..')
) {
  throw new Error('Output must be a plain .sql file name without paths or traversal sequences.')
}

const outputPath = resolve(process.cwd(), outputFile)
if (dirname(outputPath) !== resolve(process.cwd())) {
  throw new Error('Output path must remain in the current working directory.')
}

console.log('Exporting database...')
console.log(`Output: ${outputPath}`)

try {
  const outputFd = openSync(outputPath, 'wx', 0o600)
  const result = spawnSync(
    'pg_dump',
    [
      `--host=${databaseConfig.host}`,
      `--port=${databaseConfig.port}`,
      `--username=${databaseConfig.user}`,
      `--dbname=${databaseConfig.database}`,
      '--no-owner',
      '--no-acl',
      '--clean',
      '--if-exists',
      '--verbose',
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: databaseConfig.password,
      },
      cwd: process.cwd(),
      stdio: ['ignore', outputFd, 'inherit'],
      shell: false,
      timeout: 5 * 60 * 1000,
      killSignal: 'SIGTERM',
    },
  )
  closeSync(outputFd)
  if (result.error || result.status !== 0) {
    unlinkSync(outputPath)
    throw result.error ?? new Error(`pg_dump exited with status ${result.status}`)
  }
  console.log('Database exported successfully.')
} catch {
  console.error('Database export failed. Verify pg_dump is installed and DATABASE_URL is valid.')
  process.exit(1)
}

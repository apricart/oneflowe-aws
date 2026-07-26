import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REQUIRED_RUNTIME_VARIABLES = Object.freeze([
  'DATABASE_URL',
  'NEXTAUTH_URL',
  'NEXTAUTH_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'CRON_SECRET',
])

export const OPTIONAL_RUNTIME_VARIABLES = Object.freeze([
  'PGPOOL_MAX',
  'PGPOOL_IDLE_MS',
  'PGPOOL_CONN_TIMEOUT_MS',
  'PG_STATEMENT_TIMEOUT_MS',
  'BCRYPT_ROUNDS',
  'INACTIVITY_TIMEOUT_MINUTES',
  'SESSION_VALIDATION_CACHE_TTL_SECONDS',
  'RATE_LIMIT_TRUST_PROXY_HOPS',
  'ORDER_TOKEN_ADMIN_EMAIL',
  'AWS_REGION',
  'SES_FROM_EMAIL',
  'SES_CONFIGURATION_SET',
])

export const AMPLIFY_RUNTIME_VARIABLES = Object.freeze([
  ...REQUIRED_RUNTIME_VARIABLES,
  ...OPTIONAL_RUNTIME_VARIABLES,
])

function environmentValue(source, name) {
  const value = source[name]
  return typeof value === 'string' ? value : undefined
}

function serializeEnvironmentValue(name, value) {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`${name} cannot contain NUL or newline characters`)
  }

  // Next.js expands unescaped dollar signs while loading .env files. Escape
  // them so a secret containing "$" survives the build/runtime handoff.
  const escapedValue = value.replaceAll('$', '\\$')

  // Keep ordinary URLs, tokens, and numeric settings unquoted. Use a delimiter
  // only when dotenv would otherwise trim or treat part of the value as a
  // comment. Choosing a delimiter not present in the value avoids mutation.
  if (!/[\s#'"`]/.test(value)) return escapedValue

  if (!value.includes("'") && !value.endsWith('\\')) return `'${escapedValue}'`
  if (!value.includes('`') && !value.endsWith('\\')) return `\`${escapedValue}\``

  throw new Error(`${name} cannot be represented safely in a Next.js environment file`)
}

export function serializeRuntimeEnvironment(source = process.env) {
  const missing = REQUIRED_RUNTIME_VARIABLES.filter((name) => {
    const value = environmentValue(source, name)
    return value === undefined || value.trim() === ''
  })

  if (missing.length > 0) {
    throw new Error(
      `Missing required Amplify build environment variables: ${missing.join(', ')}`,
    )
  }

  const includedNames = AMPLIFY_RUNTIME_VARIABLES.filter((name) => {
    const value = environmentValue(source, name)
    return value !== undefined && value !== ''
  })

  const contents = includedNames
    .map((name) => `${name}=${serializeEnvironmentValue(name, environmentValue(source, name))}`)
    .join('\n')

  return {
    contents: `${contents}\n`,
    includedNames,
  }
}

export function writeRuntimeEnvironmentFile(
  source = process.env,
  outputPath = resolve(process.cwd(), '.env.production'),
) {
  const serialized = serializeRuntimeEnvironment(source)

  writeFileSync(outputPath, serialized.contents, {
    encoding: 'utf8',
    mode: 0o600,
  })
  chmodSync(outputPath, 0o600)

  return serialized.includedNames
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined

if (invokedPath === import.meta.url) {
  try {
    const includedNames = writeRuntimeEnvironmentFile()
    console.log(
      `Prepared .env.production with ${includedNames.length} allowlisted server runtime variables.`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to prepare .env.production')
    process.exitCode = 1
  }
}

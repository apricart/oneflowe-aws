import { z } from 'zod'

const PLACEHOLDER_VALUES = new Set([
  'admin123',
  'change-me',
  'changeme',
  'default',
  'dummy',
  'example',
  'null',
  'password',
  'password123',
  'replace-me',
  'secret',
  'todo',
  'undefined',
  'your-password-here',
  'your-secret',
])

function normalizedPlaceholderCandidate(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')
}

export function isPlaceholderValue(value: string): boolean {
  return PLACEHOLDER_VALUES.has(normalizedPlaceholderCandidate(value))
}

function requiredValue(name: string) {
  return z
    .string({ error: `${name} is required` })
    .trim()
    .min(1, `${name} must not be empty`)
    .refine((value) => !isPlaceholderValue(value), `${name} must not be a placeholder`)
}

function optionalValue(name: string) {
  return requiredValue(name).optional()
}

function requiredSecret(name: string, minimumLength = 32) {
  return requiredValue(name).min(
    minimumLength,
    `${name} must contain at least ${minimumLength} characters`,
  )
}

function postgresUrl(name: string) {
  return requiredValue(name)
    .url(`${name} must be a valid URL`)
    .refine((value) => {
      const protocol = new URL(value).protocol
      return protocol === 'postgres:' || protocol === 'postgresql:'
    }, `${name} must use the postgres:// or postgresql:// scheme`)
    .refine((value) => Boolean(new URL(value).hostname), `${name} must include a host`)
    .refine(
      (value) => new URL(value).pathname.length > 1,
      `${name} must include a database name`,
    )
}

function httpUrl(name: string) {
  return requiredValue(name)
    .url(`${name} must be a valid URL`)
    .refine((value) => {
      const protocol = new URL(value).protocol
      return protocol === 'http:' || protocol === 'https:'
    }, `${name} must use the http:// or https:// scheme`)
}

function optionalInteger(name: string, minimum: number, maximum: number, fallback: number) {
  return z.preprocess(
    (value) => {
      if (value === undefined) return fallback
      if (typeof value === 'string' && value.trim() === '') return Number.NaN
      return value
    },
    z.coerce
      .number({ error: `${name} must be a number` })
      .int(`${name} must be an integer`)
      .min(minimum, `${name} must be at least ${minimum}`)
      .max(maximum, `${name} must be at most ${maximum}`),
  )
}

const databaseRuntimeShape = {
  DATABASE_URL: postgresUrl('DATABASE_URL'),
  PGPOOL_MAX: optionalInteger('PGPOOL_MAX', 1, 100, 20),
  PGPOOL_IDLE_MS: optionalInteger('PGPOOL_IDLE_MS', 0, 300_000, 30_000),
  PGPOOL_CONN_TIMEOUT_MS: optionalInteger(
    'PGPOOL_CONN_TIMEOUT_MS',
    1_000,
    300_000,
    30_000,
  ),
  PG_STATEMENT_TIMEOUT_MS: optionalInteger(
    'PG_STATEMENT_TIMEOUT_MS',
    1_000,
    900_000,
    60_000,
  ),
} as const

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    ...databaseRuntimeShape,

    NEXTAUTH_URL: httpUrl('NEXTAUTH_URL'),
    NEXTAUTH_SECRET: requiredSecret('NEXTAUTH_SECRET'),

    UPSTASH_REDIS_REST_URL: httpUrl('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: requiredSecret('UPSTASH_REDIS_REST_TOKEN'),

    CRON_SECRET: requiredSecret('CRON_SECRET'),

    BCRYPT_ROUNDS: optionalInteger('BCRYPT_ROUNDS', 10, 15, 12),
    INACTIVITY_TIMEOUT_MINUTES: optionalInteger(
      'INACTIVITY_TIMEOUT_MINUTES',
      0,
      1_440,
      30,
    ),
    SESSION_VALIDATION_CACHE_TTL_SECONDS: optionalInteger(
      'SESSION_VALIDATION_CACHE_TTL_SECONDS',
      0,
      300,
      30,
    ),
    RATE_LIMIT_TRUST_PROXY_HOPS: optionalInteger(
      'RATE_LIMIT_TRUST_PROXY_HOPS',
      1,
      5,
      1,
    ),

    ORDER_TOKEN_ADMIN_EMAIL: z
      .email('ORDER_TOKEN_ADMIN_EMAIL must be a valid email address')
      .default('oneflowe@apricart.pk'),

    AWS_REGION: optionalValue('AWS_REGION').refine(
      (value) => value === undefined || /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value),
      'AWS_REGION must be a valid AWS region name',
    ),
    SES_FROM_EMAIL: z.email('SES_FROM_EMAIL must be a valid email address').optional(),
    SES_CONFIGURATION_SET: optionalValue('SES_CONFIGURATION_SET'),
  })
  .superRefine((values, context) => {
    const sesConfigured = Boolean(
      values.AWS_REGION || values.SES_FROM_EMAIL || values.SES_CONFIGURATION_SET,
    )

    if (sesConfigured && !values.AWS_REGION) {
      context.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'AWS_REGION is required when AWS SES is configured',
      })
    }

    if (sesConfigured && !values.SES_FROM_EMAIL) {
      context.addIssue({
        code: 'custom',
        path: ['SES_FROM_EMAIL'],
        message: 'SES_FROM_EMAIL is required when AWS SES is configured',
      })
    }

    if (values.NODE_ENV === 'production') {
      const nextAuthUrl = new URL(values.NEXTAUTH_URL)
      const redisUrl = new URL(values.UPSTASH_REDIS_REST_URL)

      if (nextAuthUrl.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['NEXTAUTH_URL'],
          message: 'NEXTAUTH_URL must use HTTPS in production',
        })
      }

      if (redisUrl.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['UPSTASH_REDIS_REST_URL'],
          message: 'UPSTASH_REDIS_REST_URL must use HTTPS in production',
        })
      }
    }
  })
  .transform((values) => ({
    ...values,
    SES_ENABLED: Boolean(values.AWS_REGION && values.SES_FROM_EMAIL),
  }))

const databaseToolEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ...databaseRuntimeShape,
})

const redisToolEnvSchema = z.object({
  UPSTASH_REDIS_REST_URL: httpUrl('UPSTASH_REDIS_REST_URL'),
  UPSTASH_REDIS_REST_TOKEN: requiredSecret('UPSTASH_REDIS_REST_TOKEN'),
})

const sesToolEnvSchema = z.object({
  AWS_REGION: requiredValue('AWS_REGION').refine(
    (value) => /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value),
    'AWS_REGION must be a valid AWS region name',
  ),
  SES_FROM_EMAIL: z.email('SES_FROM_EMAIL must be a valid email address'),
  SES_CONFIGURATION_SET: optionalValue('SES_CONFIGURATION_SET'),
})

const passwordToolEnvSchema = z.object({
  BCRYPT_ROUNDS: optionalInteger('BCRYPT_ROUNDS', 10, 15, 12),
})

const migrationEnvSchema = z.object({
  MIGRATION_DATABASE_URL: postgresUrl('MIGRATION_DATABASE_URL'),
})

const bootstrapEnvSchema = z.object({
  SUPER_ADMIN_EMAIL: z.email('SUPER_ADMIN_EMAIL must be a valid email address'),
  SUPER_ADMIN_PASSWORD: requiredSecret('SUPER_ADMIN_PASSWORD', 12)
    .refine((value) => /[a-z]/.test(value), 'SUPER_ADMIN_PASSWORD must include a lowercase letter')
    .refine((value) => /[A-Z]/.test(value), 'SUPER_ADMIN_PASSWORD must include an uppercase letter')
    .refine((value) => /\d/.test(value), 'SUPER_ADMIN_PASSWORD must include a number')
    .refine(
      (value) => /[^a-zA-Z0-9]/.test(value),
      'SUPER_ADMIN_PASSWORD must include a special character',
    ),
})

function formatValidationError(scope: string, error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => {
      const variableName = issue.path.join('.') || 'environment'
      return `- ${variableName}: ${issue.message}`
    })
    .join('\n')

  return new Error(`Invalid ${scope} environment configuration:\n${details}`)
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  values: NodeJS.ProcessEnv | Record<string, unknown>,
  scope: string,
): Readonly<T> {
  const result = schema.safeParse(values)
  if (!result.success) throw formatValidationError(scope, result.error)
  return Object.freeze(result.data)
}

export type ServerEnv = Readonly<z.output<typeof serverEnvSchema>>
export type DatabaseToolEnv = Readonly<z.output<typeof databaseToolEnvSchema>>
export type RedisToolEnv = Readonly<z.output<typeof redisToolEnvSchema>>
export type SesToolEnv = Readonly<z.output<typeof sesToolEnvSchema>>
export type PasswordToolEnv = Readonly<z.output<typeof passwordToolEnvSchema>>
export type MigrationEnv = Readonly<z.output<typeof migrationEnvSchema>>
export type BootstrapEnv = Readonly<z.output<typeof bootstrapEnvSchema>>

export function parseServerEnv(values: NodeJS.ProcessEnv | Record<string, unknown>): ServerEnv {
  return parseWithSchema(serverEnvSchema, values, 'server')
}

export function parseDatabaseToolEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): DatabaseToolEnv {
  return parseWithSchema(databaseToolEnvSchema, values, 'database tool')
}

export function parseRedisToolEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): RedisToolEnv {
  return parseWithSchema(redisToolEnvSchema, values, 'Redis tool')
}

export function parseSesToolEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): SesToolEnv {
  return parseWithSchema(sesToolEnvSchema, values, 'SES tool')
}

export function parsePasswordToolEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): PasswordToolEnv {
  return parseWithSchema(passwordToolEnvSchema, values, 'password tool')
}

export function parseOptionalRedisToolEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): RedisToolEnv | null {
  if (
    values.UPSTASH_REDIS_REST_URL === undefined &&
    values.UPSTASH_REDIS_REST_TOKEN === undefined
  ) {
    return null
  }
  return parseRedisToolEnv(values)
}

export function parseMigrationEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): MigrationEnv {
  return parseWithSchema(migrationEnvSchema, values, 'migration')
}

export function parseBootstrapEnv(
  values: NodeJS.ProcessEnv | Record<string, unknown>,
): BootstrapEnv {
  return parseWithSchema(bootstrapEnvSchema, values, 'administrator bootstrap')
}

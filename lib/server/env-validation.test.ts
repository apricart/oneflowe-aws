import { describe, expect, it } from 'vitest'

import { parseEdgeEnv } from '@/lib/edge/env-validation'
import {
  parseBootstrapEnv,
  parseMigrationEnv,
  parseServerEnv,
} from '@/lib/server/env-validation'

function validRuntimeEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://runtime_user:local-test-only@db.test.invalid/oneflowe',
    NEXTAUTH_URL: 'https://app.test.invalid',
    NEXTAUTH_SECRET: 'n'.repeat(48),
    UPSTASH_REDIS_REST_URL: 'https://redis.test.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'r'.repeat(48),
    CRON_SECRET: 'c'.repeat(48),
  }
}

describe('server environment validation', () => {
  it('returns a frozen typed configuration with bounded defaults', () => {
    const result = parseServerEnv(validRuntimeEnv())

    expect(Object.isFrozen(result)).toBe(true)
    expect(result.PGPOOL_MAX).toBe(20)
    expect(result.BCRYPT_ROUNDS).toBe(12)
    expect(result.SES_ENABLED).toBe(false)
  })

  it('rejects missing and whitespace-only required values', () => {
    const missing = validRuntimeEnv()
    delete missing.DATABASE_URL
    expect(() => parseServerEnv(missing)).toThrow(/DATABASE_URL/)

    expect(() =>
      parseServerEnv({ ...validRuntimeEnv(), UPSTASH_REDIS_REST_TOKEN: '   ' }),
    ).toThrow(/UPSTASH_REDIS_REST_TOKEN/)
  })

  it('rejects exact placeholders without rejecting longer legitimate values', () => {
    expect(() =>
      parseServerEnv({ ...validRuntimeEnv(), NEXTAUTH_SECRET: 'change_me' }),
    ).toThrow(/NEXTAUTH_SECRET.*placeholder/)

    expect(() =>
      parseServerEnv({
        ...validRuntimeEnv(),
        NEXTAUTH_SECRET: `secure-example-${'x'.repeat(40)}`,
      }),
    ).not.toThrow()
  })

  it('does not include rejected secret values in error messages', () => {
    const rejectedValue = 'short-private-value'
    expect(() =>
      parseServerEnv({ ...validRuntimeEnv(), CRON_SECRET: rejectedValue }),
    ).toThrowError(expect.not.stringContaining(rejectedValue))
  })

  it('rejects invalid database and Upstash REST URLs', () => {
    expect(() =>
      parseServerEnv({ ...validRuntimeEnv(), DATABASE_URL: 'https://db.test.invalid/app' }),
    ).toThrow(/DATABASE_URL/)

    expect(() =>
      parseServerEnv({
        ...validRuntimeEnv(),
        UPSTASH_REDIS_REST_URL: 'redis://redis.test.invalid',
      }),
    ).toThrow(/UPSTASH_REDIS_REST_URL/)
  })

  it('enforces production transport requirements', () => {
    expect(() =>
      parseServerEnv({
        ...validRuntimeEnv(),
        NODE_ENV: 'production',
        NEXTAUTH_URL: 'http://app.test.invalid',
      }),
    ).toThrow(/NEXTAUTH_URL.*HTTPS/)
  })

  it('requires complete SES configuration only when SES is enabled', () => {
    expect(() =>
      parseServerEnv({ ...validRuntimeEnv(), SES_FROM_EMAIL: 'sender@test.invalid' }),
    ).toThrow(/AWS_REGION/)

    expect(() =>
      parseServerEnv({
        ...validRuntimeEnv(),
        AWS_REGION: 'us-east-1',
        SES_FROM_EMAIL: 'sender@test.invalid',
      }),
    ).not.toThrow()
  })
})

describe('separate environment scopes', () => {
  it('never falls back to DATABASE_URL for migrations', () => {
    expect(() =>
      parseMigrationEnv({ DATABASE_URL: validRuntimeEnv().DATABASE_URL }),
    ).toThrow(/MIGRATION_DATABASE_URL/)
  })

  it('validates migration URLs independently', () => {
    const migration = parseMigrationEnv({
      MIGRATION_DATABASE_URL:
        'postgresql://migration_user:local-test-only@db.test.invalid/oneflowe',
    })
    expect(Object.isFrozen(migration)).toBe(true)
  })

  it('requires strong explicit administrator bootstrap input', () => {
    expect(() =>
      parseBootstrapEnv({
        SUPER_ADMIN_EMAIL: 'admin@test.invalid',
        SUPER_ADMIN_PASSWORD: 'password123',
      }),
    ).toThrow(/SUPER_ADMIN_PASSWORD/)

    expect(() =>
      parseBootstrapEnv({
        SUPER_ADMIN_EMAIL: 'admin@test.invalid',
        SUPER_ADMIN_PASSWORD: 'Local-Test-Only-Strong-42!',
      }),
    ).not.toThrow()
  })

  it('validates the Edge secret without importing Node server configuration', () => {
    expect(() => parseEdgeEnv({})).toThrow(/NEXTAUTH_SECRET/)
    expect(parseEdgeEnv({ NEXTAUTH_SECRET: 'e'.repeat(48) }).NEXTAUTH_SECRET).toHaveLength(48)
  })
})


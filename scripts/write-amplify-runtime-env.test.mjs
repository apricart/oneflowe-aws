import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import nextEnv from '@next/env'
import { describe, expect, it } from 'vitest'

import {
  AMPLIFY_RUNTIME_VARIABLES,
  serializeRuntimeEnvironment,
  writeRuntimeEnvironmentFile,
} from './write-amplify-runtime-env.mjs'

function requiredEnvironment(overrides = {}) {
  return {
    DATABASE_URL: 'postgresql://runtime:password@db.example.com:5432/oneflowe',
    NEXTAUTH_URL: 'https://app.example.com',
    NEXTAUTH_SECRET: 'n'.repeat(32),
    UPSTASH_REDIS_REST_URL: 'https://redis.example.com',
    UPSTASH_REDIS_REST_TOKEN: 'r'.repeat(32),
    CRON_SECRET: 'c'.repeat(32),
    ...overrides,
  }
}

describe('Amplify server runtime environment handoff', () => {
  it('copies only explicitly allowlisted runtime variables', () => {
    const { contents, includedNames } = serializeRuntimeEnvironment({
      ...requiredEnvironment(),
      PGPOOL_MAX: '20',
      MIGRATION_DATABASE_URL: 'postgresql://migration-credential',
      SUPER_ADMIN_PASSWORD: 'must-never-be-packaged',
      AWS_SECRET_ACCESS_KEY: 'must-never-be-packaged',
    })

    expect(includedNames).toEqual([
      'DATABASE_URL',
      'NEXTAUTH_URL',
      'NEXTAUTH_SECRET',
      'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'CRON_SECRET',
      'PGPOOL_MAX',
    ])
    expect(contents).not.toContain('MIGRATION_DATABASE_URL')
    expect(contents).not.toContain('SUPER_ADMIN_PASSWORD')
    expect(contents).not.toContain('AWS_SECRET_ACCESS_KEY')
  })

  it('fails the build with variable names, but not values, when required input is missing', () => {
    const environment = requiredEnvironment({
      DATABASE_URL: undefined,
      CRON_SECRET: ' ',
    })

    expect(() => serializeRuntimeEnvironment(environment)).toThrow(
      'Missing required Amplify build environment variables: DATABASE_URL, CRON_SECRET',
    )
  })

  it('preserves literal dollar signs instead of allowing dotenv expansion', () => {
    const { contents } = serializeRuntimeEnvironment(
      requiredEnvironment({ NEXTAUTH_SECRET: `${'n'.repeat(32)}$literal` }),
    )

    expect(contents).toContain(`NEXTAUTH_SECRET=${'n'.repeat(32)}\\$literal`)
  })

  it('round-trips allowlisted values through the Next.js production env loader', () => {
    const directory = mkdtempSync(join(tmpdir(), 'oneflowe-amplify-env-'))
    const outputPath = join(directory, '.env.production')
    const expectedSecret = `${'n'.repeat(32)}$literal # segment`
    const environment = requiredEnvironment({ NEXTAUTH_SECRET: expectedSecret })
    const originalValues = new Map()
    const originalNodeEnv = process.env.NODE_ENV

    for (const name of AMPLIFY_RUNTIME_VARIABLES) {
      originalValues.set(name, process.env[name])
      delete process.env[name]
    }
    process.env.NODE_ENV = 'production'

    try {
      writeRuntimeEnvironmentFile(environment, outputPath)
      const result = nextEnv.loadEnvConfig(directory, false, console, true)

      expect(result.combinedEnv.NEXTAUTH_SECRET).toBe(expectedSecret)
      expect(result.combinedEnv.DATABASE_URL).toBe(environment.DATABASE_URL)
      expect(result.combinedEnv.MIGRATION_DATABASE_URL).toBeUndefined()
      expect(result.combinedEnv.SUPER_ADMIN_PASSWORD).toBeUndefined()
    } finally {
      nextEnv.resetEnv()
      for (const [name, value] of originalValues) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = originalNodeEnv
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not allow migration, bootstrap, or permanent AWS credentials', () => {
    expect(AMPLIFY_RUNTIME_VARIABLES).not.toContain('MIGRATION_DATABASE_URL')
    expect(AMPLIFY_RUNTIME_VARIABLES).not.toContain('SUPER_ADMIN_EMAIL')
    expect(AMPLIFY_RUNTIME_VARIABLES).not.toContain('SUPER_ADMIN_PASSWORD')
    expect(AMPLIFY_RUNTIME_VARIABLES).not.toContain('AWS_ACCESS_KEY_ID')
    expect(AMPLIFY_RUNTIME_VARIABLES).not.toContain('AWS_SECRET_ACCESS_KEY')
  })
})

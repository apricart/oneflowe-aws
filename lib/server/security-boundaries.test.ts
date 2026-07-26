import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

function repositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('repository security boundaries', () => {
  it('does not configure a custom Next.js env object', () => {
    expect(repositoryFile('next.config.mjs')).not.toMatch(/(^|\s)env\s*:/m)
  })

  it('prepares the allowlisted Amplify runtime environment before Next.js builds', () => {
    const buildSpec = repositoryFile('amplify.yml')
    const runtimeEnvStep = buildSpec.indexOf('node scripts/write-amplify-runtime-env.mjs')
    const nextBuildStep = buildSpec.indexOf('npm run build')

    expect(runtimeEnvStep).toBeGreaterThan(-1)
    expect(nextBuildStep).toBeGreaterThan(runtimeEnvStep)
    expect(buildSpec).not.toMatch(/env\s*\|/)
  })

  it('keeps general seeding free of administrator credentials', () => {
    const seed = repositoryFile('lib/seed.ts')
    expect(seed).not.toContain('SUPER_ADMIN_PASSWORD')
    expect(seed).not.toContain('passwordHash')
    expect(seed).not.toMatch(/process[.]env/)
  })

  it('uses the AWS default credential provider chain', () => {
    const ses = repositoryFile('lib/email/ses.ts')
    expect(ses).not.toMatch(/credentials\s*:/)
    expect(ses).not.toMatch(/NNAWS_|NAWS_|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/)
  })

  it('poisons the server runtime environment module against client imports', () => {
    expect(repositoryFile('lib/server/env.ts').trimStart()).toMatch(
      /^import ['"]server-only['"]/,
    )
  })
})

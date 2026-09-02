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

describe('group sub-resources are confined to the tenant that owns the group', () => {
  // Every one of these takes a group id straight from the URL. Authenticating
  // is not enough to read one: the caller must administer groups, and Head
  // Office must own the group it names. Without that, a group id is all anyone
  // needs to enumerate another tenant's structure.
  const groupSubResources = [
    'app/api/v1/groups/[id]/branches/route.ts',
    'app/api/v1/groups/[id]/branches/clean/route.ts',
    'app/api/v1/groups/[id]/branch-counts/route.ts',
    'app/api/v1/groups/[id]/prices/route.ts',
  ]

  it('admits only the roles that administer groups', () => {
    for (const path of groupSubResources) {
      const route = repositoryFile(path)
      expect(route).toContain('SUPER_ADMIN')
      expect(route).toContain('HEAD_OFFICE')
      expect(route).toContain('{ status: 403 }')
    }
  })

  it('pins Head Office to its own organization on every handler', () => {
    for (const path of groupSubResources) {
      const route = repositoryFile(path)
      // The group is loaded and its owning organization compared before any
      // row is read — never trusted from the request.
      expect(route).toMatch(/role === ['"]HEAD_OFFICE['"] && group\.organizationId !== /)
      expect(route).toContain('{ status: 404 }')
    }
  })

  it('reads a group branch list only through the shared authorization helper', () => {
    const route = repositoryFile('app/api/v1/groups/[id]/branches/route.ts')
    // GET and PUT share one rule so a future edit cannot re-open the read side
    // while leaving the write side guarded.
    expect((route.match(/await authorizeGroupBranchAccess\(id\)/g) || []).length).toBe(2)
    expect(route).not.toMatch(/db\s*\n?\s*\.select\(\)\s*\.from\(branches\)/)
    // The listing is pinned to the group's tenant and exposes identity fields
    // only — not budget baselines, the branch admin, or external identifiers.
    expect(route).toContain('eq(branches.organizationId, authorized.group.organizationId)')
    expect(route).not.toContain('baselineBudgetCents')
    expect(route).not.toContain('adminUserId')
  })
})

import { describe, expect, it } from 'vitest'

import { ERROR_MESSAGES, parseError } from './error-handler'

describe('parseError', () => {
  it('does not misclassify a Drizzle query failure as an organization permission error', () => {
    const cause = Object.assign(new Error('column "baseline_budget_cents" does not exist'), {
      code: '42703',
      severity: 'ERROR',
      routine: 'errorMissingColumn',
    })
    const error = Object.assign(
      new Error('Failed query: insert into "branches" ("organization_id", "baseline_budget_cents") values ($1, $2)'),
      { name: 'DrizzleQueryError', cause },
    )

    expect(parseError(error)).toMatchObject({
      type: 'DATABASE_ERROR',
      message: ERROR_MESSAGES.DATABASE_ERROR,
      statusCode: 500,
    })
  })

  it('still reports genuine organization-scope failures as permission errors', () => {
    expect(parseError(new Error('organization scope mismatch'))).toMatchObject({
      type: 'PERMISSION_ERROR',
      message: ERROR_MESSAGES.ORGANIZATION_SCOPE,
      statusCode: 403,
    })
  })
})

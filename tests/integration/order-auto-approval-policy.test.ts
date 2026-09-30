import { randomUUID } from "node:crypto"

import { afterAll, describe, expect, it } from "vitest"

import { inArray } from "drizzle-orm"

import { organizations } from "@/db/schema"
import { verifyApprovalToken } from "@/lib/approval-token"
import { closePool, db } from "@/lib/db"
import { resolveInitialOrderApproval } from "@/lib/server/order-creation-approval"

import {
  NO_DATABASE_REASON,
  hasTestDatabase,
} from "./helpers/pricing-fixtures"

/**
 * Real-Postgres coverage for the persisted tenant policy and its locked order
 * initialization. Rows intentionally remain in the disposable test database;
 * every run uses unique names and the CI service is discarded with the job.
 */
describe.skipIf(!hasTestDatabase)("order auto-approval policy in Postgres", () => {
  afterAll(async () => {
    await closePool()
  })

  it("keeps the default pending workflow and makes an opted-out tenant fulfillment-ready", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()
    const createdOrganizations = await db
      .insert(organizations)
      .values([
        {
          name: `Approval Required Integration ${suffix}`,
          code: `REQ_${suffix}`,
        },
        {
          name: `Auto Approval Integration ${suffix}`,
          code: `AUTO_${suffix}`,
          orderApprovalRequired: false,
        },
      ])
      .returning({
        id: organizations.id,
        code: organizations.code,
        orderApprovalRequired: organizations.orderApprovalRequired,
      })
    const approvalRequiredOrganization = createdOrganizations.find((row) => row.code === `REQ_${suffix}`)
    const autoApprovalOrganization = createdOrganizations.find((row) => row.code === `AUTO_${suffix}`)

    expect(approvalRequiredOrganization).toBeDefined()
    expect(autoApprovalOrganization).toBeDefined()
    if (!approvalRequiredOrganization || !autoApprovalOrganization) {
      throw new Error("Integration organizations were not returned")
    }

    const stored = await db
      .select({
        id: organizations.id,
        orderApprovalRequired: organizations.orderApprovalRequired,
      })
      .from(organizations)
      .where(inArray(organizations.id, [
        approvalRequiredOrganization.id,
        autoApprovalOrganization.id,
      ]))

    expect(new Map(stored.map((row) => [row.id, row.orderApprovalRequired]))).toEqual(new Map([
      [approvalRequiredOrganization.id, true],
      [autoApprovalOrganization.id, false],
    ]))

    const pending = await db.transaction((tx) =>
      resolveInitialOrderApproval(tx, approvalRequiredOrganization.id),
    )
    expect(pending.approvalRequired).toBe(true)
    expect(pending.values.status).toBe("PENDING")
    expect(pending.values.approvalTokenHash).toBeNull()

    const approved = await db.transaction((tx) =>
      resolveInitialOrderApproval(tx, autoApprovalOrganization.id),
    )
    expect(approved.approvalRequired).toBe(false)
    expect(approved.values.status).toBe("APPROVED")
    expect(approved.values.approvedAt).toBeInstanceOf(Date)
    expect(approved.values.approvalToken).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
    expect(await verifyApprovalToken(
      approved.values.approvalToken!,
      approved.values.approvalTokenHash!,
    )).toBe(true)
  })
})

describe.skipIf(hasTestDatabase)("order auto-approval policy integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})

import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  auditLogs,
  branches,
  budgets,
  globalProducts,
  groupOrders,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  systemLogs,
  userBranchAssignments,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * A deliberately small cross-tenant history for the two group-based roles.
 *
 * ```text
 * tenant A                                      tenant B
 *   Alpha group                                   Foreign group
 *     Alpha North (pending 100.00, qty 2.5)         Foreign branch/order
 *     Alpha South (approved 25.00, qty 0.5)
 *   Beta group
 *     Beta (rejected group order, out of approver scope)
 *
 *   GROUP_ORDER_PORTAL: Alpha group + Beta branch
 *   GROUP_USER:         Alpha group
 *   empty GROUP_USER:   no assignments
 * ```
 *
 * The requester's union of group and direct assignments exercises its
 * storefront scope. The approver can see both Alpha children but neither the
 * Beta nor foreign envelopes, which makes every count and money/quantity total
 * independently checkable.
 */
export type GroupRoleFixtures = {
  suffix: string
  organizationId: number
  foreignOrganizationId: number
  alphaGroupId: number
  betaGroupId: number
  foreignGroupId: number
  alphaNorthId: number
  alphaSouthId: number
  betaBranchId: number
  foreignBranchId: number
  superAdminId: string
  headOfficeId: string
  foreignHeadOfficeId: string
  requesterId: string
  approverId: string
  emptyApproverId: string
  productId: number
  alphaEnvelopeId: number
  betaEnvelopeId: number
  foreignEnvelopeId: number
  alphaNorthOrderId: number
  alphaSouthOrderId: number
  betaOrderId: number
  foreignOrderId: number
  ordinaryOrderId: number
  names: {
    organization: string
    alphaGroup: string
    betaGroup: string
    alphaNorth: string
    alphaSouth: string
    betaBranch: string
  }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by group-role integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createGroupRoleFixtures(): Promise<GroupRoleFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const role = {
    superAdmin: await resolveRoleId("SUPER_ADMIN"),
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    requester: await resolveRoleId("GROUP_ORDER_PORTAL"),
    approver: await resolveRoleId("GROUP_USER"),
  }

  const names = {
    organization: `IT Group Roles ${suffix}`,
    alphaGroup: `Alpha ${suffix}`,
    betaGroup: `Beta ${suffix}`,
    alphaNorth: `Alpha North ${suffix}`,
    alphaSouth: `Alpha South ${suffix}`,
    betaBranch: `Beta Branch ${suffix}`,
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: names.organization, code: `ITGR-${suffix}` })
    .returning({ id: organizations.id })
  const [foreignOrganization] = await db
    .insert(organizations)
    .values({ name: `IT Group Roles Foreign ${suffix}`, code: `ITGF-${suffix}` })
    .returning({ id: organizations.id })

  async function person(
    label: string,
    roleId: number,
    organizationId: number | null,
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-group-role-${label}-${suffix}@example.test`,
        username: `it-group-role-${label}-${suffix}`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId,
        branchId: null,
        firstName: label,
        lastName: suffix,
        fullName: `${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("super", role.superAdmin, null)
  const headOfficeId = await person("head-office", role.headOffice, organization.id)
  const foreignHeadOfficeId = await person("foreign-head-office", role.headOffice, foreignOrganization.id)
  const requesterId = await person("requester", role.requester, organization.id)
  const approverId = await person("approver", role.approver, organization.id)
  const emptyApproverId = await person("empty-approver", role.approver, organization.id)

  const [alphaGroup] = await db
    .insert(groups)
    .values({ organizationId: organization.id, name: names.alphaGroup, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [betaGroup] = await db
    .insert(groups)
    .values({ organizationId: organization.id, name: names.betaGroup, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [foreignGroup] = await db
    .insert(groups)
    .values({
      organizationId: foreignOrganization.id,
      name: `Foreign ${suffix}`,
      createdByUserId: foreignHeadOfficeId,
    })
    .returning({ id: groups.id })

  const [alphaNorth, alphaSouth, betaBranch, foreignBranch] = await db
    .insert(branches)
    .values([
      {
        organizationId: organization.id,
        groupId: alphaGroup.id,
        name: names.alphaNorth,
        costCenterId: `N-${suffix}`,
        status: "active",
        baselineBudgetCents: 100_000,
      },
      {
        organizationId: organization.id,
        groupId: alphaGroup.id,
        name: names.alphaSouth,
        costCenterId: `S-${suffix}`,
        status: "active",
        baselineBudgetCents: 75_000,
      },
      {
        organizationId: organization.id,
        groupId: betaGroup.id,
        name: names.betaBranch,
        status: "active",
        baselineBudgetCents: 50_000,
      },
      {
        organizationId: foreignOrganization.id,
        groupId: foreignGroup.id,
        name: `Foreign Branch ${suffix}`,
        status: "active",
        baselineBudgetCents: 999_999,
      },
    ])
    .returning({ id: branches.id })

  await db.insert(userGroupAssignments).values([
    {
      userId: requesterId,
      groupId: alphaGroup.id,
      organizationId: organization.id,
      createdByUserId: headOfficeId,
    },
    {
      userId: approverId,
      groupId: alphaGroup.id,
      organizationId: organization.id,
      createdByUserId: headOfficeId,
    },
  ])
  await db.insert(userBranchAssignments).values([
    {
      userId: requesterId,
      branchId: betaBranch.id,
      organizationId: organization.id,
      createdByUserId: headOfficeId,
    },
    // Simulate an inconsistent/stale row. Every read must still re-assert the
    // user's tenant instead of leaking this branch's name or values.
    {
      userId: requesterId,
      branchId: foreignBranch.id,
      organizationId: organization.id,
      createdByUserId: headOfficeId,
    },
  ])

  await db.insert(budgets).values({
    organizationId: organization.id,
    branchId: alphaNorth.id,
    period: currentBudgetPeriod(),
    amountAllocatedCents: 100_000,
    amountSpentCents: 20_000,
    amountHeldCents: 30_000,
    amountCreditedCents: 5_000,
  })

  const [product] = await db
    .insert(globalProducts)
    .values({
      productCode: `ITGR-P-${suffix}`,
      name: `Integration Group Product ${suffix}`,
      basePrice: 1_000,
      status: "active",
      unit: "kg",
      allowDecimalQuantity: true,
      quantityStep: 0.5,
    })
    .returning({ id: globalProducts.id })

  async function envelope(
    reference: string,
    organizationId: number,
    groupId: number,
    createdByUserId: string,
  ) {
    const [row] = await db
      .insert(groupOrders)
      .values({
        reference: `GRP-${reference}-${suffix}`,
        organizationId,
        groupId,
        createdByUserId,
        idempotencyKey: `it-${reference}-${suffix}`,
        requestFingerprint: `${reference}`.repeat(64).slice(0, 64),
        requestedBranchCount: 1,
        createdOrderCount: 1,
      })
      .returning({ id: groupOrders.id })
    return row.id
  }

  const alphaEnvelopeId = await envelope("ALPHA", organization.id, alphaGroup.id, requesterId)
  const betaEnvelopeId = await envelope("BETA", organization.id, betaGroup.id, requesterId)
  const foreignEnvelopeId = await envelope(
    "FOREIGN",
    foreignOrganization.id,
    foreignGroup.id,
    foreignHeadOfficeId,
  )

  async function order(input: {
    key: string
    organizationId: number
    branchId: number
    createdByUserId: string
    groupOrderId?: number
    status: string
    totalCents: number
    refundAmountCents?: number
    quantity: number
    approvalToken?: string
  }): Promise<number> {
    const [row] = await db
      .insert(orders)
      .values({
        tid: `ITGR-${input.key}-${suffix}`,
        organizationId: input.organizationId,
        branchId: input.branchId,
        groupOrderId: input.groupOrderId,
        createdByUserId: input.createdByUserId,
        status: input.status,
        subtotalCents: input.totalCents,
        taxCents: 0,
        totalCents: input.totalCents,
        refundAmountCents: input.refundAmountCents ?? null,
        statusAtRefund: input.refundAmountCents ? "APPROVED" : null,
        approvalToken: input.approvalToken ?? null,
      })
      .returning({ id: orders.id })

    await db.insert(orderItems).values({
      organizationId: input.organizationId,
      orderId: row.id,
      globalProductId: product.id,
      productName: `Integration Group Product ${suffix}`,
      unit: "kg",
      quantity: input.quantity,
      priceCents: Math.round(input.totalCents / input.quantity),
    })
    return row.id
  }

  const alphaNorthOrderId = await order({
    key: "ALPHA-N",
    organizationId: organization.id,
    branchId: alphaNorth.id,
    createdByUserId: requesterId,
    groupOrderId: alphaEnvelopeId,
    status: "PENDING",
    totalCents: 10_000,
    quantity: 2.5,
  })
  const alphaSouthOrderId = await order({
    key: "ALPHA-S",
    organizationId: organization.id,
    branchId: alphaSouth.id,
    createdByUserId: requesterId,
    groupOrderId: alphaEnvelopeId,
    status: "APPROVED",
    totalCents: 2_500,
    refundAmountCents: 500,
    quantity: 0.5,
    approvalToken: `TOK-${suffix}`,
  })
  const betaOrderId = await order({
    key: "BETA",
    organizationId: organization.id,
    branchId: betaBranch.id,
    createdByUserId: requesterId,
    groupOrderId: betaEnvelopeId,
    status: "REJECTED",
    totalCents: 9_000,
    quantity: 9,
  })
  const foreignOrderId = await order({
    key: "FOREIGN",
    organizationId: foreignOrganization.id,
    branchId: foreignBranch.id,
    createdByUserId: foreignHeadOfficeId,
    groupOrderId: foreignEnvelopeId,
    status: "PENDING",
    totalCents: 99_999,
    quantity: 99,
  })
  const ordinaryOrderId = await order({
    key: "ORDINARY",
    organizationId: organization.id,
    branchId: alphaNorth.id,
    createdByUserId: headOfficeId,
    status: "PENDING",
    totalCents: 77_777,
    quantity: 7,
  })

  // The Alpha envelope represents both branch orders, not merely the default
  // written by the fixture helper.
  await db
    .update(groupOrders)
    .set({ requestedBranchCount: 2, createdOrderCount: 2 })
    .where(eq(groupOrders.id, alphaEnvelopeId))

  return {
    suffix,
    organizationId: organization.id,
    foreignOrganizationId: foreignOrganization.id,
    alphaGroupId: alphaGroup.id,
    betaGroupId: betaGroup.id,
    foreignGroupId: foreignGroup.id,
    alphaNorthId: alphaNorth.id,
    alphaSouthId: alphaSouth.id,
    betaBranchId: betaBranch.id,
    foreignBranchId: foreignBranch.id,
    superAdminId,
    headOfficeId,
    foreignHeadOfficeId,
    requesterId,
    approverId,
    emptyApproverId,
    productId: product.id,
    alphaEnvelopeId,
    betaEnvelopeId,
    foreignEnvelopeId,
    alphaNorthOrderId,
    alphaSouthOrderId,
    betaOrderId,
    foreignOrderId,
    ordinaryOrderId,
    names,
  }
}

export async function destroyGroupRoleFixtures(
  fixtures: GroupRoleFixtures,
  extraUserIds: string[] = [],
): Promise<void> {
  const organizationIds = [fixtures.organizationId, fixtures.foreignOrganizationId]
  const envelopeIds = [fixtures.alphaEnvelopeId, fixtures.betaEnvelopeId, fixtures.foreignEnvelopeId]
  const orderIds = [
    fixtures.alphaNorthOrderId,
    fixtures.alphaSouthOrderId,
    fixtures.betaOrderId,
    fixtures.foreignOrderId,
    fixtures.ordinaryOrderId,
  ]
  const fixtureUserIds = [
    fixtures.superAdminId,
    fixtures.headOfficeId,
    fixtures.foreignHeadOfficeId,
    fixtures.requesterId,
    fixtures.approverId,
    fixtures.emptyApproverId,
    ...extraUserIds,
  ]

  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  // A budget allocation writes an audit row naming the acting user; it must go
  // before the user does.
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  await db.delete(groupOrders).where(inArray(groupOrders.id, envelopeIds))
  await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
  await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.userId, fixtureUserIds))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.userId, fixtureUserIds))
  await db.delete(groups).where(inArray(groups.id, [
    fixtures.alphaGroupId,
    fixtures.betaGroupId,
    fixtures.foreignGroupId,
  ]))
  await db.delete(users).where(inArray(users.id, fixtureUserIds))
  await db.delete(branches).where(inArray(branches.id, [
    fixtures.alphaNorthId,
    fixtures.alphaSouthId,
    fixtures.betaBranchId,
    fixtures.foreignBranchId,
  ]))
  await db.delete(globalProducts).where(eq(globalProducts.id, fixtures.productId))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}

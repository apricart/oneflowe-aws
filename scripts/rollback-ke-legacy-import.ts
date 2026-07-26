#!/usr/bin/env tsx
/**
 * Deletes only orders owned by one completed KE_LOGISTICS import batch.
 * Product/group assignments and inactive historical identities are deliberately
 * retained because later batches or reporting configuration may depend on them.
 */

import * as dotenv from "dotenv"
import { KE_ORGANIZATION, LEGACY_SOURCE } from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local" })
dotenv.config()

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main() {
  const batchId = arg("--batch-id")
  const actorUserId = arg("--actor-user-id")
  const confirmation = arg("--confirm")
  if (!batchId || !actorUserId) throw new Error("Required: --batch-id and --actor-user-id")
  if (confirmation !== `ROLLBACK:${batchId}:KE-ONLY`) {
    throw new Error(`Required: --confirm=ROLLBACK:${batchId}:KE-ONLY`)
  }

  const { db, pool } = await import("../lib/db-cli")
  const schema = await import("../db/schema")
  const { and, eq, inArray, isNull, sql } = await import("drizzle-orm")

  const [actor] = await db.select({ id: schema.users.id, role: schema.roles.name })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
    .where(and(eq(schema.users.id, actorUserId), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))
    .limit(1)
  if (!actor || actor.role !== "SUPER_ADMIN") throw new Error("Actor must be an active SUPER_ADMIN")

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1263482710, ${KE_ORGANIZATION.id})`)
    const [batch] = await tx.select().from(schema.legacyImportBatches).where(and(
      eq(schema.legacyImportBatches.id, batchId),
      eq(schema.legacyImportBatches.organizationId, KE_ORGANIZATION.id),
      eq(schema.legacyImportBatches.sourceSystem, LEGACY_SOURCE),
      eq(schema.legacyImportBatches.status, "COMPLETED"),
    )).for("update")
    if (!batch) throw new Error("Completed K-Electric legacy batch not found")

    const imported = await tx.select({ orderId: schema.legacyOrderImports.orderId })
      .from(schema.legacyOrderImports)
      .where(and(
        eq(schema.legacyOrderImports.batchId, batchId),
        eq(schema.legacyOrderImports.organizationId, KE_ORGANIZATION.id),
        eq(schema.legacyOrderImports.sourceSystem, LEGACY_SOURCE),
      ))
    if (imported.length === 0) throw new Error("Batch has no owned orders")

    const orderIds = imported.map((row) => row.orderId)
    const ownedOrders = await tx.select({ id: schema.orders.id }).from(schema.orders).where(and(
      eq(schema.orders.organizationId, KE_ORGANIZATION.id),
      inArray(schema.orders.id, orderIds),
    )).for("update")
    if (ownedOrders.length !== orderIds.length) throw new Error("Batch ownership/tenant verification failed")

    // Delete only rows proven to belong to this batch; operational delete routes
    // are not used because they would mutate today's stock and budget ledgers.
    await tx.delete(schema.orderItems).where(and(
      eq(schema.orderItems.organizationId, KE_ORGANIZATION.id),
      inArray(schema.orderItems.orderId, orderIds),
    ))
    await tx.delete(schema.legacyOrderImports).where(and(
      eq(schema.legacyOrderImports.batchId, batchId),
      eq(schema.legacyOrderImports.organizationId, KE_ORGANIZATION.id),
    ))
    await tx.delete(schema.orders).where(and(
      eq(schema.orders.organizationId, KE_ORGANIZATION.id),
      inArray(schema.orders.id, orderIds),
    ))
    await tx.update(schema.legacyImportBatches).set({
      status: "ROLLED_BACK",
      rolledBackAt: new Date(),
    }).where(eq(schema.legacyImportBatches.id, batchId))
    await tx.insert(schema.auditLogs).values({
      userId: actorUserId,
      organizationId: KE_ORGANIZATION.id,
      action: "LEGACY_ORDER_IMPORT_ROLLBACK",
      entity: "legacy_import_batch",
      entityId: batchId,
      metadata: { source: LEGACY_SOURCE, deletedOrders: orderIds.length, stockOrBudgetChanged: false },
    })
  })

  console.log(`Rolled back K-Electric legacy batch ${batchId}.`)
  await pool.end()
}

main().catch((error) => {
  console.error(`Rollback failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

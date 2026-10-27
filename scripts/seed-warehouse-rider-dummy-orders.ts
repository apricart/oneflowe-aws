/**
 * Reset rider assignments + prior dummy OFD orders, then seed fresh Karachi
 * stops for Plan-route testing.
 *
 * Usage:
 *   npx tsx scripts/seed-warehouse-rider-dummy-orders.ts --reset --count=5
 *   npx tsx scripts/seed-warehouse-rider-dummy-orders.ts --warehouse=warehouse_omar --count=5 --assign
 *
 * Reads DATABASE_URL from .env.local (same as the app).
 */
import { config } from "dotenv"
config({ path: ".env.local" })
config({ path: ".env" })

import { and, eq, inArray, sql } from "drizzle-orm"
import {
  branches,
  globalProducts,
  notifications,
  orderItems,
  orders,
  organizations,
  riderOrderAssignments,
  riderPodImages,
  riderProfiles,
  roles,
  users,
  warehouseAssignments,
} from "@/db/schema"
import { closePool, db } from "@/lib/db-cli"

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

/** Distinct Karachi drop pins for a clear multi-stop road route. */
const KARACHI_PINS: Array<{ lat: number; lng: number; label: string }> = [
  { lat: 24.8607, lng: 67.0011, label: "Saddar" },
  { lat: 24.9056, lng: 67.0822, label: "Gulshan" },
  { lat: 24.8138, lng: 67.0225, label: "Clifton" },
  { lat: 24.9272, lng: 67.0365, label: "North Nazimabad" },
  { lat: 24.8415, lng: 67.0644, label: "PECHS" },
  { lat: 24.8822, lng: 67.0681, label: "Bahadurabad" },
  { lat: 24.9342, lng: 67.1185, label: "Malir" },
  { lat: 24.8738, lng: 66.9966, label: "Lyari" },
]

const DUMMY_NOTE = "seed-warehouse-rider-dummy-orders"

async function loadWarehouseReachBranchIds(warehouseUserId: string): Promise<number[]> {
  const direct = await db
    .select({ id: branches.id })
    .from(warehouseAssignments)
    .innerJoin(branches, eq(branches.id, warehouseAssignments.branchId))
    .where(eq(warehouseAssignments.userId, warehouseUserId))

  const city = await db.execute(sql`
    select b.id
    from warehouse_city_assignments wca
    join warehouse_city_organizations wco on wco.user_id = wca.user_id
    join branches b
      on b.organization_id = wco.organization_id
     and b.status = 'active'
     and lower(btrim(regexp_replace(b.city, '\\s+', ' ', 'g'))) = wca.city_key
    where wca.user_id = ${warehouseUserId}::uuid
  `)

  const cityIds = (city.rows as Array<{ id: number }>).map((row) => row.id)
  return [...new Set([...direct.map((row) => row.id), ...cityIds])]
}

async function resetDummyPool(warehouseUserId: string) {
  const assignmentIds = (
    await db
      .select({ id: riderOrderAssignments.id })
      .from(riderOrderAssignments)
      .innerJoin(riderProfiles, eq(riderProfiles.userId, riderOrderAssignments.riderUserId))
      .where(eq(riderProfiles.warehouseUserId, warehouseUserId))
  ).map((row) => row.id)

  if (assignmentIds.length > 0) {
    await db.delete(riderPodImages).where(inArray(riderPodImages.assignmentId, assignmentIds))
    await db.delete(riderOrderAssignments).where(inArray(riderOrderAssignments.id, assignmentIds))
    console.log(`Removed ${assignmentIds.length} rider assignment(s)`)
  } else {
    console.log("No rider assignments to remove")
  }

  const dummyOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      sql`(${orders.notes} ilike ${"%Dummy rider pool%"} or (${orders.receiptData}->>'note') = ${DUMMY_NOTE})`,
    )

  const orderIds = dummyOrders.map((row) => row.id)
  if (orderIds.length === 0) {
    console.log("No prior dummy orders to remove")
    return
  }

  await db.delete(notifications).where(inArray(notifications.orderId, orderIds))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  console.log(`Removed ${orderIds.length} dummy order(s)`)
}

async function main() {
  const warehouseKey = arg("warehouse", "warehouse_omar")!
  const count = Math.max(1, Math.min(30, Number(arg("count", "5")) || 5))
  const doReset = hasFlag("reset")
  const doAssign = hasFlag("assign") || doReset

  const [wh] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      fullName: users.fullName,
      role: roles.name,
    })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(
      and(
        eq(roles.name, "WAREHOUSE"),
        sql`(lower(${users.username}) = lower(${warehouseKey}) or lower(${users.email}) = lower(${warehouseKey}))`,
      ),
    )
    .limit(1)

  if (!wh) {
    console.error(`No WAREHOUSE user matching "${warehouseKey}"`)
    process.exit(1)
  }

  if (doReset) {
    await resetDummyPool(wh.id)
  }

  const branchIds = await loadWarehouseReachBranchIds(wh.id)
  if (branchIds.length === 0) {
    console.error(`${wh.username ?? wh.email} has no branch/city reach — assign branches on Warehouse Team first`)
    process.exit(1)
  }

  const branchRows = await db
    .select({
      id: branches.id,
      name: branches.name,
      city: branches.city,
      address: branches.address,
      organizationId: branches.organizationId,
      orgName: organizations.name,
    })
    .from(branches)
    .innerJoin(organizations, eq(organizations.id, branches.organizationId))
    .where(inArray(branches.id, branchIds))

  // Prefer Karachi branches for this routing check.
  const karachiBranches = branchRows.filter(
    (b) => (b.city ?? "").trim().toLowerCase().replace(/\s+/g, " ") === "karachi",
  )
  const pool = karachiBranches.length > 0 ? karachiBranches : branchRows

  let [creator] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(roles.name, "ORDER_PORTAL"), inArray(users.branchId, pool.map((b) => b.id)), eq(users.isActive, true)))
    .limit(1)
  if (!creator) {
    ;[creator] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isActive, true))
      .limit(1)
  }
  if (!creator) {
    console.error("No active user to set as order creator")
    process.exit(1)
  }

  const [product] = await db
    .select({
      id: globalProducts.id,
      name: globalProducts.name,
      productCode: globalProducts.productCode,
      unit: globalProducts.unit,
      basePrice: globalProducts.basePrice,
    })
    .from(globalProducts)
    .where(and(eq(globalProducts.status, "active"), sql`${globalProducts.deletedAt} is null`))
    .limit(1)

  if (!product) {
    console.error("No active global product — seed catalogue first")
    process.exit(1)
  }

  const riderCodePrefer = arg("rider", "rider")
  const [rider] = doAssign
    ? await db
        .select({ userId: riderProfiles.userId, code: riderProfiles.code })
        .from(riderProfiles)
        .innerJoin(users, eq(users.id, riderProfiles.userId))
        .where(
          and(
            eq(riderProfiles.warehouseUserId, wh.id),
            eq(users.isActive, true),
            riderCodePrefer
              ? sql`lower(${riderProfiles.code}) = ${riderCodePrefer.toLowerCase()}`
              : sql`true`,
          ),
        )
        .limit(1)
    : []

  if (doAssign && !rider) {
    console.error("No rider linked to this warehouse — create a Karachi rider first")
    process.exit(1)
  }

  const stamp = Date.now().toString(36).toUpperCase()
  const created: Array<{
    id: number
    tid: string
    branch: string
    pin: string
    assignmentId?: number
  }> = []

  for (let i = 0; i < count; i++) {
    const branch = pool[i % pool.length]
    const pin = KARACHI_PINS[i % KARACHI_PINS.length]
    const tid = `RDR${stamp}${String(i + 1).padStart(2, "0")}`.slice(0, 26)
    const unitCents = Math.max(100, Number(product.basePrice) || 25_000)
    const qty = 1 + (i % 3)
    const subtotal = unitCents * qty
    const tax = Math.round(subtotal * 0.18)
    const total = subtotal + tax
    const approvedAt = new Date(Date.now() - (count - i) * 60_000)

    const [order] = await db
      .insert(orders)
      .values({
        tid,
        organizationId: branch.organizationId,
        branchId: branch.id,
        status: "APPROVED",
        fulfillmentStatus: "OUT_FOR_DELIVERY",
        paymentStatus: "UNPAID",
        subtotalCents: subtotal,
        taxCents: tax,
        totalCents: total,
        notes: `Dummy rider pool — drop near ${pin.label} (${pin.lat}, ${pin.lng})`,
        createdByUserId: creator.id,
        createdByRole: "ORDER_PORTAL",
        approvedAt,
        budgetTracked: false,
        receiptData: {
          invoiceNumber: `DUMMY-${tid}`,
          note: DUMMY_NOTE,
        } as any,
      })
      .returning({ id: orders.id, tid: orders.tid })

    await db.insert(orderItems).values({
      orderId: order.id,
      organizationId: branch.organizationId,
      globalProductId: product.id,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit ?? "pcs",
      quantity: qty,
      priceCents: unitCents,
      taxCents: tax,
    })

    let assignmentId: number | undefined
    if (rider) {
      const [assignment] = await db
        .insert(riderOrderAssignments)
        .values({
          orderId: order.id,
          riderUserId: rider.userId,
          assignedByUserId: wh.id,
          deliverySequence: i + 1,
          deliveryLat: pin.lat,
          deliveryLng: pin.lng,
          deliveryAddressText: `${pin.label}, Karachi`,
          status: "ASSIGNED",
        })
        .returning({ id: riderOrderAssignments.id })
      assignmentId = assignment.id
    }

    created.push({
      id: order.id,
      tid: order.tid,
      branch: `${branch.orgName} / ${branch.name}`,
      pin: `${pin.label} ${pin.lat},${pin.lng}`,
      assignmentId,
    })
  }

  console.log(`Warehouse: ${wh.username ?? wh.email} (${wh.id})`)
  console.log(`Branches used: ${pool.map((b) => b.name).join(", ")}`)
  if (rider) console.log(`Assigned to rider ${rider.code} (${rider.userId}) — open Plan route`)
  console.log(`Created ${created.length} APPROVED + OUT_FOR_DELIVERY orders:\n`)
  for (const row of created) {
    console.log(`  #${row.id}  ${row.tid}  ${row.branch}`)
    console.log(`         pin: ${row.pin}${row.assignmentId ? `  assignment #${row.assignmentId}` : ""}`)
  }
  if (!rider) {
    console.log(`\nRefresh Warehouse → Orders → Out for delivery, then Assign.`)
  } else {
    console.log(`\nWarehouse → Riders → Plan route — road line is stop 1→2→…→${count} (no return to warehouse).`)
  }
}

main()
  .then(async () => {
    await closePool()
    process.exit(0)
  })
  .catch(async (error) => {
    console.error(error)
    await closePool().catch(() => undefined)
    process.exit(1)
  })

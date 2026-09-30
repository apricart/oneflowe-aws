import "server-only"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { branchDeliveryAddresses, branches, users } from "@/db/schema"
import {
  deliveryAddressLabelKey,
  normalizeDeliveryAddressLabel,
  statusForDecision,
  type DeliveryAddressDecision,
  type DeliveryAddressStatus,
} from "@/lib/delivery-address"
import { db } from "@/lib/db"

/**
 * Reading and writing a branch's delivery addresses.
 *
 * Every function here takes its tenant and its branch set from the caller,
 * which resolves both from the session (`lib/server/delivery-address-scope.ts`)
 * — nothing in this module reads a session, and nothing accepts a branch id it
 * then trusts on its own. An empty `branchIds` returns nothing and is never
 * widened.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The columns any caller may see. Explicit, so a wide row cannot leak by default. */
const addressColumns = {
  id: branchDeliveryAddresses.id,
  organizationId: branchDeliveryAddresses.organizationId,
  branchId: branchDeliveryAddresses.branchId,
  label: branchDeliveryAddresses.label,
  address: branchDeliveryAddresses.address,
  city: branchDeliveryAddresses.city,
  province: branchDeliveryAddresses.province,
  contactPerson: branchDeliveryAddresses.contactPerson,
  contactPhone: branchDeliveryAddresses.contactPhone,
  status: branchDeliveryAddresses.status,
  requestReason: branchDeliveryAddresses.requestReason,
  requestedByUserId: branchDeliveryAddresses.requestedByUserId,
  decisionReason: branchDeliveryAddresses.decisionReason,
  decidedByUserId: branchDeliveryAddresses.decidedByUserId,
  decidedAt: branchDeliveryAddresses.decidedAt,
  createdAt: branchDeliveryAddresses.createdAt,
  updatedAt: branchDeliveryAddresses.updatedAt,
}

export type DeliveryAddressRow = {
  id: number
  organizationId: number
  branchId: number
  branchName: string | null
  label: string
  address: string
  city: string | null
  province: string | null
  contactPerson: string | null
  contactPhone: string | null
  status: string
  requestReason: string | null
  requestedByUserId: string
  requestedByName: string | null
  decisionReason: string | null
  decidedByUserId: string | null
  decidedAt: Date | string | null
  createdAt: Date | string | null
  updatedAt: Date | string | null
}

/**
 * Which branches a listing covers.
 *
 * A discriminated union rather than a nullable array on purpose. "The whole
 * tenant" is a decision Head Office's scope resolver makes explicitly; every
 * other caller passes the branches it resolved, and **an empty array stays an
 * empty array** — there is no value a caller can pass by accident that turns
 * "no branches" into "every branch".
 */
export type DeliveryAddressListScope =
  | { scope: "tenant" }
  | { scope: "branches"; branchIds: number[] }

/**
 * The addresses at a set of branches, newest first.
 *
 * The tenant predicate is always present and is the real fence; the branch
 * list narrows within it. The join on `branches.organization_id` re-asserts the
 * tenant the row was written under, so a branch that somehow belonged to
 * another organization contributes nothing either way.
 */
export async function listDeliveryAddresses(input: {
  organizationId: number
  branches: DeliveryAddressListScope
  status?: DeliveryAddressStatus
  limit: number
}): Promise<DeliveryAddressRow[]> {
  if (input.branches.scope === "branches" && input.branches.branchIds.length === 0) {
    return []
  }
  const branchPredicate = input.branches.scope === "branches"
    ? [inArray(branchDeliveryAddresses.branchId, input.branches.branchIds)]
    : []

  const rows = await db
    .select({
      ...addressColumns,
      branchName: branches.name,
      requestedByFirstName: users.firstName,
      requestedByLastName: users.lastName,
    })
    .from(branchDeliveryAddresses)
    .innerJoin(
      branches,
      and(
        eq(branches.id, branchDeliveryAddresses.branchId),
        // Re-assert the tenant the row was written under, so the branch list is
        // never the only thing standing between two organizations.
        eq(branches.organizationId, branchDeliveryAddresses.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, branchDeliveryAddresses.requestedByUserId))
    .where(and(
      eq(branchDeliveryAddresses.organizationId, input.organizationId),
      ...branchPredicate,
      ...(input.status ? [eq(branchDeliveryAddresses.status, input.status)] : []),
    ))
    .orderBy(desc(branchDeliveryAddresses.createdAt), desc(branchDeliveryAddresses.id))
    .limit(input.limit)

  return rows.map((row) => {
    const { requestedByFirstName, requestedByLastName, ...rest } = row
    const name = [requestedByFirstName, requestedByLastName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ")
    return { ...rest, requestedByName: name || null }
  })
}

export type DeliveryAddressBranchOption = { id: number; name: string }

/**
 * The branches this caller may raise a request for, named.
 *
 * Takes the already-resolved branch set rather than a role, so the only way to
 * appear in this list is to have been resolved into the caller's scope from the
 * session. The tenant predicate is applied again here: a stale assignment row
 * pointing at a branch that has since moved tenants contributes nothing.
 *
 * Empty for Head Office, which decides requests rather than raising them —
 * `requestableBranches` means exactly what it says and is not a tenant branch
 * directory in disguise.
 */
export async function listRequestableBranches(input: {
  organizationId: number
  branchIds: number[]
}): Promise<DeliveryAddressBranchOption[]> {
  if (input.branchIds.length === 0) return []

  return db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(
      inArray(branches.id, input.branchIds),
      eq(branches.organizationId, input.organizationId),
    ))
    .orderBy(branches.name)
}

/** The badge on the Head Office queue. Counted separately so a filter cannot stale it. */
export async function countPendingDeliveryAddresses(organizationId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(branchDeliveryAddresses)
    .where(and(
      eq(branchDeliveryAddresses.organizationId, organizationId),
      eq(branchDeliveryAddresses.status, "pending"),
    ))
  return row?.count ?? 0
}

export type DeliveryAddressFailure = { ok: false; message: string; status: number }

/** The Postgres unique violation raised by `branch_delivery_addresses_live_label_uq`. */
function isDuplicateLabel(exception: unknown): boolean {
  const databaseError = (exception as { cause?: unknown })?.cause ?? exception
  const code = (databaseError as { code?: string })?.code
    ?? (exception as { code?: string })?.code
  return code === "23505"
}

/**
 * Raise a request. Always `pending` — there is no parameter that could make it
 * anything else, which is what stops a requester approving its own address.
 *
 * The branch is verified to belong to the caller's tenant here as well as being
 * in the caller's resolved set: the set comes from assignments, and an
 * assignment row that outlived a branch moving tenants would otherwise be the
 * only thing checked.
 */
export async function createDeliveryAddressRequest(input: {
  organizationId: number
  branchId: number
  requestedByUserId: string
  label: string
  address: string
  city: string | null
  province: string | null
  contactPerson: string | null
  contactPhone: string | null
  requestReason: string | null
}): Promise<{ ok: true; address: DeliveryAddressRow } | DeliveryAddressFailure> {
  const [branch] = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(
      eq(branches.id, input.branchId),
      eq(branches.organizationId, input.organizationId),
    ))
    .limit(1)
  if (!branch) {
    return { ok: false, message: "Branch not found", status: 404 }
  }

  const label = normalizeDeliveryAddressLabel(input.label)
  const labelKey = deliveryAddressLabelKey(input.label)
  if (!label || !labelKey) {
    return { ok: false, message: "A label is required", status: 400 }
  }

  try {
    const [created] = await db
      .insert(branchDeliveryAddresses)
      .values({
        organizationId: input.organizationId,
        branchId: input.branchId,
        label,
        labelKey,
        address: input.address.trim(),
        city: input.city,
        province: input.province,
        contactPerson: input.contactPerson,
        contactPhone: input.contactPhone,
        // Set here and nowhere else. `status` is not a field any caller supplies.
        status: "pending",
        requestReason: input.requestReason,
        requestedByUserId: input.requestedByUserId,
      })
      .returning(addressColumns)

    return {
      ok: true,
      address: {
        ...created,
        branchName: branch.name,
        requestedByName: null,
      },
    }
  } catch (caughtError) {
    if (isDuplicateLabel(caughtError)) {
      return {
        ok: false,
        message: "This branch already has an address under that name awaiting a decision or approved.",
        status: 409,
      }
    }
    throw caughtError
  }
}

export type DeliveryAddressDecisionOutcome =
  | {
    ok: true
    addressId: number
    branchId: number
    label: string
    status: DeliveryAddressStatus
    requestedByUserId: string
  }
  | DeliveryAddressFailure

/**
 * Approve or reject one request.
 *
 * **The only path that makes an address usable.** Without a call to this, a row
 * stays pending and no order can name it.
 *
 * The fence is the pair `(id, organizationId)` in the `WHERE` of the
 * `FOR UPDATE` lock, so another tenant's row is *not found* rather than
 * forbidden — the same answer as one that does not exist, so the id space
 * cannot be enumerated.
 *
 * Replay is that lock plus the status check: two administrators deciding at
 * once produce one decision and one 409, and a retried approval of an
 * already-decided row is a 409 rather than a second approval.
 */
export async function decideDeliveryAddressRequest(input: {
  addressId: number
  organizationId: number
  actorUserId: string
  decision: DeliveryAddressDecision
  reason: string | null
}): Promise<DeliveryAddressDecisionOutcome> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        id: branchDeliveryAddresses.id,
        branchId: branchDeliveryAddresses.branchId,
        label: branchDeliveryAddresses.label,
        status: branchDeliveryAddresses.status,
        requestedByUserId: branchDeliveryAddresses.requestedByUserId,
      })
      .from(branchDeliveryAddresses)
      .where(and(
        eq(branchDeliveryAddresses.id, input.addressId),
        eq(branchDeliveryAddresses.organizationId, input.organizationId),
      ))
      .for("update")
      .limit(1)

    if (!stored) {
      return { ok: false as const, message: "Delivery address not found", status: 404 }
    }
    if (stored.status !== "pending") {
      return {
        ok: false as const,
        message: `This address has already been ${stored.status}.`,
        status: 409,
      }
    }

    const decidedAt = new Date()
    const status = statusForDecision(input.decision)

    await tx
      .update(branchDeliveryAddresses)
      .set({
        status,
        decisionReason: input.reason,
        decidedByUserId: input.actorUserId,
        decidedAt,
        updatedAt: decidedAt,
      })
      .where(eq(branchDeliveryAddresses.id, stored.id))

    return {
      ok: true as const,
      addressId: stored.id,
      branchId: stored.branchId,
      label: stored.label,
      status,
      requestedByUserId: stored.requestedByUserId,
    }
  })
}

export type ApprovedDeliveryAddress = {
  id: number
  label: string
  address: string
  city: string | null
  province: string | null
  contactPerson: string | null
  contactPhone: string | null
}

/**
 * The one read order creation trusts.
 *
 * Takes a client so the caller can run it **inside the creation transaction**,
 * beside the budget lock and before the order row — an address approved and
 * then rejected between the selector rendering and the order committing must
 * not slip through.
 *
 * Every part of the tuple is asserted: the id, the tenant, the branch the order
 * is actually for, and `status = 'approved'`. A pending, rejected, other-branch
 * or other-tenant address returns null and the order is refused.
 */
export async function loadApprovedDeliveryAddress(
  client: DbClient,
  input: { organizationId: number; branchId: number; addressId: number },
): Promise<ApprovedDeliveryAddress | null> {
  const [row] = await client
    .select({
      id: branchDeliveryAddresses.id,
      label: branchDeliveryAddresses.label,
      address: branchDeliveryAddresses.address,
      city: branchDeliveryAddresses.city,
      province: branchDeliveryAddresses.province,
      contactPerson: branchDeliveryAddresses.contactPerson,
      contactPhone: branchDeliveryAddresses.contactPhone,
    })
    .from(branchDeliveryAddresses)
    .where(and(
      eq(branchDeliveryAddresses.id, input.addressId),
      eq(branchDeliveryAddresses.organizationId, input.organizationId),
      eq(branchDeliveryAddresses.branchId, input.branchId),
      eq(branchDeliveryAddresses.status, "approved"),
    ))
    .limit(1)

  return row ?? null
}

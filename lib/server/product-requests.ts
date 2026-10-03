import "server-only"

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { categories, organizations, productRequests, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  PRODUCT_REQUEST_STATUSES,
  productRequestAvailabilityRefusal,
  productRequestTransitionRefusal,
  type ProductRequestInput,
  type ProductRequestList,
  type ProductRequestListQuery,
  type ProductRequestReview,
  type ProductRequestStatus,
} from "@/lib/product-request"
import type { ProductRequestVisibilityScope } from "@/lib/product-request-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { isDataUrl, isStoredImagePath } from "@/lib/server/image-storage"

/**
 * Reading and writing new-product requests.
 *
 * Every function takes facts the route has already derived from the session —
 * the raiser's tenant, the viewer's scope, the reviewer's id — and never reads
 * the request. Who may call which function is `lib/product-request-access.ts`,
 * checked by the route before it gets here.
 */

export type ProductRequestFailure = { status: 400 | 404 | 409; message: string }

type Result<T> = ({ ok: true } & T) | { ok: false; failure: ProductRequestFailure }

const fail = (status: ProductRequestFailure["status"], message: string) =>
  ({ ok: false as const, failure: { status, message } })

/** The Head Office user raising a request. The tenant comes from their user row. */
export type ProductRequestRaiser = {
  userId: string
  role: string
  organizationId: number
}

/**
 * Why an image value cannot be stored, or null when it can.
 *
 * Only the application path the upload route returns is accepted: never a
 * `data:` URL (the upload route falls back to one when S3 is not configured,
 * and CLAUDE.md forbids writing one to a column) and never an external address
 * (which would make every reader's browser fetch from wherever it points).
 */
export function productRequestImageFailure(imageUrl: string | null): string | null {
  if (imageUrl === null) return null
  if (isDataUrl(imageUrl)) {
    return "Image storage is not available right now. Remove the image or try again later."
  }
  if (!isStoredImagePath(imageUrl)) {
    return "The image must be uploaded through the form. Please upload it again."
  }
  return null
}

type ResolvedCategories = { categoryId: number | null; subcategoryId: number | null }

/**
 * Check the category pair against the taxonomy.
 *
 * A category must be top-level and a subcategory must have a parent; when both
 * are given the subcategory must sit under the category. A subcategory given
 * alone brings its parent with it, so the request always names both levels.
 */
async function resolveCategories(input: ProductRequestInput): Promise<Result<ResolvedCategories>> {
  let categoryId = input.categoryId

  if (categoryId !== null) {
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.id, categoryId), isNull(categories.parentId)))
      .limit(1)
    if (!category) return fail(400, "The selected category does not exist")
  }

  if (input.subcategoryId === null) return { ok: true, categoryId, subcategoryId: null }

  const [subcategory] = await db
    .select({ id: categories.id, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.id, input.subcategoryId), isNotNull(categories.parentId)))
    .limit(1)
  if (!subcategory) return fail(400, "The selected subcategory does not exist")

  if (categoryId === null) {
    categoryId = subcategory.parentId
  } else if (subcategory.parentId !== categoryId) {
    return fail(400, "The selected subcategory does not belong to the selected category")
  }

  return { ok: true, categoryId, subcategoryId: subcategory.id }
}

export async function createProductRequest(input: {
  raiser: ProductRequestRaiser
  request: ProductRequestInput
}): Promise<Result<{ id: number }>> {
  const { raiser, request } = input

  const imageFailure = productRequestImageFailure(request.imageUrl)
  if (imageFailure) return fail(400, imageFailure)

  const resolved = await resolveCategories(request)
  if (!resolved.ok) return resolved

  const values = {
    productName: request.productName,
    brand: request.brand,
    description: request.description,
    categoryId: resolved.categoryId,
    subcategoryId: resolved.subcategoryId,
    unit: request.unit,
    packSize: request.packSize,
    barcode: request.barcode,
    expectedPriceCents: request.expectedPriceCents,
    estimatedMonthlyQuantity: request.estimatedMonthlyQuantity,
    preferredSupplier: request.preferredSupplier,
    referenceUrl: request.referenceUrl,
    notes: request.notes,
    imageUrl: request.imageUrl,
  }

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(productRequests)
      .values({
        ...values,
        // Tenant and author from the session-derived raiser, never the body.
        organizationId: raiser.organizationId,
        requestedByUserId: raiser.userId,
        status: "PENDING",
      })
      .returning({ id: productRequests.id })

    await recordAuditEvent(tx, {
      action: "CREATE_PRODUCT_REQUEST",
      entity: "product_request",
      entityId: row.id,
      actor: { id: raiser.userId, role: raiser.role },
      organizationId: raiser.organizationId,
      after: { ...values, status: "PENDING" },
    })

    return row.id
  })

  return { ok: true, id }
}

/**
 * The tenant predicate, from the viewer's scope alone. A Super Admin may narrow
 * to one organization; Head Office is already pinned to its own, and any
 * organization it names is ignored by the caller before it gets here.
 */
function scopeCondition(scope: ProductRequestVisibilityScope, organizationId: number | null): SQL | undefined {
  if (scope.kind === "organization") return eq(productRequests.organizationId, scope.organizationId)
  if (scope.kind === "all") {
    return organizationId === null ? undefined : eq(productRequests.organizationId, organizationId)
  }
  // `none` never reaches here — the route refuses it — but if it did, it reads nothing.
  return sql`false`
}

const toIso = (value: Date | string | null): string | null => {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const named = (id: number | null, name: string | null) =>
  id === null || name === null ? null : { id, name }

export async function listProductRequests(
  scope: ProductRequestVisibilityScope,
  query: ProductRequestListQuery,
): Promise<ProductRequestList> {
  const tenant = scopeCondition(scope, scope.kind === "all" ? query.organizationId : null)
  const filtered = and(tenant, query.status === null ? undefined : eq(productRequests.status, query.status))

  const requester = alias(users, "product_request_requester")
  const reviewer = alias(users, "product_request_reviewer")
  const reviewStarter = alias(users, "product_request_review_starter")
  const category = alias(categories, "product_request_category")
  const subcategory = alias(categories, "product_request_subcategory")

  const [rows, [totalRow], countRows, organizationRows] = await Promise.all([
    db
      .select({
        id: productRequests.id,
        status: productRequests.status,
        productName: productRequests.productName,
        brand: productRequests.brand,
        description: productRequests.description,
        categoryId: productRequests.categoryId,
        categoryName: category.name,
        subcategoryId: productRequests.subcategoryId,
        subcategoryName: subcategory.name,
        unit: productRequests.unit,
        packSize: productRequests.packSize,
        barcode: productRequests.barcode,
        expectedPriceCents: productRequests.expectedPriceCents,
        estimatedMonthlyQuantity: productRequests.estimatedMonthlyQuantity,
        preferredSupplier: productRequests.preferredSupplier,
        referenceUrl: productRequests.referenceUrl,
        notes: productRequests.notes,
        imageUrl: productRequests.imageUrl,
        reviewStartedAt: productRequests.reviewStartedAt,
        reviewStartedById: reviewStarter.id,
        reviewStartedByName: reviewStarter.fullName,
        reviewNote: productRequests.reviewNote,
        reviewedAt: productRequests.reviewedAt,
        reviewedById: reviewer.id,
        reviewedByName: reviewer.fullName,
        estimatedAvailableOn: productRequests.estimatedAvailableOn,
        createdAt: productRequests.createdAt,
        organizationId: organizations.id,
        organizationName: organizations.name,
        requesterId: requester.id,
        requesterName: requester.fullName,
        requesterEmail: requester.email,
        requesterRole: roles.name,
      })
      .from(productRequests)
      .innerJoin(organizations, eq(productRequests.organizationId, organizations.id))
      .innerJoin(requester, eq(productRequests.requestedByUserId, requester.id))
      .leftJoin(roles, eq(requester.roleId, roles.id))
      .leftJoin(reviewer, eq(productRequests.reviewedByUserId, reviewer.id))
      .leftJoin(reviewStarter, eq(productRequests.reviewStartedByUserId, reviewStarter.id))
      .leftJoin(category, eq(productRequests.categoryId, category.id))
      .leftJoin(subcategory, eq(productRequests.subcategoryId, subcategory.id))
      .where(filtered)
      .orderBy(desc(productRequests.createdAt), desc(productRequests.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ value: count() }).from(productRequests).where(filtered),
    // Counts ignore the status filter so the tabs can show every bucket at once.
    db
      .select({ status: productRequests.status, value: count() })
      .from(productRequests)
      .where(tenant)
      .groupBy(productRequests.status),
    scope.kind === "all"
      ? db
        .selectDistinct({ id: organizations.id, name: organizations.name })
        .from(productRequests)
        .innerJoin(organizations, eq(productRequests.organizationId, organizations.id))
        .orderBy(asc(organizations.name))
      : Promise.resolve([] as Array<{ id: number; name: string }>),
  ])

  const counts = Object.fromEntries(PRODUCT_REQUEST_STATUSES.map((status) => [status, 0])) as Record<ProductRequestStatus, number>
  for (const row of countRows) {
    if (row.status in counts) counts[row.status as ProductRequestStatus] = Number(row.value)
  }

  return {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status as ProductRequestStatus,
      productName: row.productName,
      brand: row.brand,
      description: row.description,
      category: named(row.categoryId, row.categoryName),
      subcategory: named(row.subcategoryId, row.subcategoryName),
      unit: row.unit,
      packSize: row.packSize,
      barcode: row.barcode,
      expectedPriceCents: row.expectedPriceCents,
      estimatedMonthlyQuantity: row.estimatedMonthlyQuantity === null ? null : Number(row.estimatedMonthlyQuantity),
      preferredSupplier: row.preferredSupplier,
      referenceUrl: row.referenceUrl,
      notes: row.notes,
      imageUrl: row.imageUrl,
      reviewStartedAt: toIso(row.reviewStartedAt),
      reviewStartedBy: row.reviewStartedById === null ? null : { id: row.reviewStartedById, fullName: row.reviewStartedByName },
      reviewNote: row.reviewNote,
      reviewedAt: toIso(row.reviewedAt),
      reviewedBy: row.reviewedById === null ? null : { id: row.reviewedById, fullName: row.reviewedByName },
      estimatedAvailableOn: row.estimatedAvailableOn,
      createdAt: toIso(row.createdAt) ?? "",
      organization: { id: row.organizationId, name: row.organizationName },
      requestedBy: {
        id: row.requesterId,
        fullName: row.requesterName,
        email: row.requesterEmail,
        role: row.requesterRole,
      },
    })),
    total: Number(totalRow?.value ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    counts,
    organizations: organizationRows,
  }
}

/**
 * Move a request on: put it under review, or record Super Admin's decision.
 *
 * The row is locked and its status re-read inside the transaction, and the
 * update is conditional on the status it was read in, so two reviewers — or
 * one double click — cannot both move it: the second sees a request that has
 * already moved and gets a 409. An approval's date is checked against today
 * here, not in the schema, so the schema never reads the clock.
 */
export async function reviewProductRequest(input: {
  reviewer: AuditActor & { id: string }
  requestId: number
  review: ProductRequestReview
  now?: Date
}): Promise<Result<{ id: number; status: ProductRequestStatus }>> {
  const { reviewer, requestId, review } = input
  const now = input.now ?? new Date()

  if (review.status === "APPROVED") {
    const dateRefusal = productRequestAvailabilityRefusal(review.estimatedAvailableOn, now)
    if (dateRefusal) return fail(400, dateRefusal)
  }

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: productRequests.id,
        status: productRequests.status,
        organizationId: productRequests.organizationId,
      })
      .from(productRequests)
      .where(eq(productRequests.id, requestId))
      .limit(1)
      .for("update")

    if (!current) return fail(404, "Product request not found")
    const refusal = productRequestTransitionRefusal(current.status, review.status)
    if (refusal) return fail(409, refusal)

    if (review.status === "UNDER_REVIEW") {
      await tx
        .update(productRequests)
        .set({ status: "UNDER_REVIEW", reviewStartedByUserId: reviewer.id, reviewStartedAt: now, updatedAt: now })
        .where(and(eq(productRequests.id, requestId), eq(productRequests.status, "PENDING")))

      await recordAuditEvent(tx, {
        action: "START_PRODUCT_REQUEST_REVIEW",
        entity: "product_request",
        entityId: requestId,
        actor: reviewer,
        organizationId: current.organizationId,
        before: { status: current.status },
        after: { status: "UNDER_REVIEW" },
      })

      return { ok: true as const, id: requestId, status: review.status }
    }

    const estimatedAvailableOn = review.status === "APPROVED" ? review.estimatedAvailableOn : null
    await tx
      .update(productRequests)
      .set({
        status: review.status,
        reviewNote: review.reviewNote,
        reviewedByUserId: reviewer.id,
        reviewedAt: now,
        estimatedAvailableOn,
        updatedAt: now,
      })
      .where(and(eq(productRequests.id, requestId), inArray(productRequests.status, ["PENDING", "UNDER_REVIEW"])))

    await recordAuditEvent(tx, {
      action: "REVIEW_PRODUCT_REQUEST",
      entity: "product_request",
      entityId: requestId,
      actor: reviewer,
      organizationId: current.organizationId,
      before: { status: current.status },
      after: { status: review.status, reviewNote: review.reviewNote, estimatedAvailableOn },
    })

    return { ok: true as const, id: requestId, status: review.status }
  })
}

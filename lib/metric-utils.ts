/**
 * Centralized Metric Utility — Single Source of Truth
 * 
 * ALL analytics APIs must use these expressions for KPI calculations.
 * This eliminates data drift between Dashboard, Reports, and Drill-downs.
 * 
 * BUSINESS RULES:
 * - Revenue = SUM of totalCents WHERE status IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')
 *   Refunds have NO calculation in net revenue (it can never be negative).
 * - Total Orders = COUNT of ALL orders (every status)
 * - Order Volume = COUNT of revenue-generating orders: FULFILLED, APPROVED, PARTIAL
 */

import { sql } from "drizzle-orm"
import { orders } from "@/db/schema"

/**
 * Shared SQL expressions for all analytics queries.
 * Import these into every analytics route to guarantee parity.
 */
export const metricExpressions = {
    /** Revenue: order-level net revenue for FULFILLED + APPROVED orders (Subtracts refunds) */
    revenue: sql<number>`COALESCE(SUM(
    CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN
      ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)
    ELSE 0 END
  ), 0)`.mapWith(Number),

    /** Order Volume: count of revenue-generating orders (FULFILLED + APPROVED + PARTIAL) */
    orderVolume: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN 1
    END
  ), 0)`.mapWith(Number),

    /** Fulfilled order count (includes partially-refunded fulfilled orders) */
    fulfilledCount: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN 1 END
  ), 0)`.mapWith(Number),

    /** Partial order count (Fulfilled but with some refunds, or status is explicitly PARTIAL) */
    partialCount: sql<number>`COALESCE(COUNT(
    CASE 
        WHEN UPPER(${orders.status}) = 'FULFILLED' AND COALESCE(${orders.refundAmountCents}, 0) > 0 THEN 1 
        WHEN UPPER(${orders.status}) IN ('PARTIAL', 'PARTIALLY_FULFILLED') THEN 1
    END
  ), 0)`.mapWith(Number),

    /** Total Fulfilled (Full + Partial) for legacy or high-level views */
    totalFulfilledCount: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN 1 END
  ), 0)`.mapWith(Number),

    /** Rejected order count (includes CANCELLED) */
    rejectedCount: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) IN ('REJECTED', 'CANCELLED') THEN 1 END
  ), 0)`.mapWith(Number),

    /** Refunded order count */
    refundedCount: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 1 END
  ), 0)`.mapWith(Number),

    /** Approved order count */
    approvedCount: sql<number>`COALESCE(COUNT(
    CASE WHEN UPPER(${orders.status}) = 'APPROVED' THEN 1 END
  ), 0)`.mapWith(Number),

    /** Total refund amount (from all orders that have refunds) */
    totalRefundAmount: sql<number>`COALESCE(SUM(
    CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'REFUNDED')
         THEN COALESCE(${orders.refundAmountCents}, 0)
         ELSE 0
    END
  ), 0)`.mapWith(Number),

    /** Total order count across ALL statuses */
    totalOrderCount: sql<number>`COALESCE(COUNT(${orders.id}), 0)`.mapWith(Number),
}

/**
 * Status filter for queries that should only include revenue-eligible orders.
 * Use this in WHERE clauses when the query is specifically for revenue/financial data.
 */
export const REVENUE_ELIGIBLE_FILTER = sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED')`

/**
 * Status filter for what a budget has *consumed*: the revenue-eligible orders
 * plus those still awaiting approval. This is the ledger's own "spent + held",
 * and the only place PENDING joins a money query — use it where a figure has
 * to reconcile with a budget position, never for revenue.
 */
export const CONSUMED_ELIGIBLE_FILTER = sql`UPPER(${orders.status}) IN ('FULFILLED', 'APPROVED', 'PARTIAL', 'PARTIALLY_FULFILLED', 'PENDING')`

/** @deprecated Use REVENUE_ELIGIBLE_FILTER instead */
export const FULFILLED_ONLY_FILTER = REVENUE_ELIGIBLE_FILTER

/** @deprecated Use REVENUE_ELIGIBLE_FILTER instead */
export const FULFILLED_AND_REFUNDED_FILTER = REVENUE_ELIGIBLE_FILTER

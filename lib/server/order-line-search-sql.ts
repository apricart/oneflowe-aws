import "server-only"

import { sql, type SQL } from "drizzle-orm"

import { orderItems, orders } from "@/db/schema"

/**
 * An order one of whose lines names a matching product, by name or code.
 * `pattern` is an already-escaped ILIKE pattern, bound as a parameter.
 */
export function orderLineMatchesSql(pattern: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${orderItems}
    WHERE ${orderItems.orderId} = ${orders.id}
    AND (${orderItems.productName} ILIKE ${pattern} OR ${orderItems.productCode} ILIKE ${pattern})
  )`
}

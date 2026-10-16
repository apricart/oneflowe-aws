import "server-only"

import { and, isNull, sql } from "drizzle-orm"

import { globalProducts } from "@/db/schema"
import { db } from "@/lib/db"
import { getNextCanonicalProductCode } from "@/lib/product-code"

/**
 * A global product's code is assigned by the server, never typed by the
 * Super Admin: the next number in the canonical `PRD--<n>` series.
 *
 * `nextGlobalProductCode` only reads, so the create form can preview the code
 * it will probably get. The create itself calls `assignGlobalProductCodeInTx`,
 * which serializes on an advisory lock so two concurrent creates cannot both
 * draw the same number; the code shown on the form is therefore a preview and
 * the saved one may be later if someone else saved first.
 */

type Executor = Pick<typeof db, "select">
type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

const MAX_ATTEMPTS = 100

async function productCodeExists(executor: Executor, productCode: string): Promise<boolean> {
  const [existingProduct] = await executor
    .select({ id: globalProducts.id })
    .from(globalProducts)
    .where(
      and(
        sql`lower(btrim(${globalProducts.productCode})) = lower(btrim(${productCode}))`,
        isNull(globalProducts.deletedAt),
      ),
    )
    .limit(1)

  return Boolean(existingProduct)
}

/** The next free canonical code, or null when none was found in 100 tries. */
export async function nextGlobalProductCode(executor: Executor = db): Promise<string | null> {
  const catalogProducts = await executor
    .select({ productCode: globalProducts.productCode })
    .from(globalProducts)
    .where(isNull(globalProducts.deletedAt))

  const observedProductCodes = catalogProducts.map(({ productCode }) => productCode)
  let productCode = getNextCanonicalProductCode(observedProductCodes)

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (!(await productCodeExists(executor, productCode))) return productCode
    observedProductCodes.push(productCode)
    productCode = getNextCanonicalProductCode(observedProductCodes)
  }
  return null
}

/**
 * Draws the code for a product about to be inserted in `tx`. The lock is held
 * until `tx` ends, so the insert must happen in the same transaction.
 */
export async function assignGlobalProductCodeInTx(tx: TransactionExecutor): Promise<string | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('oneflowe:global-product-code'))`)
  return nextGlobalProductCode(tx)
}

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * A contract test, in the manner of `lib/pricing-access.test.ts`: the guarantee
 * it protects is structural, so it is asserted against the source rather than
 * against behaviour.
 *
 * The guarantee: **an order can only ever name a delivery address that
 * `loadApprovedDeliveryAddress` returned.** That function is the one read that
 * asserts the whole tuple — id, tenant, the order's own branch, and
 * `status = 'approved'` — and the integration suite exercises every way it can
 * refuse. What behaviour cannot easily prove is that a *future* order route
 * goes through it instead of writing the id straight off the request body,
 * which would let a pending or another tenant's address onto an order.
 *
 * When you add a route that writes `orders.delivery_address_id`, add it to
 * `ORDER_ROUTES_WRITING_A_DELIVERY_ADDRESS`. A route missing from that list is
 * silently unguarded, which is exactly what this file exists to prevent.
 */

const ORDER_ROUTES_WRITING_A_DELIVERY_ADDRESS = [
  "app/api/v1/orders/route.ts",
  "app/api/v1/orders/[id]/route.ts",
]

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/** Strip comments, so prose about a symbol is never mistaken for a use of it. */
function code(path: string): string {
  return source(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

describe("every order route that records a delivery address verifies it first", () => {
  it.each(ORDER_ROUTES_WRITING_A_DELIVERY_ADDRESS)(
    "%s imports the guard",
    (path) => {
      expect(code(path)).toContain("loadApprovedDeliveryAddress")
    },
  )

  it.each(ORDER_ROUTES_WRITING_A_DELIVERY_ADDRESS)(
    "%s calls the guard inside a transaction, not on the pooled client",
    (path) => {
      // `tx` is the transaction handle throughout both routes. Verifying on
      // `db` instead would read outside the lock that protects the write, so an
      // address rejected mid-flight could still reach the order.
      expect(code(path)).toMatch(/loadApprovedDeliveryAddress\(\s*tx\s*,/)
    },
  )

  /**
   * The value written must come from the verified row, never from the parsed
   * body. `context.deliveryAddressId` is the caller's raw input; only
   * `deliveryAddress`, the row the guard returned, may reach the column.
   */
  it("the creation route writes the verified row's id, not the requested one", () => {
    const creation = code("app/api/v1/orders/route.ts")
    expect(creation).toContain("deliveryAddressId: context.deliveryAddress.id")
    expect(creation).not.toMatch(/deliveryAddressId:\s*context\.deliveryAddressId/)
  })

  it("the edit route writes the verified row's id, or null to clear it", () => {
    const edit = code("app/api/v1/orders/[id]/route.ts")
    expect(edit).toContain("deliveryAddressId: context.deliveryAddress?.id ?? null")
    expect(edit).not.toMatch(/deliveryAddressId:\s*context\.deliveryAddressId\s*[,}]/)
  })

  /**
   * The receipt is the lasting record of where goods were sent, so it must be
   * built from the same verified row rather than from a second read that could
   * disagree with the guard.
   */
  it.each(ORDER_ROUTES_WRITING_A_DELIVERY_ADDRESS)(
    "%s builds the receipt from the verified row",
    (path) => {
      expect(code(path)).toMatch(/deliveryAddress:\s*context\.deliveryAddress\s*\?\?\s*null/)
    },
  )
})

describe("the creation fingerprint stays compatible with orders that name no address", () => {
  /**
   * `orderRequestFingerprint` decides whether a retried `Idempotency-Key` is
   * the same request. Adding the field unconditionally would change the hash of
   * every ordinary order, turning a retry that spanned the deploy into a 409
   * "key already used for a different order".
   *
   * So the key must be spread in conditionally and must never appear as an
   * unconditional property of the canonical object.
   */
  const creation = code("app/api/v1/orders/route.ts")
  const canonical = creation.slice(
    creation.indexOf("const canonical = {"),
    creation.indexOf("return createHash(\"sha256\")"),
  )

  it("was found, so the assertions below are about something", () => {
    expect(canonical).toContain("organizationId: input.organizationId")
  })

  it("includes the address only when one was chosen", () => {
    expect(canonical).toMatch(
      /\.\.\.\(input\.deliveryAddressId\s*\?\s*\{\s*deliveryAddressId:\s*input\.deliveryAddressId\s*\}\s*:\s*\{\}\)/,
    )
  })

  it("never writes it as an always-present null", () => {
    expect(canonical).not.toMatch(/deliveryAddressId:\s*input\.deliveryAddressId\s*\?\?\s*null/)
    expect(canonical).not.toMatch(/^\s*deliveryAddressId:\s*input\.deliveryAddressId,/m)
  })
})

describe("the order row is read defensively while the migration is applied by hand", () => {
  /**
   * Production migrations here are applied by hand, so the application can be
   * running ahead of them. `orderSelectColumns` therefore reads the column
   * through `to_jsonb`, as `fulfillment_status` and `payment_status` already
   * do — a direct column reference would fail every order read on an
   * environment whose migration has not landed.
   */
  it("selects delivery_address_id through to_jsonb rather than as a column", () => {
    const select = code("lib/order-select.ts")
    expect(select).toMatch(/to_jsonb\("orders"\)\s*->>\s*'delivery_address_id'/)
    expect(select).not.toContain("deliveryAddressId: orders.deliveryAddressId")
  })

  it("adds the column to the insert only when an address was chosen", () => {
    const creation = code("app/api/v1/orders/route.ts")
    expect(creation).toMatch(
      /\.\.\.\(context\.deliveryAddress\s*\?\s*\{\s*deliveryAddressId:\s*context\.deliveryAddress\.id\s*\}\s*:\s*\{\}\)/,
    )
  })
})

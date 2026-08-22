import { beforeEach, describe, expect, it } from "vitest"

import {
  buildShopCartStorageKey,
  readStoredCartEntries,
  restoreCartItems,
  toStoredCartEntries,
  writeStoredCartEntries,
} from "@/lib/shop-cart-storage"

type TestProduct = { id: number; name: string; stock: number }

const clampToStock = (product: TestProduct, quantity: number) =>
  Math.min(quantity, product.stock)

describe("buildShopCartStorageKey", () => {
  it("scopes the saved cart to one user in one branch", () => {
    expect(buildShopCartStorageKey("7", 2)).toBe("oneflowe.shop-cart.v1:7:2")
    expect(buildShopCartStorageKey("7", 2)).not.toBe(buildShopCartStorageKey("8", 2))
    expect(buildShopCartStorageKey("7", 2)).not.toBe(buildShopCartStorageKey("7", 3))
  })

  it("withholds a key until both the user and the branch are known", () => {
    expect(buildShopCartStorageKey(undefined, 2)).toBeNull()
    expect(buildShopCartStorageKey("7", null)).toBeNull()
    expect(buildShopCartStorageKey("", "")).toBeNull()
  })
})

describe("cart persistence", () => {
  const key = "oneflowe.shop-cart.v1:7:2"

  beforeEach(() => {
    localStorage.clear()
  })

  it("round-trips the cart across a reload", () => {
    writeStoredCartEntries(key, toStoredCartEntries([
      { id: 11, quantity: 2 },
      { id: 12, quantity: 1.5 },
    ]))

    expect(readStoredCartEntries(key)).toEqual([
      { id: 11, quantity: 2 },
      { id: 12, quantity: 1.5 },
    ])
  })

  it("stores only identifiers and quantities, never prices", () => {
    const entries = toStoredCartEntries([
      { id: 11, quantity: 2, name: "Cola", priceCents: 9900 } as any,
    ])

    expect(entries).toEqual([{ id: 11, quantity: 2 }])
  })

  it("removes the record once the cart is emptied", () => {
    writeStoredCartEntries(key, [{ id: 11, quantity: 2 }])
    writeStoredCartEntries(key, [])

    expect(localStorage.getItem(key)).toBeNull()
  })

  it("treats a missing, corrupt, or foreign-shaped record as no saved cart", () => {
    expect(readStoredCartEntries(key)).toEqual([])

    localStorage.setItem(key, "not-json")
    expect(readStoredCartEntries(key)).toEqual([])

    localStorage.setItem(key, JSON.stringify({ id: 11, quantity: 2 }))
    expect(readStoredCartEntries(key)).toEqual([])

    localStorage.setItem(key, JSON.stringify([
      { id: 11, quantity: 2 },
      { id: "x", quantity: 2 },
      { id: 13, quantity: 0 },
      null,
    ]))
    expect(readStoredCartEntries(key)).toEqual([{ id: 11, quantity: 2 }])
  })

  it("does nothing without a key, so nothing is written before the user is known", () => {
    writeStoredCartEntries(null, [{ id: 11, quantity: 2 }])

    expect(localStorage.length).toBe(0)
    expect(readStoredCartEntries(null)).toEqual([])
  })
})

describe("restoreCartItems", () => {
  const catalogue = new Map<number, TestProduct>([
    [11, { id: 11, name: "Cola", stock: 10 }],
    [12, { id: 12, name: "Coffee", stock: 1 }],
    [13, { id: 13, name: "Withdrawn", stock: 0 }],
  ])

  it("rebuilds lines from the live catalogue rather than the saved record", () => {
    const restored = restoreCartItems([{ id: 11, quantity: 3 }], catalogue, clampToStock)

    expect(restored).toEqual([{ id: 11, name: "Cola", stock: 10, quantity: 3 }])
  })

  it("drops a product the branch no longer offers", () => {
    const restored = restoreCartItems(
      [{ id: 11, quantity: 1 }, { id: 99, quantity: 4 }],
      catalogue,
      clampToStock,
    )

    expect(restored.map((item) => item.id)).toEqual([11])
  })

  it("caps a saved quantity that now exceeds stock", () => {
    const restored = restoreCartItems([{ id: 12, quantity: 5 }], catalogue, clampToStock)

    expect(restored).toEqual([{ id: 12, name: "Coffee", stock: 1, quantity: 1 }])
  })

  it("drops a line the clamp reduces to nothing", () => {
    expect(restoreCartItems([{ id: 13, quantity: 4 }], catalogue, clampToStock)).toEqual([])
  })
})

/**
 * Browser-side persistence for the Order Portal cart (`/shop`).
 *
 * A cart lives in React state, so a refresh, an accidental tab close, or a
 * session-expiry bounce used to discard everything the user had picked. This
 * module keeps a small record of that cart in `localStorage` so the selections
 * survive a reload.
 *
 * Only the identifier and quantity of each line are stored. Names, prices, and
 * stock are always re-read from the branch inventory when the cart is restored,
 * so a resumed cart can never show a stale price or a quantity the branch can
 * no longer supply — and the server still re-checks both when the order is
 * placed.
 *
 * The key is scoped to the signed-in user and the active branch, and a restored
 * line is only accepted when the current branch catalogue still contains it, so
 * nothing stored here can widen what a user sees beyond their own tenant.
 */

const STORAGE_KEY_PREFIX = "oneflowe.shop-cart.v1"

/** The only cart facts that are durable; everything else is re-read live. */
export type StoredCartEntry = {
  id: number
  quantity: number
}

/**
 * Storage key for one user's cart in one branch, or `null` while either is
 * still unknown — the caller must not read or write until both are resolved,
 * otherwise one user's cart could be restored into another user's session.
 */
export function buildShopCartStorageKey(
  userId: unknown,
  branchId: unknown,
): string | null {
  const user = typeof userId === "string" || typeof userId === "number" ? String(userId).trim() : ""
  const branch = typeof branchId === "string" || typeof branchId === "number" ? String(branchId).trim() : ""
  if (!user || !branch) return null

  return `${STORAGE_KEY_PREFIX}:${user}:${branch}`
}

function isUsableEntry(value: unknown): value is StoredCartEntry {
  if (typeof value !== "object" || value === null) return false

  const entry = value as StoredCartEntry
  return Number.isFinite(entry.id) && Number.isFinite(entry.quantity) && entry.quantity > 0
}

/**
 * Read the stored entries for `key`.
 *
 * Anything unreadable — absent, corrupt, or written by an older shape — is
 * treated as "no saved cart" rather than surfaced as an error, since a cart is
 * a convenience and must never block the shop from opening.
 */
export function readStoredCartEntries(key: string | null): StoredCartEntry[] {
  if (!key || typeof window === "undefined") return []

  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    return parsed.filter(isUsableEntry).map((entry) => ({ id: entry.id, quantity: entry.quantity }))
  } catch {
    return []
  }
}

/**
 * Write the cart for `key`, removing the record entirely once the cart is
 * empty so a placed or cancelled order leaves nothing to resume.
 *
 * Storage is unavailable in privacy-restricted contexts and full in others;
 * in both cases the cart simply stays in memory as it did before.
 */
export function writeStoredCartEntries(key: string | null, entries: StoredCartEntry[]): void {
  if (!key || typeof window === "undefined") return

  try {
    if (entries.length === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify(entries))
  } catch {
    // A cart that cannot be persisted is still a working cart.
  }
}

/**
 * Rebuild cart lines from stored entries against the live branch catalogue.
 *
 * A product the branch no longer offers is dropped, and every surviving
 * quantity is put back through the caller's clamp so a saved amount that now
 * exceeds stock — or that no longer sits on the product's quantity step —
 * comes back as something the user can actually order.
 */
export function restoreCartItems<TProduct>(
  entries: StoredCartEntry[],
  productsById: Map<number, TProduct>,
  clampQuantity: (product: TProduct, quantity: number) => number,
): Array<TProduct & { quantity: number }> {
  const restored: Array<TProduct & { quantity: number }> = []

  for (const entry of entries) {
    const product = productsById.get(entry.id)
    if (!product) continue

    const quantity = clampQuantity(product, entry.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) continue

    restored.push({ ...product, quantity })
  }

  return restored
}

/** The durable projection of a cart line. */
export function toStoredCartEntries(
  items: ReadonlyArray<{ id: number; quantity: number }>,
): StoredCartEntry[] {
  return items.map((item) => ({ id: item.id, quantity: item.quantity }))
}

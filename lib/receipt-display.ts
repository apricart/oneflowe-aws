type ReceiptItem = {
  quantity?: number | string | null
}

type ReceiptSubCategory = {
  items?: ReceiptItem[] | null
}

type ReceiptCategory = {
  items?: ReceiptItem[] | null
  subCategories?: ReceiptSubCategory[] | null
}

export type ReceiptRefundItem = {
  productName: string
  quantity: number
  amount: number | null
}

export const toDisplayNameCase = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/\b[a-z]/g, (character) => character.toUpperCase())

export function getReceiptItemQuantity(items?: ReceiptCategory[] | null) {
  if (!Array.isArray(items)) return 0

  return items.reduce((total, category) => {
    const nestedItems = Array.isArray(category.subCategories)
      ? category.subCategories.flatMap((subCategory) => subCategory.items || [])
      : category.items || []

    return total + nestedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
  }, 0)
}

export function getReceiptNetTotal(receiptData: any, refundAmount: number) {
  const subtotal = Number(receiptData?.subtotal || 0)
  const tax = Number(receiptData?.tax || 0)
  const discount = Number(receiptData?.discount || 0)
  const deliveryCharges = Number(receiptData?.deliveryCharges || 0)

  return Math.max(0, subtotal + tax + deliveryCharges - discount - refundAmount)
}

export function aggregateReceiptRefundItems(items: ReceiptRefundItem[]) {
  const byProduct = new Map<string, ReceiptRefundItem>()

  for (const item of items) {
    const productName = item.productName || "Unknown"
    const existing = byProduct.get(productName)

    if (existing) {
      existing.quantity += Number(item.quantity || 0)
      existing.amount = existing.amount === null || item.amount === null
        ? null
        : existing.amount + Number(item.amount || 0)
    } else {
      byProduct.set(productName, {
        productName,
        quantity: Number(item.quantity || 0),
        amount: item.amount === null ? null : Number(item.amount || 0),
      })
    }
  }

  return Array.from(byProduct.values()).filter((item) => item.quantity > 0)
}

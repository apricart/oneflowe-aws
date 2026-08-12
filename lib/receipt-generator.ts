import { db } from "@/lib/db"
import { branches,categories,globalProducts,organizations } from "@/db/schema"
import { eq,inArray } from "drizzle-orm"
import { formatBranchAddress } from "@/lib/branch-address"
import { calculateLineCents } from "@/lib/quantity"

export interface ReceiptData {
    invoiceNumber: string
    date: string
    status: string
    buyerName: string
    buyerAddress: string
    buyerPhone?: string
    organizationName: string
    organizationContact?: string
    items: Array<{
        mainCategoryName: string
        subCategories: Array<{
            subCategoryName: string
            items: Array<{
                id: number
                description: string
                quantity: number
                rate: number
                tax: number
                total: number
                unit: string
            }>
            subtotal: number
        }>
        total: number
    }>
    subtotal: number
    discount: number
    tax: number
    deliveryCharges: number
    refund: number
    refundedItems?: Array<{ productName: string, quantity: number, amount: number }>
    totalAmount: number
}

/**
 * Generates receipt data for an order
 * @param params - Order details and items
 * @returns Complete receipt data structure
 */
export async function generateReceiptData(params: {
    orderId: number
    orderTid: string
    status: string
    organizationId: number
    branchId: number
    orderItemsData: Array<{
        globalProductId: number
        productName: string
        productCode: string | null
        quantity: number
        priceCents: number
        unit: string
    }>
    subtotalCents: number
    taxCents: number
    totalCents: number
    discountCents?: number
    deliveryChargesCents?: number
}): Promise<ReceiptData> {
    const {
        orderTid,
        organizationId,
        branchId,
        orderItemsData,
        subtotalCents,
        taxCents,
        totalCents,
        discountCents = 0,
        deliveryChargesCents = 0,
    } = params

    // Fetch organization and branch details
    const [[org], [branch]] = await Promise.all([
        db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1),
        db.select().from(branches).where(eq(branches.id, branchId)).limit(1)
    ])

    if (!org || !branch) {
        throw new Error("Organization or branch not found")
    }

    // Fetch product details with categories
    const globalProductIds = orderItemsData.map((item) => item.globalProductId)
    const products = await db
        .select({
            id: globalProducts.id,
            categoryId: globalProducts.categoryId,
            name: globalProducts.name,
        })
        .from(globalProducts)
        .where(inArray(globalProducts.id, globalProductIds))

    // Fetch all relevant categories (including parents)
    const directCategoryIds = products
        .map((p) => p.categoryId)
        .filter((id): id is number => id !== null)

    // Fetch direct categories
    const directCats = directCategoryIds.length > 0
        ? await db.select().from(categories).where(inArray(categories.id, directCategoryIds))
        : []

    // Fetch parent categories if they exist
    const parentCategoryIds = directCats
        .map(c => c.parentId)
        .filter((id): id is number => id !== null)

    const parentCats = parentCategoryIds.length > 0
        ? await db.select().from(categories).where(inArray(categories.id, parentCategoryIds))
        : []

    // Map categories for easy lookup
    const allCats = [...directCats, ...parentCats]
    const categoryMap = new Map(allCats.map(c => [c.id, c]))

    // Group items hierarchically
    const groupedItems = groupItemsHierarchically(
        orderItemsData,
        products,
        categoryMap
    )

    // Generate receipt data
    const receiptData: ReceiptData = {
        invoiceNumber: orderTid,
        date: new Date().toLocaleDateString("en-US", {
            month: "2-digit",
            day: "2-digit",
            year: "numeric",
        }),
        status: params.status,
        buyerName: branch.name,
        buyerAddress: formatBranchAddress(branch),
        organizationName: org.name,
        items: groupedItems,
        subtotal: subtotalCents / 100,
        discount: discountCents / 100,
        tax: taxCents / 100,
        deliveryCharges: deliveryChargesCents / 100,
        refund: 0,
        totalAmount: totalCents / 100,
    }

    return receiptData
}

/**
 * Groups order items by Main Category and then by Sub Category
 */
function groupItemsHierarchically(
    orderItemsData: Array<any>,
    productInfo: Array<any>,
    categoryMap: Map<number, any>
): any[] {
    const productToCat = new Map(productInfo.map(p => [p.id, p.categoryId]))

    // hierarchy: Main Category -> Sub Category -> Items
    const groups = new Map<string, Map<string, any[]>>()

    orderItemsData.forEach((item, idx) => {
        const catId = productToCat.get(item.globalProductId)
        const cat = catId ? categoryMap.get(catId) : null

        let subCatName = "General"
        let mainCatName = "General"

        if (cat) {
            if (cat.parentId) {
                const parent = categoryMap.get(cat.parentId)
                mainCatName = parent ? parent.name : cat.name
                subCatName = cat.name
            } else {
                mainCatName = cat.name
                subCatName = "" // No sub-category if it's a top-level leaf
            }
        }

        if (!groups.has(mainCatName)) groups.set(mainCatName, new Map())
        const subGroups = groups.get(mainCatName)!
        if (!subGroups.has(subCatName)) subGroups.set(subCatName, [])

        subGroups.get(subCatName)!.push({
            id: idx + 1,
            description: item.productName + (item.productCode ? ` (${item.productCode})` : ""),
            quantity: item.quantity,
            rate: item.priceCents / 100,
            tax: 0,
            total: calculateLineCents(item.priceCents, item.quantity) / 100,
            unit: item.unit,
        })
    })

    // Convert Map to Array structure
    const result: any[] = []
    groups.forEach((subGroups, mainName) => {
        const subCats: any[] = []
        let mainTotal = 0

        subGroups.forEach((items, subName) => {
            const subtotal = items.reduce((sum, i) => sum + i.total, 0)
            subCats.push({
                subCategoryName: subName,
                items,
                subtotal
            })
            mainTotal += subtotal
        })

        result.push({
            mainCategoryName: mainName,
            subCategories: subCats.toSorted((a, b) => a.subCategoryName.localeCompare(b.subCategoryName)),
            total: mainTotal
        })
    })

    return result.sort((a, b) => a.mainCategoryName.localeCompare(b.mainCategoryName))
}

/**
 * Updates receipt data with refund information
 */
export function updateReceiptWithRefund(
    receiptData: ReceiptData,
    refundAmountCents: number,
    refundedItems?: Array<{ productName: string, quantity: number, amount: number }>
): ReceiptData {
    // Merge existing refunded items with new ones if any
    const existingItems = receiptData.refundedItems || []
    const updatedRefundedItems = refundedItems
        ? [...existingItems, ...refundedItems]
        : existingItems

    return {
        ...receiptData,
        refund: (receiptData.refund || 0) + (refundAmountCents / 100),
        refundedItems: updatedRefundedItems.length > 0 ? updatedRefundedItems : undefined,
        totalAmount: receiptData.totalAmount - (refundAmountCents / 100),
    }
}

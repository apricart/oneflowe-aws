import { and, inArray, isNull } from 'drizzle-orm'

import { categories, globalProducts } from '@/db/schema'
import { closePool, db } from '@/lib/db-cli'

const SEED_BATCH = 'dummy-products-complete-v1'
const TARGET_PARENT_CATEGORY = 'Beverages'
const TARGET_SUBCATEGORY = 'Soda'
const PLACEHOLDER_IMAGE_URL = '/placeholder.jpg'

type DummyProduct = {
  productCode: string
  name: string
  description: string
  basePricePkr: number
  unit: string
  stockQuantity: number
  allowDecimalQuantity: boolean
}

const DUMMY_PRODUCTS: DummyProduct[] = [
  {
    productCode: 'DUMMY-PRD-001',
    name: 'Classic Cola 330ml Can',
    description: 'A crisp classic cola in a single-serve 330ml can, suitable for office lunches and events.',
    basePricePkr: 120,
    unit: 'can',
    stockQuantity: 240,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-002',
    name: 'Diet Cola 330ml Can',
    description: 'A zero-sugar cola in a 330ml can with the familiar full-bodied cola taste.',
    basePricePkr: 125,
    unit: 'can',
    stockQuantity: 180,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-003',
    name: 'Lemon Lime Soda 500ml Bottle',
    description: 'A refreshing lemon and lime carbonated drink in a resealable 500ml bottle.',
    basePricePkr: 160,
    unit: 'bottle',
    stockQuantity: 160,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-004',
    name: 'Orange Soda 500ml Bottle',
    description: 'A bright orange-flavoured fizzy drink supplied in a convenient 500ml bottle.',
    basePricePkr: 165,
    unit: 'bottle',
    stockQuantity: 145,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-005',
    name: 'Ginger Ale 300ml Can',
    description: 'A lightly spiced ginger ale with balanced sweetness in a compact 300ml can.',
    basePricePkr: 145,
    unit: 'can',
    stockQuantity: 132,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-006',
    name: 'Tonic Water 250ml Can',
    description: 'A clean, lightly bitter tonic water in a 250ml can for refreshments and mixers.',
    basePricePkr: 135,
    unit: 'can',
    stockQuantity: 120,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-007',
    name: 'Club Soda 500ml Bottle',
    description: 'Plain carbonated water with a crisp finish, packed in a resealable 500ml bottle.',
    basePricePkr: 110,
    unit: 'bottle',
    stockQuantity: 175,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-008',
    name: 'Root Beer 330ml Can',
    description: 'A smooth root beer with vanilla and botanical notes in a 330ml can.',
    basePricePkr: 180,
    unit: 'can',
    stockQuantity: 96,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-009',
    name: 'Cream Soda 330ml Can',
    description: 'A sweet vanilla-style cream soda in a chilled-ready 330ml can.',
    basePricePkr: 175,
    unit: 'can',
    stockQuantity: 108,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-010',
    name: 'Grape Soda 500ml Bottle',
    description: 'A fruity grape-flavoured carbonated drink supplied in a 500ml bottle.',
    basePricePkr: 170,
    unit: 'bottle',
    stockQuantity: 118,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-011',
    name: 'Peach Soda 500ml Bottle',
    description: 'A fragrant peach soda with a light sparkling finish in a 500ml bottle.',
    basePricePkr: 175,
    unit: 'bottle',
    stockQuantity: 104,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-012',
    name: 'Green Apple Soda 500ml Bottle',
    description: 'A tangy green apple fizzy drink in a resealable 500ml bottle.',
    basePricePkr: 170,
    unit: 'bottle',
    stockQuantity: 112,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-013',
    name: 'Mixed Berry Sparkling Soda 330ml Can',
    description: 'A sparkling mixed-berry soda combining strawberry, raspberry, and blueberry notes.',
    basePricePkr: 190,
    unit: 'can',
    stockQuantity: 88,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-014',
    name: 'Mango Fizzy Drink 500ml Bottle',
    description: 'A tropical mango-flavoured carbonated drink in a 500ml bottle.',
    basePricePkr: 180,
    unit: 'bottle',
    stockQuantity: 126,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-015',
    name: 'Pineapple Soda 500ml Bottle',
    description: 'A sweet and tangy pineapple soda supplied in a resealable 500ml bottle.',
    basePricePkr: 175,
    unit: 'bottle',
    stockQuantity: 98,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-016',
    name: 'Cola Family Bottle 1.5L',
    description: 'A 1.5 litre family-size bottle of classic cola for meetings and shared meals.',
    basePricePkr: 320,
    unit: 'bottle',
    stockQuantity: 72,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-017',
    name: 'Lemon Lime Family Bottle 1.5L',
    description: 'A 1.5 litre family-size lemon and lime soda for group refreshments.',
    basePricePkr: 330,
    unit: 'bottle',
    stockQuantity: 68,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-018',
    name: 'Orange Family Bottle 1.5L',
    description: 'A 1.5 litre family-size orange soda suitable for events and office gatherings.',
    basePricePkr: 340,
    unit: 'bottle',
    stockQuantity: 64,
    allowDecimalQuantity: false,
  },
  {
    productCode: 'DUMMY-PRD-019',
    name: 'Cola Fountain Syrup',
    description: 'Concentrated cola fountain syrup supplied by the litre for dispensing equipment.',
    basePricePkr: 850,
    unit: 'ltr',
    stockQuantity: 48.5,
    allowDecimalQuantity: true,
  },
  {
    productCode: 'DUMMY-PRD-020',
    name: 'Lemon Lime Fountain Syrup',
    description: 'Concentrated lemon and lime fountain syrup supplied by the litre for dispensers.',
    basePricePkr: 900,
    unit: 'ltr',
    stockQuantity: 36.75,
    allowDecimalQuantity: true,
  },
]

function hasSeedMarker(metadata: Record<string, unknown> | null) {
  return metadata?.seedBatch === SEED_BATCH
}

async function addDummyProducts() {
  const allCategories = await db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
    })
    .from(categories)

  const parentCategory = allCategories.find(
    (category) =>
      category.parentId === null &&
      category.name.toLocaleLowerCase() === TARGET_PARENT_CATEGORY.toLocaleLowerCase(),
  )
  const subcategory = allCategories.find(
    (category) =>
      category.parentId === parentCategory?.id &&
      category.name.toLocaleLowerCase() === TARGET_SUBCATEGORY.toLocaleLowerCase(),
  )

  if (!parentCategory || !subcategory) {
    throw new Error(
      `The required ${TARGET_PARENT_CATEGORY} > ${TARGET_SUBCATEGORY} category path does not exist.`,
    )
  }

  const productCodes = DUMMY_PRODUCTS.map((product) => product.productCode)
  const existingProducts = await db
    .select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      metadata: globalProducts.metadata,
    })
    .from(globalProducts)
    .where(
      and(
        inArray(globalProducts.productCode, productCodes),
        isNull(globalProducts.deletedAt),
      ),
    )

  const conflictingProducts = existingProducts.filter(
    (product) => !hasSeedMarker(product.metadata),
  )
  if (conflictingProducts.length > 0) {
    throw new Error(
      `Reserved dummy product codes are already in use: ${conflictingProducts
        .map((product) => product.productCode)
        .join(', ')}`,
    )
  }

  const existingByCode = new Map(
    existingProducts.map((product) => [product.productCode, product]),
  )
  let createdCount = 0
  let updatedCount = 0

  await db.transaction(async (tx) => {
    for (const product of DUMMY_PRODUCTS) {
      const values = {
        name: product.name,
        description: product.description,
        categoryId: subcategory.id,
        imageUrl: PLACEHOLDER_IMAGE_URL,
        basePrice: Math.round(product.basePricePkr * 100),
        unit: product.unit,
        status: 'active',
        stockQuantity: product.stockQuantity,
        allowDecimalQuantity: product.allowDecimalQuantity,
        quantityStep: 1,
        metadata: {
          parentCategoryId: parentCategory.id,
          seedBatch: SEED_BATCH,
          isDummyProduct: true,
        },
        discountType: null,
        discountValue: null,
        discountStartAt: null,
        discountEndAt: null,
        discountActive: false,
        updatedAt: new Date(),
      } as const
      const existingProduct = existingByCode.get(product.productCode)

      if (existingProduct) {
        await tx
          .update(globalProducts)
          .set(values)
          .where(inArray(globalProducts.id, [existingProduct.id]))
        updatedCount += 1
      } else {
        await tx.insert(globalProducts).values({
          productCode: product.productCode,
          ...values,
        })
        createdCount += 1
      }
    }
  })

  const savedProducts = await db
    .select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      description: globalProducts.description,
      categoryId: globalProducts.categoryId,
      basePrice: globalProducts.basePrice,
      unit: globalProducts.unit,
      stockQuantity: globalProducts.stockQuantity,
      allowDecimalQuantity: globalProducts.allowDecimalQuantity,
      quantityStep: globalProducts.quantityStep,
      status: globalProducts.status,
      imageUrl: globalProducts.imageUrl,
      discountType: globalProducts.discountType,
      discountValue: globalProducts.discountValue,
      discountStartAt: globalProducts.discountStartAt,
      discountEndAt: globalProducts.discountEndAt,
      discountActive: globalProducts.discountActive,
      metadata: globalProducts.metadata,
    })
    .from(globalProducts)
    .where(
      and(
        inArray(globalProducts.productCode, productCodes),
        isNull(globalProducts.deletedAt),
      ),
    )

  const savedByCode = new Map(
    savedProducts.map((product) => [product.productCode, product]),
  )
  const invalidProductCodes = DUMMY_PRODUCTS.flatMap((expected) => {
    const saved = savedByCode.get(expected.productCode)
    const isValid = Boolean(
      saved?.name === expected.name &&
      saved.description === expected.description &&
      saved.categoryId === subcategory.id &&
      saved.imageUrl === PLACEHOLDER_IMAGE_URL &&
      saved.basePrice === Math.round(expected.basePricePkr * 100) &&
      saved.unit === expected.unit &&
      Number(saved.stockQuantity) === expected.stockQuantity &&
      saved.allowDecimalQuantity === expected.allowDecimalQuantity &&
      Number(saved.quantityStep) === 1 &&
      saved.status === 'active' &&
      saved.discountType === null &&
      saved.discountValue === null &&
      saved.discountStartAt === null &&
      saved.discountEndAt === null &&
      saved.discountActive === false &&
      hasSeedMarker(saved.metadata) &&
      saved.metadata?.parentCategoryId === parentCategory.id &&
      saved.metadata?.isDummyProduct === true
    )

    return isValid ? [] : [expected.productCode]
  })

  if (
    savedProducts.length !== DUMMY_PRODUCTS.length ||
    invalidProductCodes.length > 0
  ) {
    throw new Error(
      `Dummy product verification failed after the database transaction${
        invalidProductCodes.length > 0
          ? `: ${invalidProductCodes.join(', ')}`
          : '.'
      }`,
    )
  }

  console.log(
    `Dummy product seed complete: ${createdCount} created, ${updatedCount} refreshed, ${savedProducts.length} verified.`,
  )
  console.table(
    savedProducts
      .toSorted((left, right) => left.productCode.localeCompare(right.productCode))
      .map((product) => ({
        id: product.id,
        code: product.productCode,
        name: product.name,
        pricePkr: product.basePrice / 100,
        stock: product.stockQuantity,
        unit: product.unit,
        status: product.status,
      })),
  )
}

addDummyProducts()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })

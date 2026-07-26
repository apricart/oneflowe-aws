import { z } from "zod"
import { MAX_BUSINESS_QUANTITY, isUniquePositiveIdList } from "@/lib/business-rules"
import {
  MAX_STORED_IMAGE_URL_LENGTH,
  normalizeSafeImageUrl,
} from "@/lib/security"

export const systemRoleSchema = z.enum([
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "ORDER_PORTAL",
])

export type SystemRole = z.infer<typeof systemRoleSchema>

const positiveId = z.coerce.number().int().positive()
const nullablePositiveId = z.union([positiveId, z.null()])
const nullableText = (max: number) => z.union([
  z.string().trim().max(max).transform((value) => value || null),
  z.null(),
])

const passwordSchema = z.string().min(12).max(128)
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/\d/, "Password must include a number")
  .regex(/[^a-zA-Z0-9]/, "Password must include a special character")

export const userCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  username: z.string().trim().min(1).max(255),
  password: passwordSchema,
  role: systemRoleSchema,
  organizationId: nullablePositiveId,
  branchId: nullablePositiveId,
  phone: nullableText(32).optional(),
  employeeId: nullableText(64).optional(),
  imprestHolder: nullableText(255).optional(),
  contactPerson: nullableText(255).optional(),
  location: nullableText(255).optional(),
  address: nullableText(2_000).optional(),
  mfaEnabled: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
}).strict()

export const userProfileUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(255).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  phone: nullableText(32).optional(),
  employeeId: nullableText(64).optional(),
  imprestHolder: nullableText(255).optional(),
  contactPerson: nullableText(255).optional(),
  location: nullableText(255).optional(),
  address: nullableText(2_000).optional(),
  password: passwordSchema.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one profile field is required",
})

export const userAccessUpdateSchema = z.object({
  role: systemRoleSchema.optional(),
  organizationId: nullablePositiveId.optional(),
  branchId: nullablePositiveId.optional(),
  isActive: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one access field is required",
})

export const branchCreateSchema = z.object({
  organizationId: positiveId,
  name: z.string().trim().min(2).max(100),
  province: z.string().trim().min(2).max(100),
  city: z.string().trim().min(2).max(100),
  address: z.string().trim().min(5).max(500),
  costCenterId: nullableText(128).optional(),
  status: z.enum(["active", "inactive"]).optional().default("active"),
}).strict()

export const branchUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  province: nullableText(100).optional(),
  city: nullableText(100).optional(),
  address: nullableText(500).optional(),
  costCenterId: nullableText(128).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
  groupId: nullablePositiveId.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one branch field is required",
})

export const supplierCreateSchema = z.object({
  organizationId: positiveId,
  branchId: positiveId,
  name: z.string().trim().min(1).max(255),
  address: nullableText(2_000).optional(),
  contact: nullableText(255).optional(),
  email: z.union([z.string().trim().email().max(255), z.literal(""), z.null()]).optional()
    .transform((value) => value || null),
  description: nullableText(2_000).optional(),
}).strict()

export const supplierUpdateSchema = supplierCreateSchema.omit({
  organizationId: true,
  branchId: true,
}).partial().strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one supplier field is required",
})

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_]+$/),
  status: z.enum(["active", "inactive", "suspended"]).optional().default("active"),
  budgetAllocationMode: z.enum(["money", "quantity"]).optional(),
  priceVisibility: z.object({
    hideBranchAdminPrices: z.boolean().optional(),
    hideOrderPortalPrices: z.boolean().optional(),
  }).strict().optional(),
}).strict()

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9_]+$/).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
  budgetAllocationMode: z.enum(["money", "quantity"]).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one organization field is required",
})

export const orderStatusUpdateSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "FULFILLED"]),
}).strict()

export const orderCreateSchema = z.object({
  items: z.array(z.object({
    organizationInventoryId: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.organizationInventoryId)),
    "Each product can only appear once in an order",
  ),
  organizationId: positiveId.optional(),
  branchId: positiveId.optional(),
  notes: z.string().trim().max(2_000).optional(),
}).strict()

export const rejectionSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict()

export const fulfillmentSchema = z.object({
  approvalToken: z.string().trim().min(1).max(256),
}).strict()

export const paymentStatusSchema = z.object({
  paymentStatus: z.enum(["PAID", "UNPAID"]),
}).strict()

export const fulfillmentStatusSchema = z.object({
  fulfillmentStatus: z.enum(["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]),
}).strict()

export const refundRequestSchema = z.object({
  items: z.array(z.object({
    id: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.id)),
    "Each order item can only appear once in a refund",
  ),
  reason: z.string().trim().max(2_000).optional(),
}).strict()

export const rolePermissionCreateSchema = z.object({
  roleId: positiveId,
  permissionKey: z.string().trim().min(1).max(128),
  allowed: z.boolean().optional().default(true),
}).strict()

export const rolePermissionReplaceSchema = z.object({
  roleId: positiveId,
  permissions: z.array(z.string().trim().min(1).max(128)).max(500),
}).strict()

export const employeeCredentialCreateSchema = z.object({
  email: z.string().trim().email().max(255),
  password: passwordSchema,
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  mfaEnabled: z.boolean().optional().default(false),
}).strict()

export const employeeCredentialUpdateSchema = z.object({
  id: positiveId,
  email: z.string().trim().email().max(255).optional(),
  password: passwordSchema.optional(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "id"), {
  message: "At least one credential field is required",
})

export const organizationSettingSchema = z.object({
  organizationId: z.number().int().positive(),
  key: z.string().trim().min(1).max(128),
  value: z.unknown(),
}).strict()

export const reportScheduleSchema = z.object({
  id: positiveId.optional(),
  reportName: z.string().trim().min(1).max(128),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  format: z.enum(["pdf", "csv", "excel"]),
  emails: z.array(z.string().trim().email().max(255)).min(1).max(20),
  enabled: z.boolean().optional().default(true),
}).strict()

export const moneyBudgetUpdateSchema = z.object({
  branchId: positiveId,
  amountAllocatedCents: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER / 2),
  type: z.enum(["addon", "monthly"]).optional().default("addon"),
  setAbsolute: z.boolean().optional(),
  resetAddons: z.boolean().optional(),
  reason: z.string().trim().max(1_000).optional(),
}).strict()

export const quantityBudgetResetSchema = z.object({
  organizationId: positiveId.optional(),
  branchIds: z.array(positiveId).max(1_000).optional(),
  groupIds: z.array(positiveId).max(1_000).optional(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
}).strict()

export const quantityBudgetAllocationSchema = z.object({
  branchId: positiveId,
  type: z.enum(["monthly", "addon"]).optional().default("addon"),
  items: z.array(z.object({
    branchInventoryId: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(100),
  reason: z.string().trim().max(1_000).optional(),
}).strict()

const nullableImageUrl = z.union([
  z.string()
    .trim()
    .max(MAX_STORED_IMAGE_URL_LENGTH)
    .refine(
      (value) => value === "" || normalizeSafeImageUrl(value) !== null,
      "Image URL must be a same-origin path, HTTPS URL, or supported raster data URL",
    )
    .transform((value) => normalizeSafeImageUrl(value)),
  z.null(),
])
const nullableLongText = z.union([z.string().trim().max(10_000), z.null()])

export const globalProductUpdateSchema = z.object({
  productCode: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableLongText.optional(),
  categoryId: nullablePositiveId.optional(),
  imageUrl: nullableImageUrl.optional(),
  basePrice: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  unit: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one product field is required",
})

const globalProductAdminFields = {
  productCode: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(255),
  description: nullableLongText.optional(),
  categoryId: nullablePositiveId.optional(),
  subcategoryId: z.union([z.string(), z.number(), z.null()]).optional(),
  imageUrl: nullableImageUrl.optional(),
  basePrice: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER / 100),
  unit: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  stockQuantity: z.coerce.number().finite().nonnegative().optional(),
  allowDecimalQuantity: z.boolean().optional(),
  quantityStep: z.coerce.number().finite().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  discountType: z.union([z.enum(["percent", "flat"]), z.null()]).optional(),
  discountValue: z.union([z.coerce.number().int().nonnegative(), z.null()]).optional(),
  discountStartAt: z.union([z.string().trim().max(64), z.null()]).optional(),
  discountEndAt: z.union([z.string().trim().max(64), z.null()]).optional(),
  discountActive: z.boolean().optional(),
}

const globalProductAdminBaseSchema = z.object(globalProductAdminFields)
export const globalProductAdminCreateSchema = globalProductAdminBaseSchema.strict()
export const globalProductAdminUpdateSchema = globalProductAdminBaseSchema
  .partial()
  .extend({ id: positiveId })
  .strict()

export const organizationProductUpdateSchema = z.object({
  organizationProductId: positiveId,
  isEnabled: z.boolean().optional(),
  customName: nullableText(255).optional(),
  customDescription: nullableLongText.optional(),
  customPrice: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  customImageUrl: nullableImageUrl.optional(),
  tags: z.array(z.string().trim().max(100)).max(100).optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "organizationProductId"), {
  message: "At least one organization product field is required",
})

export const branchProductUpdateSchema = z.object({
  branchProductId: positiveId,
  isAvailable: z.boolean().optional(),
  customNotes: nullableLongText.optional(),
}).strict().refine((input) => Object.keys(input).some((key) => key !== "branchProductId"), {
  message: "At least one branch product field is required",
})

export const refundCancelSchema = z.object({
  action: z.literal("cancel"),
}).strict()

export const adminRefundProcessSchema = z.object({
  orderId: positiveId,
  items: z.array(z.object({
    itemId: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.itemId)),
    "Each order item can only appear once in a refund",
  ),
  reason: z.string().trim().max(500).optional(),
  refundRequestId: positiveId.optional(),
}).strict()

export const branchAssignmentToggleSchema = z.object({
  organizationInventoryId: positiveId,
  organizationId: positiveId,
  isActive: z.boolean(),
  groupIds: z.union([
    z.literal("all"),
    z.array(positiveId).min(1).max(1_000),
  ]),
}).strict()

export const groupCreateSchema = z.object({
  organizationId: positiveId,
  name: z.string().trim().min(1).max(255),
  description: nullableLongText.optional(),
}).strict()

export const groupUpdateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: nullableLongText.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one group field is required",
})

export const groupBranchesUpdateSchema = z.object({
  branchIds: z.array(positiveId).max(10_000),
  newlyAddedBranchIds: z.array(positiveId).max(10_000).optional(),
}).strict()

export function validationMessage(error: z.ZodError): string {
  const unknownKeys = error.issues
    .filter((issue) => issue.code === "unrecognized_keys")
    .flatMap((issue) => "keys" in issue ? issue.keys : [])

  if (unknownKeys.length > 0) {
    return `Unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
  }

  return error.issues[0]?.message || "Invalid request body"
}

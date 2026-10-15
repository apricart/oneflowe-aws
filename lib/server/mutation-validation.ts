import { z } from "zod"
import { ORDER_APPROVER_ROLES } from "@/lib/order-approver-role"
import { MAX_BUSINESS_QUANTITY, isUniquePositiveIdList } from "@/lib/business-rules"
import { ORDER_CORRECTION_TEXT_MAX_LENGTH } from "@/lib/order-correction"
import {
  DELIVERY_ADDRESS_DECISIONS,
  MAX_DELIVERY_ADDRESS_CITY,
  MAX_DELIVERY_ADDRESS_CONTACT_PERSON,
  MAX_DELIVERY_ADDRESS_CONTACT_PHONE,
  MAX_DELIVERY_ADDRESS_LABEL,
  MAX_DELIVERY_ADDRESS_LINE,
  MAX_DELIVERY_ADDRESS_PROVINCE,
  MAX_DELIVERY_ADDRESS_REASON,
} from "@/lib/delivery-address"
import {
  MAX_GROUP_REFUND_REASON_LENGTH,
  MAX_ITEMS_PER_REFUNDED_ORDER,
  MAX_ORDERS_PER_GROUP_REFUND,
} from "@/lib/server/group-refund-rules"
import { PROPAGATION_MODES } from "@/lib/group-price-propagation"
import { BRANCH_REGIONS } from "@/lib/branch-region"
import {
  EMAIL_DOMAIN_MAX_LENGTH,
  emailDomainError,
  normalizeEmailDomain,
} from "@/lib/organization-email-domain"
import {
  JOINABLE_ROLES,
  JOIN_CODE_MAX_LENGTH,
  JOIN_DECISIONS,
  joinCodeError,
  normalizeJoinCode,
} from "@/lib/organization-join"
import { MAX_PRICE_CENTS } from "@/lib/price-ladder"
import { CANCELLATION_REASON_MAX_LENGTH, INTAKE_CHANNELS, INTAKE_REFERENCE_MAX_LENGTH } from "@/lib/order-desk-access"
import { GROUP_ORDER_CANCEL_REASON_MAX_LENGTH } from "@/lib/group-order-cancel"
import { APRICART_EXECUTIVE_ASSIGNMENT_MAX } from "@/lib/apricart-executive-access"
import { WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION, WAREHOUSE_CITY_MAX_LENGTH } from "@/lib/warehouse-access"
import { MAX_ALLOWLIST_ENTRIES } from "@/lib/security/ip-allowlist"
import { MAX_APPROVAL_LEVELS, approvalLevelsError } from "@/lib/order-approval-levels"
import {
  CRC_MAX_LENGTH,
  DEPARTMENTS,
  DEPARTMENT_SIGNUP_FORM_VERSION,
  SIGNUP_ADDRESS_MAX_LENGTH,
  SIGNUP_APPROVER_EMAIL_MAX_LENGTH,
  SIGNUP_DESIGNATION_MAX_LENGTH,
  SIGNUP_EMPLOYEE_ID_MAX_LENGTH,
  SIGNUP_FULL_NAME_MAX_LENGTH,
  SIGNUP_IP_EXTENSION_PATTERN,
  SIGNUP_MAX_ADDRESSES,
  SIGNUP_MAX_BRANCHES,
  SIGNUP_PHONE_PATTERN,
} from "@/lib/join-department-signup"
import {
  DEFAULT_ORDERING_BLOCK_THRESHOLD,
  ORDERING_BLOCK_THRESHOLD_MAX,
  ORDERING_BLOCK_THRESHOLD_MIN,
} from "@/lib/ordering-block-threshold"
import {
  MAX_PO_NUMBER_LENGTH,
  PO_NUMBER_MESSAGE,
  PO_NUMBER_PATTERN,
} from "@/lib/purchase-order"
import {
  MAX_STORED_IMAGE_URL_LENGTH,
  normalizeSafeImageUrl,
} from "@/lib/security"
import {
  SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_PRIORITIES,
  SUPPORT_SELECTABLE_CATEGORIES,
  SUPPORT_STATUSES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  isProductRequiredForCategory,
} from "@/lib/support-thread"

export const systemRoleSchema = z.enum([
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  // Read-only dashboard account. Holds no write permission anywhere and is
  // admitted only to the analytics reads its dashboard needs
  // (`lib/viewer-access.ts`).
  "VIEWER",
  // Apricart's internal order entry. No organization of its own; its reach is
  // the managed organizations Super Admin assigns it (`lib/order-desk-access.ts`).
  "ORDER_DESK",
  // Apricart's management: reads the delivery dashboard across every
  // organization and nothing else (`lib/apricart-executive-access.ts`).
  "APRICART_EXECUTIVE",
  // Apricart's warehouse: picks, dispatches and delivers the approved orders
  // of the branches assigned to it (`lib/warehouse-access.ts`).
  "WAREHOUSE",
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

// Bounded so a single request can never fan out into an unbounded write set.
export const MAX_ASSIGNED_SCOPE_IDS = 500

// A group order fans out into one order per branch, so the branch count bounds
// the number of transactions a single submission can open.
export const MAX_GROUP_ORDER_BRANCHES = 100

const assignedIdList = z.array(positiveId)
  .max(MAX_ASSIGNED_SCOPE_IDS)
  .refine(isUniquePositiveIdList, { message: "Duplicate ids are not allowed" })

/** A level number (1 = highest) or null for none. A JSON integer only. */
const userOrderApprovalLevel = z.number().int().min(1).max(MAX_APPROVAL_LEVELS).nullable()

/** `PUT /api/v1/users/[id]/approval-level`. */
export const userApprovalLevelUpdateSchema = z.object({
  level: userOrderApprovalLevel,
}).strict()

export const userCreateSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().pipe(z.email().max(255)),
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
  budgetAllocationEnabled: z.boolean().optional(),
  // GROUP_ORDER_PORTAL only. Ignored (and rejected when non-empty) for every
  // other role, so existing single-branch roles are unaffected.
  groupIds: assignedIdList.optional().default([]),
  branchIds: assignedIdList.optional().default([]),
  // The organization's order approval level this user holds, or null. Whether
  // the role and organization admit one is checked inside the creation
  // transaction (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
  orderApprovalLevel: userOrderApprovalLevel.optional().default(null),
}).strict().refine((input) => input.role === "GROUP_USER" || input.budgetAllocationEnabled === undefined, {
  message: "Budget allocation access applies only to Group Users",
  path: ["budgetAllocationEnabled"],
})

/**
 * Replaces the full group/branch scope of a GROUP_ORDER_PORTAL user. Sending
 * both lists empty is rejected by the route, not here, so the message can name
 * the role.
 */
export const userScopeUpdateSchema = z.object({
  groupIds: assignedIdList.optional().default([]),
  branchIds: assignedIdList.optional().default([]),
}).strict()

/**
 * Replaces an Order Desk user's whole reach: organizations granted whole, and
 * single branches. Both bounded; sending both empty withdraws all reach.
 */
export const orderDeskAssignmentsUpdateSchema = z.object({
  organizationIds: assignedIdList,
  branchIds: assignedIdList,
}).strict()

/**
 * Replaces the organizations an Apricart Executive approves Order Desk orders
 * for. Sending an empty list withdraws every approval reach.
 */
export const apricartExecutiveAssignmentsUpdateSchema = z.object({
  organizationIds: z.array(positiveId)
    .max(APRICART_EXECUTIVE_ASSIGNMENT_MAX)
    .refine(isUniquePositiveIdList, { message: "Duplicate ids are not allowed" }),
}).strict()

/**
 * An Apricart Executive approving an Order Desk order: the order's `updatedAt`
 * as it was listed to them, so an edit since then makes the approval a
 * conflict rather than approving lines they did not see.
 */
export const executiveOrderApprovalSchema = z.object({
  expectedUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
}).strict()

export const userProfileUpdateSchema = z.object({
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().pipe(z.email().max(255)).optional(),
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
  budgetAllocationEnabled: z.boolean().optional(),
  // GROUP_ORDER_PORTAL only. Omitting a list leaves it unchanged; sending one
  // replaces it wholesale.
  groupIds: assignedIdList.optional(),
  branchIds: assignedIdList.optional(),
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
  // Delivery region; Super Admin only, enforced by the route.
  region: z.union([z.enum(BRANCH_REGIONS), z.null()]).optional(),
}).strict()

export const branchUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  province: nullableText(100).optional(),
  city: nullableText(100).optional(),
  address: nullableText(500).optional(),
  costCenterId: nullableText(128).optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
  groupId: nullablePositiveId.optional(),
  // Delivery region, or null for Unknown; Super Admin only, enforced by the route.
  region: z.union([z.enum(BRANCH_REGIONS), z.null()]).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one branch field is required",
})

export const supplierCreateSchema = z.object({
  organizationId: positiveId,
  branchId: positiveId,
  name: z.string().trim().min(1).max(255),
  address: nullableText(2_000).optional(),
  contact: nullableText(255).optional(),
  email: z.union([z.string().trim().pipe(z.email().max(255)), z.literal(""), z.null()]).optional()
    .transform((value) => value || null),
  description: nullableText(2_000).optional(),
}).strict()

export const supplierUpdateSchema = supplierCreateSchema.omit({
  organizationId: true,
  branchId: true,
}).partial().strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one supplier field is required",
})

/**
 * Shape only. The address text itself is parsed by the shared allowlist parser
 * so the UI, this schema, and the login matcher can never disagree about what a
 * given entry means.
 */
export const privateNetworkLoginSchema = z.object({
  enabled: z.boolean(),
  entries: z.array(z.object({
    value: z.string().trim().min(1).max(64),
    label: nullableText(120).optional(),
  }).strict()).max(MAX_ALLOWLIST_ENTRIES),
}).strict().refine((input) => !input.enabled || input.entries.length > 0, {
  message: "Add at least one IP address before enabling private network login",
  path: ["entries"],
})

/**
 * An organization's order approval levels, as Super Admin sends them on Create
 * Organization and on PUT /api/v1/organizations/[id]/approval-levels.
 *
 * `levels` is ordered: the first entry is Level 1. Amounts are JSON integers in
 * cents — a string is refused, not coerced. Omitting `levels` leaves the stored
 * ones alone, which is what a save with the feature switched off sends; it is
 * required when switching on. Every rule about the list is
 * `approvalLevelsError` (lib/order-approval-levels.ts), shared with the form.
 */
export const orderApprovalLevelsSchema = z.object({
  enabled: z.boolean(),
  levels: z.array(z.object({
    maxAmountCents: z.number().int(),
  }).strict()).max(MAX_APPROVAL_LEVELS).optional(),
}).strict().superRefine((input, context) => {
  if (input.enabled && input.levels === undefined) {
    context.addIssue({ code: "custom", path: ["levels"], message: "Send the approval levels when turning them on" })
    return
  }
  const problem = approvalLevelsError(input.enabled, (input.levels ?? []).map((level) => level.maxAmountCents))
  if (problem) context.addIssue({ code: "custom", path: ["levels"], message: problem })
})

// Optional tax identifier. An empty string is accepted and normalized to null
// by the route so an operator can clear a wrong value without extra API shape.
/** A tax identifier as printed on an invoice: letters, digits and hyphens. */
const organizationTaxIdentifier = (label: string) => z
  .string()
  .trim()
  .max(32)
  .regex(/^[A-Za-z0-9-]*$/, `${label} may contain only letters, numbers, and hyphens`)

const organizationNtnNumber = organizationTaxIdentifier("NTN number")
const organizationStrnNumber = organizationTaxIdentifier("STRN number")

/**
 * The domain self-service applicants must use. Normalised through the single
 * `normalizeEmailDomain` and judged by `emailDomainError`, so the dialog, this
 * schema and `organizations_email_domain_shape_ck` agree. A blank value means
 * "no domain" and becomes null; bounded before normalisation so an oversized
 * string is refused without being processed.
 */
const organizationEmailDomain = z
  .string()
  .max(EMAIL_DOMAIN_MAX_LENGTH + 16)
  .transform(normalizeEmailDomain)
  .superRefine((domain, context) => {
    const problem = domain === "" ? null : emailDomainError(domain)
    if (problem) context.addIssue({ code: "custom", message: problem })
  })
  .transform((domain) => domain || null)

// How many unpaid invoices / unacknowledged deliveries stop a branch ordering.
// A JSON number only: "3" is refused, not coerced (lib/ordering-block-threshold.ts).
const organizationOrderingBlockThreshold = z
  .number()
  .int()
  .min(ORDERING_BLOCK_THRESHOLD_MIN)
  .max(ORDERING_BLOCK_THRESHOLD_MAX)

export const organizationCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  code: z.string().trim().min(2).max(20).regex(/^\w+$/),
  ntnNumber: organizationNtnNumber.optional(),
  strnNumber: organizationStrnNumber.optional(),
  emailDomain: organizationEmailDomain.optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional().default("active"),
  orderApproverRole: z.enum(ORDER_APPROVER_ROLES).optional().default("BRANCH_ADMIN"),
  orderApprovalRequired: z.boolean().optional().default(true),
  blockOrderingOnUnpaidInvoices: z.boolean().optional().default(false),
  blockOrderingOnUnacknowledgedDeliveries: z.boolean().optional().default(false),
  unpaidInvoiceBlockThreshold: organizationOrderingBlockThreshold.optional().default(DEFAULT_ORDERING_BLOCK_THRESHOLD),
  unacknowledgedDeliveryBlockThreshold: organizationOrderingBlockThreshold.optional().default(DEFAULT_ORDERING_BLOCK_THRESHOLD),
  // Off unless asked for: an organization created in the application starts
  // without budget allocation (DEFAULT_ORGANIZATION_BUDGETS_ENABLED).
  budgetsEnabled: z.boolean().optional().default(false),
  // Whether Apricart's Order Desk keys in this customer's orders. Off unless
  // asked for (lib/order-desk-access.ts).
  managedOrdering: z.boolean().optional().default(false),
  budgetAllocationMode: z.enum(["money", "quantity"]).optional(),
  priceVisibility: z.object({
    hideBranchAdminPrices: z.boolean().optional(),
    hideOrderPortalPrices: z.boolean().optional(),
  }).strict().optional(),
  privateNetworkLogin: privateNetworkLoginSchema.optional(),
  // Absent means off with no levels (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
  orderApprovalLevels: orderApprovalLevelsSchema.optional(),
}).strict()

export const organizationUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  code: z.string().trim().min(2).max(20).regex(/^\w+$/).optional(),
  ntnNumber: organizationNtnNumber.nullable().optional(),
  strnNumber: organizationStrnNumber.nullable().optional(),
  // `null` or a blank string clears the domain, which closes self-service
  // joining for the organization.
  emailDomain: organizationEmailDomain.nullable().optional(),
  status: z.enum(["active", "inactive", "suspended"]).optional(),
  orderApproverRole: z.enum(ORDER_APPROVER_ROLES).optional(),
  orderApprovalRequired: z.boolean().optional(),
  blockOrderingOnUnpaidInvoices: z.boolean().optional(),
  blockOrderingOnUnacknowledgedDeliveries: z.boolean().optional(),
  unpaidInvoiceBlockThreshold: organizationOrderingBlockThreshold.optional(),
  unacknowledgedDeliveryBlockThreshold: organizationOrderingBlockThreshold.optional(),
  budgetsEnabled: z.boolean().optional(),
  managedOrdering: z.boolean().optional(),
  budgetAllocationMode: z.enum(["money", "quantity"]).optional(),
}).strict().refine((input) => Object.keys(input).length > 0, {
  message: "At least one organization field is required",
})

export const orderStatusUpdateSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "FULFILLED"]),
}).strict()

/**
 * The buyer's own purchase order reference, printed as "P.O.#" on the invoice.
 * The alphabet and width come from `lib/purchase-order`, which the order forms
 * use as well, so nothing a portal accepts is refused here and nothing this
 * refuses can be typed there.
 *
 * An empty or blank value means "no purchase order", which is the normal case,
 * so it is normalised to `undefined` rather than refused.
 */
const purchaseOrderNumberValue = z.string()
  .trim()
  .max(MAX_PO_NUMBER_LENGTH, `Purchase order number must not exceed ${MAX_PO_NUMBER_LENGTH} characters`)
  .regex(PO_NUMBER_PATTERN, PO_NUMBER_MESSAGE)

export const optionalPurchaseOrderNumber = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  purchaseOrderNumberValue.optional(),
)

/**
 * The same reference on an edit, where an empty value is a real instruction:
 * it clears a purchase order recorded earlier. Normalised to `null` so the
 * route can tell "clear it" apart from "leave it alone" (`undefined`).
 */
const clearablePurchaseOrderNumber = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([purchaseOrderNumberValue, z.literal(""), z.null()]),
).transform((value) => value || null)

const orderMutationItemsSchema = z.array(z.object({
    organizationInventoryId: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.organizationInventoryId)),
    "Each product can only appear once in an order",
  )

export const orderCreateSchema = z.object({
  items: orderMutationItemsSchema,
  organizationId: positiveId.optional(),
  branchId: positiveId.optional(),
  notes: z.string().trim().max(2_000).optional(),
  poNumber: optionalPurchaseOrderNumber,
  /**
   * An approved delivery address for this order's branch, when the requester
   * wants the goods somewhere other than the branch's own address.
   *
   * Optional, and omitting it is the default everywhere: absent means "the
   * branch's own address", exactly as every order placed before delivery
   * addresses existed. The id is not trusted here — the route re-reads it
   * inside the creation transaction against the tenant, the branch and
   * `status = 'approved'`.
   */
  deliveryAddressId: positiveId.optional(),
  /**
   * Where an Order Desk order came from. Both are required on a desk order and
   * refused on any other (`orderIntakeError` in `lib/order-desk-access.ts`), so
   * the shape here only bounds them.
   */
  intakeChannel: z.enum(INTAKE_CHANNELS).optional(),
  intakeReference: z.string().trim().min(1).max(INTAKE_REFERENCE_MAX_LENGTH).optional(),
  /** The key the upload route returned for the customer's screenshot. Optional. */
  intakeAttachmentKey: z.string().max(128).optional(),
}).strict()

/** An Order Desk edit of an Active order before delivery: its lines, notes and PO number. */
export const orderDeskEditSchema = z.object({
  items: orderMutationItemsSchema,
  notes: z.string().trim().max(2_000).optional(),
  poNumber: clearablePurchaseOrderNumber.optional(),
}).strict()

/** Why an Order Desk order is being withdrawn. Required, so the trail says. */
export const orderDeskCancelSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(CANCELLATION_REASON_MAX_LENGTH),
}).strict()

/** A group requester withdrawing a pending group order (`plans/OF-GROUP-cancel-pending-group-orders.md`). */
export const groupOrderCancelSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(GROUP_ORDER_CANCEL_REASON_MAX_LENGTH),
}).strict()

export const orderUpdateSchema = z.object({
  items: orderMutationItemsSchema,
  notes: z.string().trim().max(2_000).optional(),
  poNumber: clearablePurchaseOrderNumber.optional(),
  /**
   * The same choice on an edit, where `null` is a real instruction: it sends
   * the order back to the branch's own address. `undefined` leaves whatever
   * the order already carries alone — the same distinction
   * `clearablePurchaseOrderNumber` draws.
   */
  deliveryAddressId: nullablePositiveId.optional(),
}).strict()

export const rejectionSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
}).strict()

/** An approver sending a pending order back to its requesters. */
export const orderCorrectionRequestSchema = z.object({
  comment: z.string().trim().min(1, "A comment saying what to correct is required")
    .max(ORDER_CORRECTION_TEXT_MAX_LENGTH),
}).strict()

/**
 * A requester sending a corrected order back for approval. The note is
 * optional — the correction may be the edit itself — and an all-blank note is
 * recorded as no note.
 */
export const orderResubmissionSchema = z.object({
  note: z.string().trim().max(ORDER_CORRECTION_TEXT_MAX_LENGTH).optional(),
}).strict()

export const fulfillmentSchema = z.object({
  approvalToken: z.string().trim().min(1).max(256),
}).strict()

export const paymentStatusSchema = z.object({
  paymentStatus: z.enum(["PAID", "UNPAID"]),
}).strict()

export const fulfillmentStatusSchema = z.object({
  fulfillmentStatus: z.enum(["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]),
  // The uploaded delivery challan: required to mark an order delivered, and
  // refused for any other stage (plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md).
  deliveryChallanId: positiveId.optional(),
}).strict().superRefine((input, context) => {
  if (input.fulfillmentStatus === "DELIVERED" && input.deliveryChallanId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["deliveryChallanId"],
      message: "Upload the delivery challan to mark this order delivered",
    })
  }
  if (input.fulfillmentStatus !== "DELIVERED" && input.deliveryChallanId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["deliveryChallanId"],
      message: "A delivery challan is attached only when the order is marked delivered",
    })
  }
})

/**
 * The warehouse moving an order's delivery one stage forward. Unlike Super
 * Admin's progress body, a delivery challan is **optional** when marking an
 * order delivered (plans/OF-WAREHOUSE-warehouse-fulfilment-role.md), and still
 * refused at any other stage.
 */
export const warehouseProgressSchema = z.object({
  fulfillmentStatus: z.enum(["IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]),
  deliveryChallanId: positiveId.optional(),
}).strict().superRefine((input, context) => {
  if (input.fulfillmentStatus !== "DELIVERED" && input.deliveryChallanId !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["deliveryChallanId"],
      message: "A delivery challan is attached only when the order is marked delivered",
    })
  }
})

/** The warehouse attaching a challan to a delivered order that has none. */
export const warehouseChallanAttachSchema = z.object({
  deliveryChallanId: positiveId,
}).strict()

/**
 * Replaces the branches one warehouse user serves **in one organization**.
 * Sending an empty list withdraws that organization's branches only; the
 * user's branches in other organizations are untouched.
 */
export const warehouseBranchAssignmentsUpdateSchema = z.object({
  organizationId: positiveId,
  branchIds: z.array(positiveId)
    .max(WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION)
    .refine(isUniquePositiveIdList, { message: "Duplicate ids are not allowed" }),
}).strict()

/**
 * Assigns or withdraws one whole city for one warehouse user. The city is
 * matched by its normalised key in SQL, so any spelling of it will do; one
 * city per request keeps the body tiny however many branches it spans.
 * See plans/OF-WAREHOUSE-city-assignments.md.
 */
export const warehouseCityAssignmentUpdateSchema = z.object({
  city: z.string().trim().min(1).max(WAREHOUSE_CITY_MAX_LENGTH),
  assigned: z.boolean(),
}).strict()

/** Replacing a delivered order's challan with another uploaded one. */
export const deliveryChallanReplaceSchema = z.object({
  deliveryChallanId: positiveId,
}).strict()

export const refundRequestSchema = z.object({
  items: z.array(z.object({
    id: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).min(1).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.id)),
    "Each order item can only appear once in a refund",
  ),
  reason: z.string()
    .trim()
    .min(1, "Refund reason is required")
    .max(2_000, "Refund reason must not exceed 2000 characters"),
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
  email: z.string().trim().pipe(z.email().max(255)),
  password: passwordSchema,
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  mfaEnabled: z.boolean().optional().default(false),
}).strict()

export const employeeCredentialUpdateSchema = z.object({
  id: positiveId,
  email: z.string().trim().pipe(z.email().max(255)).optional(),
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
  emails: z.array(z.string().trim().pipe(z.email().max(255))).min(1).max(20),
  enabled: z.boolean().optional().default(true),
}).strict()

export const moneyBudgetUpdateSchema = z.object({
  branchId: positiveId,
  amountAllocatedCents: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER / 2),
  type: z.enum(["addon", "monthly"]).optional().default("addon"),
  setAbsolute: z.boolean().optional(),
  resetAddons: z.boolean().optional(),
  reason: z.string().trim().max(1_000).optional(),
  // The day an add-on stops being available (YYYY-MM-DD, Asia/Karachi).
  // Required for any add-on that credits money; the route resolves and
  // bounds it through lib/budget-addon-expiry.ts.
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil must be a date in YYYY-MM-DD format").optional(),
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
  basePrice: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  // Sales-tax rate as a percentage (18 means 18%). Null clears any override so
  // the product follows its organization's rate. Prices are entered inclusive
  // of this rate, so it changes how a price is reported, never what is charged.
  taxRatePercent: z.union([z.number().nonnegative().max(100), z.null()]).optional(),
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
  basePrice: z.number().positive().max(Number.MAX_SAFE_INTEGER / 100),
  // Sales-tax rate as a percentage (18 means 18%). Null clears any override so
  // the product follows its organization's rate. Prices are entered inclusive
  // of this rate, so it changes how a price is reported, never what is charged.
  taxRatePercent: z.union([z.number().nonnegative().max(100), z.null()]).optional(),
  unit: z.string().trim().min(1).max(64).optional(),
  status: z.enum(["active", "inactive"]).optional(),
  stockQuantity: z.coerce.number().nonnegative().optional(),
  allowDecimalQuantity: z.boolean().optional(),
  quantityStep: z.coerce.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  discountType: z.union([z.enum(["percent", "flat"]), z.null()]).optional(),
  discountValue: z.union([z.coerce.number().int().nonnegative(), z.null()]).optional(),
  discountStartAt: z.union([z.string().trim().max(64), z.null()]).optional(),
  discountEndAt: z.union([z.string().trim().max(64), z.null()]).optional(),
  discountActive: z.boolean().optional(),
  // Acknowledgement that a legacy import's net price has been restated as a
  // gross one. Only read when activating a historical-only product; it records
  // a claim about the price being saved, and is never persisted as-is.
  confirmTaxInclusivePrice: z.boolean().optional(),
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

/**
 * Group-level product prices.
 *
 * `customPriceCents: null` clears the group override so the product falls back
 * to the organization price — the same "absence is inheritance" rule the
 * organization tier uses. Prices are integers in cents, never floats, so a
 * rounding error cannot reach the ledger. The ceiling is the range of the
 * `integer` column the value is stored in, which every other price column in
 * the schema also uses.
 */
export const MAX_GROUP_PRICE_UPDATES = 500

/**
 * What should happen to group prices when an organization price changes.
 *
 * Optional everywhere it is accepted, and absent means `none` — the behaviour
 * the application had before propagation existed, so no existing caller changes
 * meaning. `groupIds` is only read for `selected`; the server still rebuilds the
 * plan from its own rows, so this is a statement of intent, never a plan.
 */
export const groupPricePropagationSchema = z.object({
  mode: z.enum(PROPAGATION_MODES),
  groupIds: z.array(positiveId).max(MAX_ASSIGNED_SCOPE_IDS).optional(),
}).strict().refine(
  // `selected` has to say which groups. An empty list is allowed and means
  // "hold every group where it is", which the planner handles explicitly.
  (input) => input.mode !== "selected" || Array.isArray(input.groupIds),
  { message: "Selecting specific groups requires a groupIds list" },
)

export const groupPricesUpdateSchema = z.object({
  prices: z.array(z.object({
    organizationInventoryId: positiveId,
    customPriceCents: z.union([
      z.number().int().nonnegative().max(MAX_PRICE_CENTS),
      z.null(),
    ]),
  }).strict())
    .min(1, "At least one price is required")
    .max(MAX_GROUP_PRICE_UPDATES)
    .refine(
      (prices) => isUniquePositiveIdList(prices.map((price) => price.organizationInventoryId)),
      { message: "Each product can only appear once in a price update" },
    ),
}).strict()

/**
 * Group Order Portal submissions.
 *
 * One entry is one saved step of the wizard: the branches it applies to and the
 * items chosen for them. The server merges the entries per branch and creates
 * one ordinary order per branch, so the bounds here cap how much work a single
 * request can fan out into.
 */
const groupOrderEntrySchema = z.object({
  branchIds: z.array(positiveId)
    .min(1, "Select at least one branch for every step")
    .max(MAX_GROUP_ORDER_BRANCHES)
    .refine(isUniquePositiveIdList, { message: "Duplicate branches are not allowed" }),
  items: orderMutationItemsSchema,
}).strict()

export const MAX_GROUP_ORDER_ENTRIES = 50

export const groupOrderCreateSchema = z.object({
  // null is the "branches without a group" bucket, which is a real selection.
  groupId: z.union([positiveId, z.null()]),
  entries: z.array(groupOrderEntrySchema).min(1).max(MAX_GROUP_ORDER_ENTRIES),
  notes: z.string().trim().max(2_000).optional(),
  poNumber: optionalPurchaseOrderNumber,
}).strict()

/**
 * Group Order Portal refund requests.
 *
 * One submission covers many branch orders under a single group order, so the
 * payload is a list of orders each carrying its own selected lines. It is only
 * a *request*: every order id, every line id, and every quantity is
 * re-authorized and re-priced against the caller's own group order before
 * anything is written, so a forged id comes back as a per-branch "skipped"
 * result rather than a refund.
 *
 * The reason is capped at the width of `refunds.reason` so a long note is
 * refused with a clear message instead of failing at the database.
 */
const groupRefundOrderSchema = z.object({
  orderId: positiveId,
  items: z.array(z.object({
    id: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict())
    .min(1, "Select at least one item for every branch order")
    .max(MAX_ITEMS_PER_REFUNDED_ORDER)
    .refine(
      (items) => isUniquePositiveIdList(items.map((item) => item.id)),
      "Each order item can only appear once in a refund",
    ),
}).strict()

export const groupRefundRequestSchema = z.object({
  groupOrderId: positiveId,
  orders: z.array(groupRefundOrderSchema)
    .min(1, "Select at least one branch order to refund")
    .max(MAX_ORDERS_PER_GROUP_REFUND)
    .refine(
      (orders) => isUniquePositiveIdList(orders.map((order) => order.orderId)),
      "Each branch order can only appear once in a refund request",
    ),
  reason: z.string()
    .trim()
    .min(1, "Refund reason is required")
    .max(
      MAX_GROUP_REFUND_REASON_LENGTH,
      `Refund reason must not exceed ${MAX_GROUP_REFUND_REASON_LENGTH} characters`,
    ),
}).strict()

/**
 * Bounds one bulk approve/reject request. Each order is decided in its own
 * transaction, so this caps how many transactions a single call may open.
 */
export const MAX_BULK_DECISION_ORDERS = 100

/**
 * A GROUP_USER deciding one order or a whole group order in a single request.
 *
 * The ids are only a *request*; every one of them is re-authorized individually
 * against the caller's live branch scope before anything is written, so a
 * forged id simply comes back as a per-order "forbidden" result.
 */
export const groupOrderDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  orderIds: z.array(positiveId)
    .min(1)
    .max(MAX_BULK_DECISION_ORDERS)
    .refine(isUniquePositiveIdList, { message: "Duplicate orders are not allowed" }),
  // Required by the route when the decision is a rejection; kept optional here
  // so the message can name the decision rather than the field.
  reason: z.string().trim().min(1).max(2_000).optional(),
}).strict()

/**
 * A saved draft holds selections only. It is never trusted for pricing or
 * availability: submission re-resolves both from the database.
 */
export const groupOrderDraftSchema = z.object({
  groupId: z.union([positiveId, z.null()]),
  entries: z.array(groupOrderEntrySchema).max(MAX_GROUP_ORDER_ENTRIES),
  notes: z.string().trim().max(2_000).optional(),
  poNumber: optionalPurchaseOrderNumber,
  /**
   * The step being built but not yet saved, so a refresh mid-selection does not
   * discard it. Unlike a saved entry it may legitimately be empty, which is why
   * it does not reuse the submission item schema's minimum.
   */
  draftBranchIds: z.array(positiveId).max(MAX_GROUP_ORDER_BRANCHES).optional(),
  draftItems: z.array(z.object({
    organizationInventoryId: positiveId,
    quantity: z.coerce.number().positive().max(MAX_BUSINESS_QUANTITY),
  }).strict()).max(500).refine(
    (items) => isUniquePositiveIdList(items.map((item) => item.organizationInventoryId)),
    "Each product can only appear once",
  ).optional(),
}).strict()

// Support & Communication — the direct channel between a client organization
// and Apricart. Every one of these is `.strict()`: a body carrying an
// organization, a branch, a status the caller may not set, or a `createdBy` is
// rejected outright rather than silently ignored. Scope is read from the
// session, never from here.

const supportAttachmentIds = z.array(positiveId)
  .max(
    SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE,
    `A message can carry at most ${SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
  )
  .refine(isUniquePositiveIdList, "Each attachment can only be used once")
  .optional()
  .default([])

const supportMessageBody = z.string()
  .trim()
  .min(1, "A message is required")
  .max(
    SUPPORT_MESSAGE_MAX_LENGTH,
    `A message must not exceed ${SUPPORT_MESSAGE_MAX_LENGTH} characters`,
  )

export const supportThreadCreateSchema = z.object({
  subject: z.string()
    .trim()
    .min(1, "A subject is required")
    .max(
      SUPPORT_SUBJECT_MAX_LENGTH,
      `A subject must not exceed ${SUPPORT_SUBJECT_MAX_LENGTH} characters`,
    ),
  // Selectable, not the full vocabulary: a retired category may still be read
  // and filtered, but a new thread may not be raised under one.
  category: z.enum(SUPPORT_SELECTABLE_CATEGORIES),
  priority: z.enum(SUPPORT_PRIORITIES).optional().default("NORMAL"),
  // The order the query is about. Whether the caller may cite it is decided on
  // the server against the order row, not here.
  orderId: positiveId.nullish(),
  // The product the query is about. Likewise checked on the server, against the
  // author's own organization — this is an id, never a claim of scope.
  productId: positiveId.nullish(),
  message: supportMessageBody,
  attachmentIds: supportAttachmentIds,
}).strict().superRefine((value, ctx) => {
  // Every category but OTHER is about something in the catalogue, so it must
  // say which product. Restated here rather than left to the dialog, because a
  // caller reaching the endpoint directly never sees the dialog.
  if (isProductRequiredForCategory(value.category) && (value.productId ?? null) === null) {
    ctx.addIssue({
      code: "custom",
      path: ["productId"],
      message: "A query under this category must name the product it is about",
    })
  }
})

export const supportMessageCreateSchema = z.object({
  message: supportMessageBody,
  attachmentIds: supportAttachmentIds,
}).strict()

/**
 * A hand-made change to a thread. At least one field must be present, so an
 * empty body is a 400 rather than a silent no-op that looks like success.
 */
export const supportThreadUpdateSchema = z.object({
  status: z.enum(SUPPORT_STATUSES).optional(),
  priority: z.enum(SUPPORT_PRIORITIES).optional(),
  // `null` unassigns; omitted leaves the assignment alone.
  assignedToUserId: z.uuid().nullish(),
}).strict().refine(
  (value) => value.status !== undefined
    || value.priority !== undefined
    || value.assignedToUserId !== undefined,
  "Nothing to update",
)

/**
 * A Head Office exception to the overdue-payment block. The window is the
 * policy's (one month from now), never the client's: a body that names a
 * start, an expiry, an organization or an actor is refused whole.
 */
export const paymentControlExceptionGrantSchema = z.object({
  branchId: positiveId,
  reason: z.string().trim().max(1_000).optional(),
}).strict()

export const paymentControlExceptionRevokeSchema = z.object({
  reason: z.string().trim().max(1_000).optional(),
}).strict()

/* ── Joining an organization ─────────────────────────────────────────────── */

/**
 * The code, as an anonymous caller sends it.
 *
 * Normalised through the single `normalizeJoinCode` before it is checked, so
 * the endpoint, the join page and the check constraint on
 * `organization_join_codes.code` all judge the same string. Bounded before
 * normalisation too, so a megabyte of text is rejected without being upper-cased
 * first.
 */
const joinCodeSchema = z.string()
  .max(JOIN_CODE_MAX_LENGTH * 4)
  .transform(normalizeJoinCode)
  .refine((code) => joinCodeError(code) === null, {
    message: "Enter a valid join code",
  })

export const joinLookupSchema = z.object({
  code: joinCodeSchema,
}).strict()

/**
 * A join submission.
 *
 * Deliberately **not** `userCreateSchema`:
 *
 *   * there is no `organizationId` — the tenant is resolved from the code, so an
 *     applicant has no tenant to name and therefore none to tamper with;
 *   * `role` is `JOINABLE_ROLES`, not `systemRoleSchema`, so HEAD_OFFICE and
 *     SUPER_ADMIN cannot be asked for;
 *   * `isActive`, `mfaEnabled` and `budgetAllocationEnabled` are simply absent.
 *     `.strict()` turns each of them into a 400 rather than something silently
 *     applied — an applicant cannot activate themselves, disable MFA, or grant
 *     themselves the Group User budget-allocation right, which moves money.
 *
 * The password rules are the same `passwordSchema` an administrator is held to.
 */
export const joinRequestSubmitSchema = z.object({
  code: joinCodeSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.string().trim().pipe(z.email().max(255)),
  username: z.string().trim().min(3).max(255),
  password: passwordSchema,
  role: z.enum(JOINABLE_ROLES),
  branchId: nullablePositiveId.optional().default(null),
  groupIds: assignedIdList.optional().default([]),
  branchIds: assignedIdList.optional().default([]),
  phone: nullableText(32).optional(),
  employeeId: nullableText(64).optional(),
  imprestHolder: nullableText(255).optional(),
  contactPerson: nullableText(255).optional(),
  location: nullableText(255).optional(),
  address: nullableText(2_000).optional(),
}).strict()

/**
 * Head Office setting its organization's code.
 *
 * Omitting `code` asks the server to generate one — the recommended path, and
 * the reason generation lives on the server rather than in the browser.
 */
export const joinCodeSetSchema = z.object({
  code: joinCodeSchema.optional(),
}).strict()

/**
 * Head Office deciding a request.
 *
 * The four optional assignment fields let Head Office correct what was asked
 * for before letting somebody in. Every one of them is re-validated against the
 * organization exactly as the submission was, so an override can never reach
 * further than a submission could; `role` is the same `JOINABLE_ROLES`
 * allowlist. `budgetAllocationEnabled` is only here — it is never on the public
 * submission — because it grants the right to allocate money.
 */
export const joinRequestDecisionSchema = z.object({
  decision: z.enum(JOIN_DECISIONS),
  reason: nullableText(1_000).optional(),
  role: z.enum(JOINABLE_ROLES).optional(),
  branchId: nullablePositiveId.optional(),
  groupIds: assignedIdList.optional(),
  branchIds: assignedIdList.optional(),
  budgetAllocationEnabled: z.boolean().optional(),
}).strict().refine(
  (input) => input.decision === "approve" || (
    input.role === undefined
    && input.branchId === undefined
    && input.groupIds === undefined
    && input.branchIds === undefined
    && input.budgetAllocationEnabled === undefined
  ),
  { message: "Assignment fields apply only when approving a request" },
)

/*
 * The department sign-up (plans/OF-JOIN-department-signup-multi-user.md): the
 * join form of an organization with order approval levels on. Like the
 * standard submission there is no organizationId, role or username — the
 * tenant comes from the code, the role from the number of branches, and the
 * username from the email — and `.strict()` refuses any of them.
 */
const signupApproverSchema = z.object({
  level: z.number().int().min(1).max(MAX_APPROVAL_LEVELS),
  email: z.string().trim().toLowerCase().pipe(z.email().max(SIGNUP_APPROVER_EMAIL_MAX_LENGTH)),
  designation: z.string().trim().min(2).max(SIGNUP_DESIGNATION_MAX_LENGTH),
}).strict()

export const departmentJoinSubmitSchema = z.object({
  formVersion: z.literal(DEPARTMENT_SIGNUP_FORM_VERSION),
  code: joinCodeSchema,
  fullName: z.string().trim().min(3).max(SIGNUP_FULL_NAME_MAX_LENGTH),
  email: z.string().trim().pipe(z.email().max(255)),
  password: passwordSchema,
  phone: z.string().trim().regex(SIGNUP_PHONE_PATTERN, "Enter an 11-digit mobile number starting with 0"),
  ipExtension: z.string().trim().regex(SIGNUP_IP_EXTENSION_PATTERN, "Enter an IP extension of 3 to 6 digits"),
  employeeId: z.string().trim().min(1).max(SIGNUP_EMPLOYEE_ID_MAX_LENGTH),
  department: z.enum(DEPARTMENTS),
  // An existing branch picked by name, or a CRC number typed in.
  branches: z.array(z.union([
    z.object({ branchId: positiveId }).strict(),
    z.object({ crc: z.string().trim().min(1).max(CRC_MAX_LENGTH) }).strict(),
  ])).min(1).max(SIGNUP_MAX_BRANCHES),
  addresses: z.array(z.string().trim().min(5).max(SIGNUP_ADDRESS_MAX_LENGTH)).min(1).max(SIGNUP_MAX_ADDRESSES),
  approvers: z.array(signupApproverSchema).min(1).max(MAX_APPROVAL_LEVELS),
  termsAccepted: z.literal(true),
}).strict()

/**
 * Head Office deciding a department sign-up. For each CRC to create, either
 * the details of the new branch or an existing branch to map it onto; for each
 * address, the request branch it goes to (optional when there is one); and the
 * per-level outcome Head Office reviewed, which the approval must reproduce.
 */
export const departmentJoinDecisionSchema = z.object({
  decision: z.enum(JOIN_DECISIONS),
  reason: nullableText(1_000).optional(),
  username: z.string().trim().toLowerCase().min(3).max(255).optional(),
  newBranches: z.array(z.object({
    requestBranchId: positiveId,
    mapToBranchId: positiveId.optional(),
    name: z.string().trim().min(2).max(100).optional(),
    province: z.string().trim().min(2).max(100).optional(),
    city: z.string().trim().min(2).max(100).optional(),
    address: z.string().trim().min(5).max(500).optional(),
  }).strict()).max(SIGNUP_MAX_BRANCHES).optional(),
  addressBranches: z.array(z.object({
    requestAddressId: positiveId,
    requestBranchId: positiveId,
  }).strict()).max(SIGNUP_MAX_ADDRESSES).optional(),
  expectedResolutions: z.array(z.object({
    level: z.number().int().min(1).max(MAX_APPROVAL_LEVELS),
    kind: z.enum(["create", "assign", "extend", "covered", "not_applied", "blocked"]),
    userId: z.string().uuid().nullable(),
  }).strict()).max(MAX_APPROVAL_LEVELS).optional(),
}).strict().refine(
  (input) => input.decision === "approve" || (
    input.username === undefined
    && input.newBranches === undefined
    && input.addressBranches === undefined
    && input.expectedResolutions === undefined
  ),
  { message: "Assignment fields apply only when approving a request" },
)

/** Head Office naming a different approver for one level of a pending sign-up. */
export const departmentJoinApproverReplaceSchema = z.object({
  replaceApprover: signupApproverSchema,
}).strict()

/**
 * Asking for an extra delivery address at a branch.
 *
 * `.strict()` and deliberately narrow: there is **no `status`, no
 * `decidedBy`, no `decidedAt` and no `organizationId`** here, so none of them
 * can be mass assigned. A request is always created `pending` by the server,
 * which is what stops a requester approving its own address.
 *
 * `branchId` is present because a group-role requester acts across several
 * branches and has to say which one — it is intersected with the caller's own
 * resolved set before anything is read, never trusted on its own.
 */
export const deliveryAddressCreateSchema = z.object({
  branchId: positiveId,
  label: z.string().trim().min(1).max(MAX_DELIVERY_ADDRESS_LABEL),
  address: z.string().trim().min(1).max(MAX_DELIVERY_ADDRESS_LINE),
  city: nullableText(MAX_DELIVERY_ADDRESS_CITY).optional(),
  province: nullableText(MAX_DELIVERY_ADDRESS_PROVINCE).optional(),
  contactPerson: nullableText(MAX_DELIVERY_ADDRESS_CONTACT_PERSON).optional(),
  contactPhone: nullableText(MAX_DELIVERY_ADDRESS_CONTACT_PHONE).optional(),
  reason: nullableText(MAX_DELIVERY_ADDRESS_REASON).optional(),
}).strict()

/**
 * Head Office's decision on one. Nothing but the verdict and why — the address
 * itself is not editable through this route, because an approver who could
 * rewrite the address before approving it would be approving something the
 * branch never asked for.
 */
export const deliveryAddressDecisionSchema = z.object({
  decision: z.enum(DELIVERY_ADDRESS_DECISIONS),
  reason: nullableText(MAX_DELIVERY_ADDRESS_REASON).optional(),
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

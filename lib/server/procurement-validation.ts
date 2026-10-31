import { z } from "zod"

import { MAX_OVER_DELIVERY_TOLERANCE_BPS, PURCHASE_ORDER_STATUSES, RETURN_CONDITIONS } from "@/lib/procurement"

/**
 * Request bodies for purchasing. Every schema is strict: an unknown field is
 * refused, never ignored. See plans/OF-PROCUREMENT-purchasing.md.
 *
 * Production sits behind a WAF that refuses JSON bodies over 8 KB, so every
 * document is bounded to `PROCUREMENT_MAX_LINES` lines — comfortably under it.
 */

export const PROCUREMENT_MAX_LINES = 50
export const PROCUREMENT_MAX_BODY_BYTES = 8000
const MAX_QUANTITY = 999_999
const MAX_UNIT_COST_CENTS = 100_000_000_000

const id = z.number().int().positive()
const quantity = z.number().positive().max(MAX_QUANTITY)
const reason = z.string().trim().min(3, "Give a reason of at least 3 characters").max(500)
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format")
const expectedUpdatedAt = z.iso.datetime({ offset: true })

const supplierFields = {
  name: z.string().trim().min(2, "Supplier name is required").max(200),
  contactName: optionalText(200),
  phone: optionalText(32),
  email: z.union([z.literal(""), z.email().max(255)]).optional().nullable(),
  address: optionalText(500),
  ntn: optionalText(64),
}

export const supplierCreateSchema = z.object(supplierFields).strict()

export const supplierUpdateSchema = z
  .object({ ...supplierFields, name: supplierFields.name.optional(), status: z.enum(["ACTIVE", "INACTIVE"]).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Nothing to change")

const requisitionLine = z
  .object({ globalProductId: id, quantity, note: optionalText(500) })
  .strict()

export const requisitionCreateSchema = z
  .object({
    warehouseId: id,
    note: optionalText(1000),
    lines: z.array(requisitionLine).min(1, "Add at least one product").max(PROCUREMENT_MAX_LINES),
  })
  .strict()

export const requisitionDecisionSchema = z
  .object({ action: z.enum(["reject", "cancel"]), reason })
  .strict()

const purchaseOrderLine = z
  .object({
    globalProductId: id,
    quantity,
    unitCostCents: z.number().int().min(0).max(MAX_UNIT_COST_CENTS),
    taxRateBps: z.number().int().min(0).max(10000),
  })
  .strict()

const purchaseOrderFields = {
  supplierId: id,
  warehouseId: id,
  expectedDeliveryDate: isoDate.optional().nullable(),
  notes: optionalText(1000),
  lines: z.array(purchaseOrderLine).min(1, "Add at least one product").max(PROCUREMENT_MAX_LINES),
}

export const purchaseOrderCreateSchema = z
  .object({ ...purchaseOrderFields, requisitionId: id.optional().nullable() })
  .strict()

export const purchaseOrderActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), expectedUpdatedAt, ...purchaseOrderFields }).strict(),
  z.object({ action: z.literal("submit"), expectedUpdatedAt }).strict(),
  z.object({ action: z.literal("withdraw"), expectedUpdatedAt }).strict(),
  z.object({ action: z.literal("approve"), expectedUpdatedAt }).strict(),
  z.object({ action: z.literal("reject"), expectedUpdatedAt, reason }).strict(),
  z.object({ action: z.literal("cancel"), expectedUpdatedAt, reason }).strict(),
  z.object({ action: z.literal("close"), expectedUpdatedAt, reason }).strict(),
])
export type PurchaseOrderActionInput = z.infer<typeof purchaseOrderActionSchema>

export const purchaseOrderListQuerySchema = z
  .object({
    status: z.enum(PURCHASE_ORDER_STATUSES).optional(),
    warehouseId: z.coerce.number().int().positive().optional(),
    supplierId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict()

export const goodsReceiptSchema = z
  .object({
    supplierDeliveryNote: optionalText(120),
    notes: optionalText(1000),
    lines: z
      .array(z.object({ purchaseOrderLineId: id, quantity }).strict())
      .min(1, "Enter at least one received quantity")
      .max(PROCUREMENT_MAX_LINES),
  })
  .strict()

export const supplierInvoiceCreateSchema = z
  .object({
    purchaseOrderId: id,
    invoiceNumber: z.string().trim().min(1, "Invoice number is required").max(64),
    invoiceDate: isoDate,
    lines: z
      .array(
        z
          .object({ purchaseOrderLineId: id, quantity, unitCostCents: z.number().int().min(0).max(MAX_UNIT_COST_CENTS) })
          .strict(),
      )
      .min(1, "An invoice needs at least one line")
      .max(PROCUREMENT_MAX_LINES),
  })
  .strict()

export const supplierInvoiceDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), reason: reason.optional() }).strict(),
  z.object({ action: z.literal("reject"), reason }).strict(),
  z.object({ action: z.literal("pay"), paymentReference: optionalText(120) }).strict(),
])
export type SupplierInvoiceDecisionInput = z.infer<typeof supplierInvoiceDecisionSchema>

export const procurementSettingsSchema = z
  .object({
    overDeliveryTolerancePercent: z
      .number()
      .min(0)
      .max(MAX_OVER_DELIVERY_TOLERANCE_BPS / 100)
      .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9, "Use at most two decimals"),
  })
  .strict()

export const customerReturnCreateSchema = z
  .object({
    warehouseId: id,
    orderReference: z.string().trim().max(64).optional().nullable(),
    reason: z.string().trim().min(3, "Give a reason of at least 3 characters").max(1000),
    lines: z
      .array(z.object({ globalProductId: id, quantity, condition: z.enum(RETURN_CONDITIONS) }).strict())
      .min(1, "Add at least one product")
      .max(PROCUREMENT_MAX_LINES),
  })
  .strict()

export const customerReturnDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), reason: reason.optional() }).strict(),
  z.object({ action: z.literal("reject"), reason }).strict(),
])

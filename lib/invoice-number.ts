import { creditNoteSequences, invoiceSequences, organizations } from "@/db/schema"
import { eq, sql } from "drizzle-orm"
import { drawsInvoiceNumberAtCreation } from "@/lib/invoice-policy"

const INVOICE_PREFIX = "APR"
const CREDIT_NOTE_PREFIX = "CN"
const INVOICE_SEQUENCE_WIDTH = 6
const MAX_INVOICE_SEQUENCE = 999999
const TENANT_SHORT_NAME_PATTERN = /^[A-Z0-9_]+$/

/**
 * An organization without a usable code (`organizations.code`, the invoice
 * prefix) cannot have a tax invoice numbered for it. Since invoices are
 * numbered after the order is placed (at delivery, and since
 * plans/OF-INVOICE-issue-at-processing.md when processing starts), that used to
 * surface only when someone tried to move the order's delivery stage, as a 500
 * that rolled the step back. It is refused instead when an order is placed,
 * and answered plainly if a stage step meets it anyway
 * (plans/OF-INVOICE-invoice-ledger.md, "Fixes after the edge-case review").
 */
export const INVOICE_CODE_MISSING = "INVOICE_CODE_MISSING"
export const INVOICE_CODE_MISSING_MESSAGE =
  "This organization has no company code yet, so no tax invoice can be issued for it. Ask Apricart to set the company code in Edit Company."

export class InvoiceCodeMissingError extends Error {
  readonly code = INVOICE_CODE_MISSING
  constructor() {
    super(INVOICE_CODE_MISSING_MESSAGE)
    this.name = "InvoiceCodeMissingError"
  }
}

export function isInvoiceCodeMissingError(value: unknown): value is InvoiceCodeMissingError {
  return value instanceof InvoiceCodeMissingError
    || (typeof value === "object" && value !== null && (value as { code?: unknown }).code === INVOICE_CODE_MISSING)
}

/** Whether an organization code can prefix an invoice number. */
export function isInvoiceableTenantCode(code: unknown): boolean {
  return typeof code === "string" && TENANT_SHORT_NAME_PATTERN.test(code.trim().toUpperCase())
}

type InvoiceSequenceClient = {
  select: (fields: { tenantShortName: typeof organizations.code }) => any
  insert: (table: typeof invoiceSequences | typeof creditNoteSequences) => any
  update: (table: typeof invoiceSequences | typeof creditNoteSequences) => any
}

type InvoiceSequenceReadClient = {
  execute: (query: any) => Promise<any>
}

/**
 * Hold a shared lock on the tenant while an invoice is being attached.
 *
 * Organization-code updates take a FOR UPDATE lock on this same row. The two
 * locks serialize "issue the first invoice" with "change the invoice prefix":
 * either the code changes first and the invoice uses the new value, or the
 * invoice commits first and the organization update sees that invoicing has
 * started and refuses the change.
 */
export async function lockInvoiceTenantForIssuance(client: InvoiceSequenceClient, tenantId: number) {
  if (!Number.isInteger(tenantId) || tenantId < 1) {
    throw new Error("A valid tenant ID is required to generate an invoice number")
  }

  const [tenant] = await client
    .select({ tenantShortName: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, tenantId))
    .for("share")
    .limit(1)

  if (!isInvoiceableTenantCode(tenant?.tenantShortName)) {
    throw new InvoiceCodeMissingError()
  }

  return tenant.tenantShortName as string
}

function formatDocumentNumber(prefix: string, tenantShortName: string, sequenceValue: number) {
  const normalizedTenantShortName = tenantShortName.trim().toUpperCase()
  if (!normalizedTenantShortName || !TENANT_SHORT_NAME_PATTERN.test(normalizedTenantShortName)) {
    throw new Error("Tenant short name must contain only letters, numbers, and underscores")
  }
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1 || sequenceValue > MAX_INVOICE_SEQUENCE) {
    throw new Error(`Invoice sequence must be between 1 and ${MAX_INVOICE_SEQUENCE}`)
  }

  return `${normalizedTenantShortName}-${prefix}-${String(sequenceValue).padStart(INVOICE_SEQUENCE_WIDTH, "0")}`
}

export function formatInvoiceNumber(tenantShortName: string, sequenceValue: number) {
  return formatDocumentNumber(INVOICE_PREFIX, tenantShortName, sequenceValue)
}

/**
 * A credit note's number: `<ORGCODE>-CN-000001`, from its own per-organization
 * series, so a credit note can never take a number the invoice series needs
 * (plans/OF-INVOICE-invoice-ledger.md, D1).
 */
export function formatCreditNoteNumber(tenantShortName: string, sequenceValue: number) {
  return formatDocumentNumber(CREDIT_NOTE_PREFIX, tenantShortName, sequenceValue)
}

export async function generateNextInvoiceNumber(client: InvoiceSequenceClient, tenantId: number) {
  const tenantShortName = await lockInvoiceTenantForIssuance(client, tenantId)

  await client
    .insert(invoiceSequences)
    .values({ organizationId: tenantId, lastValue: 0 })
    .onConflictDoNothing()

  const [row] = await client
    .update(invoiceSequences)
    .set({
      lastValue: sql`${invoiceSequences.lastValue} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(invoiceSequences.organizationId, tenantId))
    .returning({ nextValue: invoiceSequences.lastValue })

  if (!row) {
    throw new Error("Failed to generate invoice number")
  }

  return formatInvoiceNumber(tenantShortName, Number(row.nextValue))
}

/**
 * Draw the organization's next credit-note number. Like the invoice series it
 * is drawn inside the transaction that writes the credit note, so a rollback
 * returns the number and the series stays gap-free.
 */
export async function generateNextCreditNoteNumber(client: InvoiceSequenceClient, tenantId: number) {
  const tenantShortName = await lockInvoiceTenantForIssuance(client, tenantId)

  await client
    .insert(creditNoteSequences)
    .values({ organizationId: tenantId, lastValue: 0 })
    .onConflictDoNothing()

  const [row] = await client
    .update(creditNoteSequences)
    .set({
      lastValue: sql`${creditNoteSequences.lastValue} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(creditNoteSequences.organizationId, tenantId))
    .returning({ nextValue: creditNoteSequences.lastValue })

  if (!row) {
    throw new Error("Failed to generate credit note number")
  }

  return formatCreditNoteNumber(tenantShortName, Number(row.nextValue))
}

/**
 * The invoice number an order's snapshot carries when it is placed: none, now
 * that invoices are numbered when processing starts (lib/invoice-policy.ts); otherwise the
 * next number in the series, or the TID when the sequence table is missing,
 * as before. Both creation paths call this, so they cannot differ.
 */
export async function assignInvoiceNumberAtCreation(
  client: InvoiceSequenceClient,
  receiptData: { invoiceNumber?: string },
  input: { organizationId: number; tid: string; invoiceSequenceReady: boolean },
): Promise<void> {
  delete receiptData.invoiceNumber
  if (!drawsInvoiceNumberAtCreation()) {
    // No number now, but the order will be invoiced when it is processed: an
    // organization that cannot be invoiced takes no order, rather than one it
    // could never deliver. Holds the same shared lock a code change waits on.
    await lockInvoiceTenantForIssuance(client, input.organizationId)
    return
  }
  if (input.invoiceSequenceReady) {
    receiptData.invoiceNumber = await generateNextInvoiceNumber(client, input.organizationId)
    return
  }
  // Even the emergency TID fallback participates in the organization-row
  // lock, so a code update cannot race past the tenant's first invoice.
  await lockInvoiceTenantForIssuance(client, input.organizationId)
  console.error("Invoice sequence table is missing; falling back to order TID for invoice number. Run the invoice sequence migration.")
  receiptData.invoiceNumber = input.tid
}

export async function hasInvoiceSequenceTable(client: InvoiceSequenceReadClient) {
  try {
    const result = await client.execute(sql`
      SELECT to_regclass('public.invoice_sequences') AS table_name
    `)
    return Boolean((result as any)?.rows?.[0]?.table_name)
  } catch (error) {
    console.error("Invoice sequence readiness check failed", error)
    return false
  }
}

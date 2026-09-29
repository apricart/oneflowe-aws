import { invoiceSequences, organizations } from "@/db/schema"
import { eq, sql } from "drizzle-orm"

const INVOICE_PREFIX = "APR"
const INVOICE_SEQUENCE_WIDTH = 6
const MAX_INVOICE_SEQUENCE = 999999
const TENANT_SHORT_NAME_PATTERN = /^[A-Z0-9_]+$/

type InvoiceSequenceClient = {
  select: (fields: { tenantShortName: typeof organizations.code }) => any
  insert: (table: typeof invoiceSequences) => any
  update: (table: typeof invoiceSequences) => any
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

  if (!tenant?.tenantShortName) {
    throw new Error("Tenant short name is required to generate an invoice number")
  }

  return tenant.tenantShortName
}

export function formatInvoiceNumber(tenantShortName: string, sequenceValue: number) {
  const normalizedTenantShortName = tenantShortName.trim().toUpperCase()
  if (!normalizedTenantShortName || !TENANT_SHORT_NAME_PATTERN.test(normalizedTenantShortName)) {
    throw new Error("Tenant short name must contain only letters, numbers, and underscores")
  }
  if (!Number.isInteger(sequenceValue) || sequenceValue < 1 || sequenceValue > MAX_INVOICE_SEQUENCE) {
    throw new Error(`Invoice sequence must be between 1 and ${MAX_INVOICE_SEQUENCE}`)
  }

  return `${normalizedTenantShortName}-${INVOICE_PREFIX}-${String(sequenceValue).padStart(INVOICE_SEQUENCE_WIDTH, "0")}`
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

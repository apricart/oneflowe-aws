-- New invoices include the organization's unique code before APR, for example:
--   UBL-APR-000001
--
-- Historical APR-###### invoices remain immutable. This partial index applies
-- global uniqueness only to the new format, so it can be added while the old
-- tenant-scoped invoice numbers still overlap across organizations.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_tenant_prefixed_invoice_number_unique_idx"
ON "orders" USING btree (("receipt_data" ->> 'invoiceNumber'))
WHERE ("receipt_data" ->> 'invoiceNumber') ~ '^[A-Z0-9_]+-APR-[0-9]{6}$';

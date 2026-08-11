CREATE TABLE IF NOT EXISTS "invoice_sequences" (
  "organization_id" integer PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "last_value" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "invoice_sequences_last_value_nonnegative" CHECK ("last_value" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_org_invoice_number_unique_idx"
ON "orders" USING btree ("organization_id", (("receipt_data" ->> 'invoiceNumber')))
WHERE ("receipt_data" ->> 'invoiceNumber') IS NOT NULL;

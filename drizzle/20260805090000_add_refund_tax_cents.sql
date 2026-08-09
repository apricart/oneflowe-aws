ALTER TABLE "refunds"
ADD COLUMN IF NOT EXISTS "tax_refund_cents" bigint DEFAULT 0 NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'refunds_tax_refund_valid_ck'
      AND conrelid = 'refunds'::regclass
  ) THEN
    ALTER TABLE "refunds"
    ADD CONSTRAINT "refunds_tax_refund_valid_ck"
    CHECK (
      "tax_refund_cents" >= 0
      AND "tax_refund_cents" <= "amount_cents"
    ) NOT VALID;
  END IF;
END
$$;

ALTER TABLE "refunds"
VALIDATE CONSTRAINT "refunds_tax_refund_valid_ck";

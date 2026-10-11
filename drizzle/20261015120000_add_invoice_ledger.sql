-- The invoice ledger: tax invoices and credit notes as records of their own.
-- See plans/OF-INVOICE-invoice-ledger.md (D1).
--
-- Additive only. No existing column, row or constraint changes:
--
--   * orders gains UNIQUE (id, organization_id), the target of the ledger's
--     composite (order_id, organization_id) keys, as branches and groups
--     already have. id is the primary key, so it can never fail.
--   * invoices, invoice_lines: one tax invoice per supplied order, issued at
--     delivery, numbered from the existing invoice_sequences series.
--   * credit_note_sequences, credit_notes, credit_note_lines: one numbered
--     credit note per refund approved against an issued invoice.
--   * Triggers make every issued document immutable. On invoices only the
--     credited totals and the status may move; nothing may be deleted except
--     rows the backfill wrote, and only by its rollback naming that batch.
--     invoice_lines, credit_notes and credit_note_lines refuse UPDATE and
--     DELETE outright.
--   * invoices.order_id references orders with NO ACTION, so the database
--     itself refuses to delete an order that carries a tax invoice.
--
-- Tables are new and empty, so the constraint and index builds are instant;
-- the orders unique index is built over a table of tens of thousands of rows.
--
-- Apply before deploying the code that issues at delivery, then run
-- `npm run backfill:invoice-ledger` (dry run, then commit with its digest), and
-- run it once more after the deploy to pick up anything delivered in between.
--
-- Rollback (only while nothing has been issued at supply — afterwards these
-- tables are financial records and are kept):
--   DROP TABLE IF EXISTS credit_note_lines, credit_notes, credit_note_sequences, invoice_lines, invoices;
--   DROP FUNCTION IF EXISTS invoice_ledger_refuse_change(), invoices_guard_change(), invoice_ledger_test_cleanup_allowed();
--   ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_id_organization_uq;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_id_organization_uq') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_id_organization_uq UNIQUE (id, organization_id);
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  branch_id integer NOT NULL,
  order_id integer NOT NULL,
  number varchar(40) NOT NULL,
  issue_date date NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  origin varchar(24) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'ISSUED',
  seller jsonb NOT NULL,
  buyer jsonb NOT NULL,
  participants jsonb NOT NULL DEFAULT '{}'::jsonb,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  discount_cents bigint NOT NULL DEFAULT 0,
  delivery_charges_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL,
  credited_net_cents bigint NOT NULL DEFAULT 0,
  credited_tax_cents bigint NOT NULL DEFAULT 0,
  credited_total_cents bigint NOT NULL DEFAULT 0,
  legacy_snapshot jsonb,
  issued_by_user_id uuid REFERENCES users(id),
  backfill_batch varchar(64),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT invoices_id_organization_uq UNIQUE (id, organization_id),
  CONSTRAINT invoices_origin_ck CHECK (origin IN ('ISSUED_AT_SUPPLY', 'LEGACY_SNAPSHOT', 'LEGACY_IMPORT')),
  CONSTRAINT invoices_status_ck CHECK (status IN ('ISSUED', 'PARTIALLY_CREDITED', 'CREDITED')),
  CONSTRAINT invoices_amounts_ck CHECK (net_cents >= 0 AND tax_cents >= 0 AND discount_cents >= 0 AND delivery_charges_cents >= 0 AND total_cents >= 0),
  CONSTRAINT invoices_arithmetic_ck CHECK (origin <> 'ISSUED_AT_SUPPLY' OR net_cents + tax_cents + delivery_charges_cents - discount_cents = total_cents),
  CONSTRAINT invoices_credited_ck CHECK (credited_net_cents >= 0 AND credited_tax_cents >= 0 AND credited_total_cents >= 0 AND credited_total_cents <= total_cents),
  CONSTRAINT invoices_legacy_snapshot_ck CHECK ((origin = 'ISSUED_AT_SUPPLY') = (legacy_snapshot IS NULL)),
  CONSTRAINT invoices_branch_org_fk FOREIGN KEY (branch_id, organization_id) REFERENCES branches(id, organization_id),
  CONSTRAINT invoices_order_org_fk FOREIGN KEY (order_id, organization_id) REFERENCES orders(id, organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_order_uq ON invoices (order_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_number_uq ON invoices (organization_id, number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_prefixed_number_uq ON invoices (number) WHERE number ~ '^[A-Z0-9_]+-APR-[0-9]{6}$';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_org_issue_date_idx ON invoices (organization_id, issue_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoices_branch_idx ON invoices (branch_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS invoice_lines (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL,
  organization_id integer NOT NULL,
  line_no integer NOT NULL,
  order_item_id integer NOT NULL REFERENCES order_items(id),
  product_name varchar(255) NOT NULL,
  product_code varchar(128),
  unit varchar(64) NOT NULL,
  category varchar(255),
  quantity numeric(12, 3) NOT NULL,
  unit_price_cents bigint NOT NULL,
  tax_rate_bp integer,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  gross_cents bigint NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT invoice_lines_line_no_ck CHECK (line_no > 0),
  CONSTRAINT invoice_lines_values_ck CHECK (quantity > 0 AND unit_price_cents >= 0 AND net_cents >= 0 AND tax_cents >= 0 AND net_cents + tax_cents = gross_cents),
  CONSTRAINT invoice_lines_tax_rate_ck CHECK (tax_rate_bp IS NULL OR (tax_rate_bp >= 0 AND tax_rate_bp <= 10000)),
  CONSTRAINT invoice_lines_invoice_org_fk FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_line_uq ON invoice_lines (invoice_id, line_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS invoice_lines_order_item_idx ON invoice_lines (order_item_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_note_sequences (
  organization_id integer PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  last_value integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT credit_note_sequences_range_ck CHECK (last_value >= 0 AND last_value <= 999999)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_notes (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL REFERENCES organizations(id),
  invoice_id integer NOT NULL,
  refund_id integer NOT NULL REFERENCES refunds(id),
  number varchar(40) NOT NULL,
  issue_date date NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  total_cents bigint NOT NULL,
  issued_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT credit_notes_id_organization_uq UNIQUE (id, organization_id),
  CONSTRAINT credit_notes_number_ck CHECK (number ~ '^[A-Z0-9_]+-CN-[0-9]{6}$'),
  CONSTRAINT credit_notes_amounts_ck CHECK (net_cents >= 0 AND tax_cents >= 0 AND total_cents > 0 AND net_cents + tax_cents = total_cents),
  CONSTRAINT credit_notes_invoice_org_fk FOREIGN KEY (invoice_id, organization_id) REFERENCES invoices(id, organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_refund_uq ON credit_notes (refund_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_notes_number_uq ON credit_notes (number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_notes_invoice_idx ON credit_notes (invoice_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id serial PRIMARY KEY,
  credit_note_id integer NOT NULL,
  organization_id integer NOT NULL,
  line_no integer NOT NULL,
  invoice_line_id integer REFERENCES invoice_lines(id),
  order_item_id integer REFERENCES order_items(id),
  description varchar(255) NOT NULL,
  quantity numeric(12, 3),
  tax_rate_bp integer,
  net_cents bigint NOT NULL,
  tax_cents bigint NOT NULL,
  gross_cents bigint NOT NULL,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT credit_note_lines_line_no_ck CHECK (line_no > 0),
  CONSTRAINT credit_note_lines_values_ck CHECK ((quantity IS NULL OR quantity > 0) AND net_cents >= 0 AND tax_cents >= 0 AND net_cents + tax_cents = gross_cents),
  CONSTRAINT credit_note_lines_credit_note_org_fk FOREIGN KEY (credit_note_id, organization_id) REFERENCES credit_notes(id, organization_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_note_lines_line_uq ON credit_note_lines (credit_note_id, line_no);
--> statement-breakpoint

-- An issued document never changes. Lines and credit notes refuse every
-- update and delete; an invoice lets only its credited totals and status move.
CREATE OR REPLACE FUNCTION invoice_ledger_test_cleanup_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$
  -- Integration suites delete what they created. Allowed only in a database
  -- whose name contains "test" (the suites refuse any other) and only when the
  -- cleanup asks for it in its own transaction; never in production.
  SELECT current_database() LIKE '%test%'
    AND coalesce(current_setting('oneflowe.invoice_ledger_test_cleanup', true), '') = 'on'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoice_ledger_refuse_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND invoice_ledger_test_cleanup_allowed() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'invoice ledger: % on % is not allowed; issued documents are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoices_guard_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF invoice_ledger_test_cleanup_allowed() THEN
      RETURN OLD;
    END IF;
    -- Only the backfill's own rollback, naming its batch, may remove a row the
    -- backfill wrote. An invoice issued at supply can never be deleted.
    IF OLD.backfill_batch IS NOT NULL
      AND current_setting('oneflowe.invoice_ledger_rollback_batch', true) = OLD.backfill_batch THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'invoice ledger: invoice % cannot be deleted', OLD.number USING ERRCODE = 'P0001';
  END IF;

  IF (NEW.id, NEW.organization_id, NEW.branch_id, NEW.order_id, NEW.number, NEW.issue_date, NEW.issued_at,
      NEW.origin, NEW.seller, NEW.buyer, NEW.participants, NEW.net_cents, NEW.tax_cents, NEW.discount_cents,
      NEW.delivery_charges_cents, NEW.total_cents, NEW.legacy_snapshot, NEW.issued_by_user_id,
      NEW.backfill_batch, NEW.created_at)
    IS DISTINCT FROM
     (OLD.id, OLD.organization_id, OLD.branch_id, OLD.order_id, OLD.number, OLD.issue_date, OLD.issued_at,
      OLD.origin, OLD.seller, OLD.buyer, OLD.participants, OLD.net_cents, OLD.tax_cents, OLD.discount_cents,
      OLD.delivery_charges_cents, OLD.total_cents, OLD.legacy_snapshot, OLD.issued_by_user_id,
      OLD.backfill_batch, OLD.created_at) THEN
    RAISE EXCEPTION 'invoice ledger: invoice % is issued; only its credited totals and status may change', OLD.number
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS invoices_guard_trg ON invoices;
--> statement-breakpoint
CREATE TRIGGER invoices_guard_trg BEFORE UPDATE OR DELETE ON invoices
FOR EACH ROW EXECUTE FUNCTION invoices_guard_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS invoice_lines_immutable_trg ON invoice_lines;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_immutable_trg BEFORE UPDATE OR DELETE ON invoice_lines
FOR EACH ROW EXECUTE FUNCTION invoice_ledger_refuse_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_notes_immutable_trg ON credit_notes;
--> statement-breakpoint
CREATE TRIGGER credit_notes_immutable_trg BEFORE UPDATE OR DELETE ON credit_notes
FOR EACH ROW EXECUTE FUNCTION invoice_ledger_refuse_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS credit_note_lines_immutable_trg ON credit_note_lines;
--> statement-breakpoint
CREATE TRIGGER credit_note_lines_immutable_trg BEFORE UPDATE OR DELETE ON credit_note_lines
FOR EACH ROW EXECUTE FUNCTION invoice_ledger_refuse_change();

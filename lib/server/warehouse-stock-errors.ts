import "server-only"

/**
 * The Warehouse Stock page can be reached before migration `20261105120000`
 * is applied (the code ships first, the mode switches last). Its endpoints
 * then answer with this, not a 500. See plans/OF-STOCK-per-warehouse-stock.md.
 */
export const STOCK_LEDGER_MISSING_MESSAGE =
  "Warehouse stock is not set up yet: apply migration 20261105120000 first."

/** Whether an error is Postgres saying a table does not exist (42P01), wrapped or not. */
export function isStockLedgerMissing(caught: unknown): boolean {
  const code = (value: unknown) => (value && typeof value === "object" && "code" in value ? (value as { code?: unknown }).code : undefined)
  return code(caught) === "42P01"
    || code(caught && typeof caught === "object" && "cause" in caught ? (caught as { cause?: unknown }).cause : undefined) === "42P01"
}

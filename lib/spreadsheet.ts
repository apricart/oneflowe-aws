import { stringifyPrimitive } from "./stringify-primitive"

function hasDangerousSpreadsheetPrefix(value: string): boolean {
  let index = 0
  while (index < value.length && (value.codePointAt(index) ?? 0) <= 0x20) index += 1
  return index < value.length && "=+-@".includes(value[index])
}

/**
 * Prefix formula-like strings with an apostrophe so spreadsheet software
 * displays the original value as text instead of evaluating it.
 */
export function neutralizeSpreadsheetFormula<T>(value: T): T | string {
  if (typeof value !== "string") return value
  return hasDangerousSpreadsheetPrefix(value) ? `'${value}` : value
}

export function sanitizeSpreadsheetRow<T extends readonly unknown[]>(row: T): unknown[] {
  return row.map((value) => neutralizeSpreadsheetFormula(value))
}

export function sanitizeSpreadsheetRecord<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      neutralizeSpreadsheetFormula(value),
    ]),
  ) as T
}

export function sanitizeSpreadsheetRecords<T extends Record<string, unknown>>(records: T[]): T[] {
  return records.map((record) => sanitizeSpreadsheetRecord(record))
}

export function csvCell(value: unknown): string {
  const safeValue = stringifyPrimitive(neutralizeSpreadsheetFormula(value ?? ""))
  return `"${safeValue.replace(/"/g, '""')}"`
}

export function createCsv(headers: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  return [headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")
}


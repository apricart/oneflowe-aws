import { parse } from "csv-parse/sync"

export const MAX_CSV_FILE_BYTES = 2 * 1024 * 1024
export const MAX_CSV_ROWS = 1000

export function decodeUtf8Csv(buffer: Buffer, maximumBytes = MAX_CSV_FILE_BYTES): string {
  if (buffer.length === 0) throw new Error("CSV file is empty")
  if (buffer.length > maximumBytes) {
    throw new Error(`CSV file exceeds the ${Math.floor(maximumBytes / 1024 / 1024)}MB limit`)
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer)
  } catch {
    throw new Error("CSV file must use valid UTF-8 encoding")
  }
}

export function parseStrictCsv(input: {
  content: string
  requiredHeaders: readonly string[]
  requiredHeaderGroups?: readonly (readonly string[])[]
  allowedHeaders: readonly string[]
  maximumRows?: number
}): Array<Record<string, string>> {
  let records: string[][]
  try {
    records = parse(input.content, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: false,
      max_record_size: 100_000,
    }) as string[][]
  } catch {
    throw new Error("CSV is malformed or contains invalid quoting")
  }

  if (records.length < 2) {
    throw new Error("CSV must contain a header row and at least one data row")
  }

  const headers = records[0].map((header) => header.trim().toLowerCase())
  if (headers.some((header) => !header)) throw new Error("CSV headers must not be empty")
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate headers")

  const missingHeaders = input.requiredHeaders.filter((header) => !headers.includes(header))
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required headers: ${missingHeaders.join(", ")}`)
  }

  const missingHeaderGroups = (input.requiredHeaderGroups ?? []).filter(
    (group) => !group.some((header) => headers.includes(header)),
  )
  if (missingHeaderGroups.length > 0) {
    throw new Error(
      `Missing required header: ${missingHeaderGroups.map((group) => group.join(" or ")).join(", ")}`,
    )
  }

  const allowedHeaders = new Set(input.allowedHeaders)
  const unexpectedHeaders = headers.filter((header) => !allowedHeaders.has(header))
  if (unexpectedHeaders.length > 0) {
    throw new Error(`Unexpected headers: ${unexpectedHeaders.join(", ")}`)
  }

  const maximumRows = input.maximumRows ?? MAX_CSV_ROWS
  const dataRows = records.slice(1)
  if (dataRows.length > maximumRows) {
    throw new Error(`CSV contains too many rows; maximum is ${maximumRows}`)
  }

  return dataRows.map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] ?? ""]),
  ))
}

export async function readStrictCsvFile(file: File, input: {
  requiredHeaders: readonly string[]
  requiredHeaderGroups?: readonly (readonly string[])[]
  allowedHeaders: readonly string[]
  maximumRows?: number
  maximumBytes?: number
}): Promise<Array<Record<string, string>>> {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    throw new Error("Only .csv files are accepted")
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const content = decodeUtf8Csv(buffer, input.maximumBytes)
  return parseStrictCsv({
    content,
    requiredHeaders: input.requiredHeaders,
    requiredHeaderGroups: input.requiredHeaderGroups,
    allowedHeaders: input.allowedHeaders,
    maximumRows: input.maximumRows,
  })
}

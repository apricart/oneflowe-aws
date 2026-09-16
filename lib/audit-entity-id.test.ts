import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * `audit_logs.entity_id` is varchar(128). It names the one row an audit entry
 * is about; the rows a cascade or a bulk write reached belong in `metadata`.
 *
 * Five writes used to put a comma-joined list of ids there, which overflowed
 * the column — and threw — as soon as the list passed ~25 rows: deactivating a
 * product stocked at eighty branches from the Organization Inventory page
 * failed on the audit insert after the branch rows had already been updated.
 * This is the control that keeps the pattern out.
 */

const ROOTS = ["app", "lib"]
const SOURCE = /\.tsx?$/
const EXCLUDED = /\.test\.tsx?$|\.d\.ts$/

function* sourceFiles(directory: string): Generator<string> {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path)
    } else if (SOURCE.test(name) && !EXCLUDED.test(name)) {
      yield path
    }
  }
}

describe("audit_logs.entity_id", () => {
  it("is never built from a joined list of ids", () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const path of sourceFiles(join(process.cwd(), root))) {
        const lines = readFileSync(path, "utf8").split("\n")
        lines.forEach((line, index) => {
          if (/entityId:\s*[^,\n]*\.join\(/.test(line)) {
            offenders.push(`${relative(process.cwd(), path)}:${index + 1}: ${line.trim()}`)
          }
        })
      }
    }
    expect(offenders).toEqual([])
  })
})

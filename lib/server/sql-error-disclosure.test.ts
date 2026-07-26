import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(entryPath)
    return entry.name === "route.ts" ? [entryPath] : []
  })
}

describe("database error responses", () => {
  it("does not serialize caught error messages or PostgreSQL details", () => {
    const apiDirectory = path.resolve(process.cwd(), "app/api")
    const unsafePatterns = [
      /error:\s*(?:error|err|e|criticalErr|cleanupErr)\??\.message/,
      /details:\s*(?:error|err|e|criticalErr|cleanupErr)\??\.(?:message|detail)/,
      /errors:\s*\[(?:error|err|e|criticalErr|cleanupErr)\??\.message\]/,
      /error:\s*[`"'][^`"']*\$?\{?(?:error|err|e|criticalErr|cleanupErr)\??\.message/,
      /NextResponse\.json\([\s\S]{0,300}?stack:\s*(?:process\.env[^\n]+\?\s*)?(?:error|err|e|criticalErr|cleanupErr)\??\.stack/,
    ]

    const violations = routeFiles(apiDirectory).flatMap((file) => {
      const source = readFileSync(file, "utf8")
      return unsafePatterns
        .filter((pattern) => pattern.test(source))
        .map((pattern) => `${path.relative(process.cwd(), file)}: ${pattern}`)
    })

    expect(violations).toEqual([])
  })
})

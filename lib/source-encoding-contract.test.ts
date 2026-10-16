import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * Source must not carry mojibake: UTF-8 text that was once read as
 * Windows-1252 and saved back. It renders literally: the dashboard's revenue
 * tooltip showed three garbage characters where `₨` belonged, and the Branches
 * table did the same for `—`.
 *
 * A UTF-8 lead byte read as Windows-1252 is Â/Ã (two-byte characters), â
 * (three-byte, e.g. ₨ — ▲) or ð (four-byte emoji), and is followed by a
 * continuation byte, which Windows-1252 shows as U+0080–U+00BF or one of the
 * punctuation letters it maps 0x80–0x9F to. Written as escapes so this file
 * does not match itself.
 */
const CP1252_CONTINUATION =
  "\\u0080-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC" +
  "\\u2013\\u2014\\u2018-\\u201E\\u2020-\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122"
const MOJIBAKE = new RegExp(`[\\u00C2\\u00C3\\u00E2\\u00F0][${CP1252_CONTINUATION}]|\\uFFFD`)

const ROOTS = ["app", "components", "db", "hooks", "lib", "scripts", "tests"]
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css)$/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path)
    return SOURCE_FILE.test(entry.name) ? [path] : []
  })
}

describe("source encoding", () => {
  it("detects the sequences it is meant to", () => {
    const windows1252 = new TextDecoder("windows-1252")
    for (const intended of ["₨", "—", "▲", "▼", "é", "✓", "🙂"]) {
      const bytes = Buffer.from(intended, "utf8")
      expect(MOJIBAKE.test(windows1252.decode(bytes)), intended).toBe(true)
      expect(MOJIBAKE.test(bytes.toString("latin1")), intended).toBe(true)
    }
    expect(MOJIBAKE.test("₨ 20,847 — ▲ 4.2% · café")).toBe(false)
  })

  it("no source file carries mojibake", () => {
    const root = process.cwd()
    const offenders = ROOTS.flatMap((dir) => sourceFiles(join(root, dir))).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          MOJIBAKE.test(line) ? [`${relative(root, file)}:${index + 1}: ${line.trim()}`] : [],
        ),
    )
    expect(offenders).toEqual([])
  })
})

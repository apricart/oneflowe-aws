import "server-only"

import { inflateSync } from "node:zlib"

/**
 * Checking an uploaded PDF before it is stored.
 *
 * Images are re-encoded through `sharp`, which throws away anything that is not
 * pixels. There is no equivalent safe re-encoder for PDF in this codebase, so a
 * PDF is *inspected* instead, and refused when it carries anything active:
 * script, launch actions, embedded files, rich media, XFA forms, form
 * submission, remote go-to actions, or encryption (which would hide the rest).
 *
 * This is one of two layers. The other is how it is served: as a download,
 * never inline, with a sandbox policy, so even a PDF this check missed cannot
 * run in the application's origin.
 *
 * Two evasions are handled: PDF names may spell characters as `#xx`
 * (`/J#61vaScript`), so names are decoded before matching; and dictionaries may
 * hide in compressed object streams (`/Type /ObjStm`), so those are inflated —
 * under a total output cap, so a decompression bomb is refused rather than
 * expanded. An object stream that cannot be inflated is refused, not skipped.
 */

export const MAX_PDF_INFLATED_BYTES = 32 * 1024 * 1024
const MAX_PDF_STREAMS = 2000

/** Matched case-sensitively on decoded text, as PDF names are case-sensitive. */
const FORBIDDEN_PDF_NAMES: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/JavaScript\b/, reason: "it contains JavaScript" },
  { pattern: /\/JS(?![A-Za-z0-9])/, reason: "it contains JavaScript" },
  { pattern: /\/Launch\b/, reason: "it can launch programs" },
  { pattern: /\/EmbeddedFiles?\b/, reason: "it contains embedded files" },
  { pattern: /\/RichMedia\b/, reason: "it contains embedded media" },
  { pattern: /\/XFA\b/, reason: "it contains an XFA form" },
  { pattern: /\/SubmitForm\b/, reason: "it submits data" },
  { pattern: /\/ImportData\b/, reason: "it imports data" },
  { pattern: /\/GoTo[RE]\b/, reason: "it links to other documents" },
  { pattern: /\/Encrypt\b/, reason: "it is encrypted" },
]

export type PdfInspection =
  | { ok: true }
  | { ok: false; error: string }

/** `#xx` escapes in names decoded, so an escaped keyword reads as itself. */
function decodeNameEscapes(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

type PdfStream = { dictionary: string; start: number; end: number }

/**
 * Every stream: the dictionary text in front of it, and where its bytes are.
 * The dictionary is what follows the last `obj` before the `stream` keyword.
 */
function findStreams(text: string): PdfStream[] {
  const streams: PdfStream[] = []
  const opener = /stream\r?\n/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(text)) !== null) {
    if (match.index > 0 && /[A-Za-z]/.test(text[match.index - 1])) continue // "endstream"
    const start = match.index + match[0].length
    const end = text.indexOf("endstream", start)
    if (end < 0) break
    const objectStart = text.lastIndexOf("obj", match.index)
    streams.push({ dictionary: text.slice(Math.max(0, objectStart), match.index), start, end })
    if (streams.length > MAX_PDF_STREAMS) break
    opener.lastIndex = end + "endstream".length
  }
  return streams
}

/** The file's own text with every stream's bytes blanked out. */
function structureText(text: string, streams: readonly PdfStream[]): string {
  let out = ""
  let cursor = 0
  for (const stream of streams) {
    out += text.slice(cursor, stream.start)
    cursor = stream.end
  }
  return out + text.slice(cursor)
}

function forbiddenReason(text: string): string | null {
  const decoded = decodeNameEscapes(text)
  const hit = FORBIDDEN_PDF_NAMES.find((entry) => entry.pattern.test(decoded))
  return hit ? hit.reason : null
}

/**
 * Whether `buffer` is a PDF that may be stored as a delivery challan. The
 * caller has already bounded the size; this bounds what decompression may add.
 */
export function inspectPdfUpload(buffer: Buffer): PdfInspection {
  const head = buffer.subarray(0, 8).toString("latin1")
  if (!/^%PDF-[12]\.\d/.test(head)) return { ok: false, error: "The file is not a PDF" }
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1")
  if (!tail.includes("%%EOF")) return { ok: false, error: "The PDF is incomplete or damaged" }

  // The structure — every object's dictionary — is scanned with stream
  // contents blanked out: a scanned page's image data is arbitrary bytes, and
  // would sooner or later spell "/JS" by chance.
  const text = buffer.toString("latin1")
  const streams = findStreams(text)
  if (streams.length > MAX_PDF_STREAMS) return { ok: false, error: "The PDF has too many parts to check" }
  const plainReason = forbiddenReason(structureText(text, streams))
  if (plainReason) return { ok: false, error: `This PDF cannot be accepted because ${plainReason}` }

  // Dictionaries can also hide inside compressed object streams; those, and
  // only those, are inflated and scanned. Page content and image streams carry
  // no actions.
  let inflatedTotal = 0
  for (const stream of streams) {
    if (!/\/Type\s*\/ObjStm\b/.test(decodeNameEscapes(stream.dictionary))) continue
    let inflated: Buffer
    try {
      inflated = inflateSync(buffer.subarray(stream.start, stream.end), {
        maxOutputLength: MAX_PDF_INFLATED_BYTES - inflatedTotal,
      })
    } catch (error) {
      if ((error as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE") {
        return { ok: false, error: "The PDF expands to more than this upload allows" }
      }
      // An object stream that cannot be read cannot be checked.
      return { ok: false, error: "The PDF is damaged and cannot be checked" }
    }
    inflatedTotal += inflated.length
    const reason = forbiddenReason(inflated.toString("latin1"))
    if (reason) return { ok: false, error: `This PDF cannot be accepted because ${reason}` }
  }

  return { ok: true }
}

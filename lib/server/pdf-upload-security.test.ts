import { deflateSync } from "node:zlib"

import { describe, expect, it } from "vitest"

import { MAX_PDF_INFLATED_BYTES, inspectPdfUpload } from "@/lib/server/pdf-upload-security"

/** A small, well-formed PDF with whatever extra objects a test needs. */
function pdf(...extraObjects: Array<string | Buffer>): Buffer {
  const parts: Buffer[] = [
    Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1"),
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n", "latin1"),
    ...extraObjects.map((part) => (typeof part === "string" ? Buffer.from(part, "latin1") : part)),
    Buffer.from("trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]
  return Buffer.concat(parts)
}

function streamObject(number: number, dictionary: string, body: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${number} 0 obj\n<< ${dictionary} /Length ${body.length} >>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ])
}

describe("inspecting an uploaded PDF", () => {
  it("accepts a plain document", () => {
    expect(inspectPdfUpload(pdf())).toEqual({ ok: true })
  })

  it("accepts a scanned page whose image bytes happen to spell an action", () => {
    // Arbitrary image data is never read as structure.
    const imageBytes = Buffer.concat([Buffer.alloc(64, 7), Buffer.from("/JS /Launch /JavaScript", "latin1"), Buffer.alloc(64, 9)])
    const image = streamObject(3, "/Type /XObject /Subtype /Image /Filter /DCTDecode", imageBytes)
    expect(inspectPdfUpload(pdf(image))).toEqual({ ok: true })
  })

  it("accepts compressed page content that is not an object stream", () => {
    const content = streamObject(3, "/Filter /FlateDecode", deflateSync(Buffer.from("BT /F1 12 Tf (Delivered) Tj ET /JS")))
    expect(inspectPdfUpload(pdf(content))).toEqual({ ok: true })
  })

  it.each([
    ["JavaScript", "3 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n"],
    ["a bare /JS entry", "3 0 obj\n<< /JS 4 0 R >>\nendobj\n"],
    ["a launch action", "3 0 obj\n<< /S /Launch /F (cmd.exe) >>\nendobj\n"],
    ["an embedded file", "3 0 obj\n<< /EmbeddedFiles 4 0 R >>\nendobj\n"],
    ["rich media", "3 0 obj\n<< /Subtype /RichMedia >>\nendobj\n"],
    ["an XFA form", "3 0 obj\n<< /XFA 4 0 R >>\nendobj\n"],
    ["form submission", "3 0 obj\n<< /S /SubmitForm /F (https://x.test) >>\nendobj\n"],
    ["a remote go-to", "3 0 obj\n<< /S /GoToR /F (other.pdf) >>\nendobj\n"],
    ["encryption", "3 0 obj\n<< /Encrypt 4 0 R >>\nendobj\n"],
  ])("refuses %s", (_label, object) => {
    const result = inspectPdfUpload(pdf(object))
    expect(result.ok).toBe(false)
  })

  it("is not fooled by #xx escapes in names", () => {
    expect(inspectPdfUpload(pdf("3 0 obj\n<< /S /J#61vaScript /J#53 (x) >>\nendobj\n")).ok).toBe(false)
    expect(inspectPdfUpload(pdf("3 0 obj\n<< /S /L#61unch >>\nendobj\n")).ok).toBe(false)
  })

  it("reads inside compressed object streams", () => {
    const hidden = deflateSync(Buffer.from("4 0 << /S /JavaScript /JS (app.alert(1)) >>"))
    const objectStream = streamObject(3, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", hidden)
    expect(inspectPdfUpload(pdf(objectStream)).ok).toBe(false)
    // The escape trick works on the stream's own dictionary too.
    const escaped = streamObject(3, "/Type /Obj#53tm /N 1 /First 4 /Filter /FlateDecode", hidden)
    expect(inspectPdfUpload(pdf(escaped)).ok).toBe(false)
  })

  it("refuses an object stream that cannot be read, rather than skipping it", () => {
    const broken = streamObject(3, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", Buffer.from("not deflate data"))
    expect(inspectPdfUpload(pdf(broken)).ok).toBe(false)
  })

  it("refuses a decompression bomb", () => {
    const bomb = deflateSync(Buffer.alloc(MAX_PDF_INFLATED_BYTES + 1024, 0x20))
    const objectStream = streamObject(3, "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", bomb)
    const result = inspectPdfUpload(pdf(objectStream))
    expect(result).toEqual({ ok: false, error: "The PDF expands to more than this upload allows" })
  })

  it("refuses something that only claims to be a PDF", () => {
    expect(inspectPdfUpload(Buffer.from("<html><script>alert(1)</script></html>")).ok).toBe(false)
    expect(inspectPdfUpload(Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\n")).ok).toBe(false) // no %%EOF
  })
})

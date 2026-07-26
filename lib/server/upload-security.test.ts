import { describe, expect, it } from "vitest"

import {
  inspectRasterImage,
  sanitizeRasterUpload,
  validateRasterUpload,
} from "@/lib/server/upload-security"

function pngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write("IHDR", 12, "ascii")
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

describe("raster upload validation", () => {
  it("detects valid raster magic bytes and dimensions", () => {
    expect(inspectRasterImage(pngHeader(640, 480))).toMatchObject({
      mime: "image/png",
      width: 640,
      height: 480,
    })
  })

  it("rejects HTML and SVG renamed as images", () => {
    expect(validateRasterUpload({
      buffer: Buffer.from("<html><script>alert(1)</script></html>"),
      declaredMime: "image/jpeg",
    }).ok).toBe(false)
    expect(validateRasterUpload({
      buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
      declaredMime: "image/png",
    }).ok).toBe(false)
  })

  it("rejects mismatched content types and oversized dimensions", () => {
    expect(validateRasterUpload({
      buffer: pngHeader(100, 100),
      declaredMime: "image/jpeg",
    }).ok).toBe(false)
    expect(validateRasterUpload({
      buffer: pngHeader(5000, 100),
      declaredMime: "image/png",
    }).ok).toBe(false)
  })

  it("fully decodes and re-encodes valid files while rejecting truncated images", async () => {
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    const valid = await sanitizeRasterUpload({
      buffer: validPng,
      declaredMime: "image/png",
    })
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.image).toMatchObject({ mime: "image/png", width: 1, height: 1 })
      expect(valid.buffer.length).toBeGreaterThan(0)
    }

    expect((await sanitizeRasterUpload({
      buffer: pngHeader(640, 480),
      declaredMime: "image/png",
    })).ok).toBe(false)
  })
})

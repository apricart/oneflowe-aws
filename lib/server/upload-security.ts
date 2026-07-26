import { randomUUID } from "node:crypto"
import sharp from "sharp"

export const MAX_IMAGE_UPLOAD_BYTES = 4 * 1024 * 1024
export const MAX_IMAGE_DIMENSION = 4096
export const MAX_IMAGE_PIXELS = 16_000_000

type SupportedImage = {
  mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp"
  extension: "jpg" | "png" | "gif" | "webp"
  width: number
  height: number
}

function pngDimensions(buffer: Buffer): SupportedImage | null {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null
  return {
    mime: "image/png",
    extension: "png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  }
}

function gifDimensions(buffer: Buffer): SupportedImage | null {
  if (buffer.length < 10) return null
  const signature = buffer.toString("ascii", 0, 6)
  if (signature !== "GIF87a" && signature !== "GIF89a") return null
  return {
    mime: "image/gif",
    extension: "gif",
    width: buffer.readUInt16LE(6),
    height: buffer.readUInt16LE(8),
  }
}

function webpDimensions(buffer: Buffer): SupportedImage | null {
  if (
    buffer.length < 30 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null
  }

  const chunkType = buffer.toString("ascii", 12, 16)
  let width = 0
  let height = 0

  if (chunkType === "VP8X" && buffer.length >= 30) {
    width = 1 + buffer.readUIntLE(24, 3)
    height = 1 + buffer.readUIntLE(27, 3)
  } else if (chunkType === "VP8 " && buffer.length >= 30) {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null
    width = buffer.readUInt16LE(26) & 0x3fff
    height = buffer.readUInt16LE(28) & 0x3fff
  } else if (chunkType === "VP8L" && buffer.length >= 25) {
    if (buffer[20] !== 0x2f) return null
    const b1 = buffer[21]
    const b2 = buffer[22]
    const b3 = buffer[23]
    const b4 = buffer[24]
    width = 1 + (((b2 & 0x3f) << 8) | b1)
    height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
  } else {
    return null
  }

  return { mime: "image/webp", extension: "webp", width, height }
}

function jpegDimensions(buffer: Buffer): SupportedImage | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }

    const marker = buffer[offset + 1]
    offset += 2

    if (marker === 0xd8 || marker === 0xd9) continue
    if (marker === 0xda) break
    if (offset + 2 > buffer.length) return null

    const segmentLength = buffer.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null

    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)

    if (isStartOfFrame) {
      if (segmentLength < 7) return null
      return {
        mime: "image/jpeg",
        extension: "jpg",
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3),
      }
    }

    offset += segmentLength
  }

  return null
}

export function inspectRasterImage(buffer: Buffer): SupportedImage | null {
  return (
    pngDimensions(buffer) ||
    jpegDimensions(buffer) ||
    gifDimensions(buffer) ||
    webpDimensions(buffer)
  )
}

export function validateRasterUpload(input: {
  buffer: Buffer
  declaredMime: string
}): { ok: true; image: SupportedImage; generatedFileName: string } | { ok: false; error: string } {
  if (input.buffer.length === 0) {
    return { ok: false, error: "Image file is empty" }
  }
  if (input.buffer.length > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, error: "Please upload an image under 4MB" }
  }

  const image = inspectRasterImage(input.buffer)
  if (!image) {
    return { ok: false, error: "File contents are not a supported JPG, PNG, GIF, or WEBP image" }
  }

  const normalizedDeclaredMime =
    input.declaredMime.toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : input.declaredMime.toLowerCase()

  if (normalizedDeclaredMime !== image.mime) {
    return { ok: false, error: "Declared image type does not match the file contents" }
  }

  if (
    image.width <= 0 ||
    image.height <= 0 ||
    image.width > MAX_IMAGE_DIMENSION ||
    image.height > MAX_IMAGE_DIMENSION ||
    image.width * image.height > MAX_IMAGE_PIXELS
  ) {
    return {
      ok: false,
      error: `Image dimensions must not exceed ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`,
    }
  }

  return {
    ok: true,
    image,
    generatedFileName: `product_${randomUUID()}.${image.extension}`,
  }
}

export async function sanitizeRasterUpload(input: {
  buffer: Buffer
  declaredMime: string
}): Promise<
  | {
    ok: true
    buffer: Buffer
    image: SupportedImage
    generatedFileName: string
  }
  | { ok: false; error: string }
> {
  const preliminary = validateRasterUpload(input)
  if (!preliminary.ok) return preliminary

  try {
    const decoder = sharp(input.buffer, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
      sequentialRead: true,
    })
    const metadata = await decoder.metadata()
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > MAX_IMAGE_DIMENSION ||
      metadata.height > MAX_IMAGE_DIMENSION ||
      metadata.width * metadata.height > MAX_IMAGE_PIXELS
    ) {
      return {
        ok: false,
        error: `Image dimensions must not exceed ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION}`,
      }
    }

    const normalized = decoder.rotate()
    if (preliminary.image.mime === "image/jpeg") {
      normalized.jpeg({ quality: 90, mozjpeg: true })
    } else if (preliminary.image.mime === "image/png") {
      normalized.png({ compressionLevel: 9 })
    } else if (preliminary.image.mime === "image/gif") {
      normalized.gif({ effort: 3 })
    } else {
      normalized.webp({ quality: 90, effort: 4 })
    }

    const output = await normalized.toBuffer({ resolveWithObject: true })
    if (output.data.length === 0 || output.data.length > MAX_IMAGE_UPLOAD_BYTES) {
      return { ok: false, error: "Sanitized image must remain under 4MB" }
    }

    return {
      ok: true,
      buffer: output.data,
      image: {
        ...preliminary.image,
        width: output.info.width,
        height: output.info.height,
      },
      generatedFileName: preliminary.generatedFileName,
    }
  } catch {
    return { ok: false, error: "Image is corrupted or could not be decoded safely" }
  }
}

import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  buildImageKey,
  extensionForMime,
  imagePathForKey,
  isImageStorageConfigured,
  putImage,
} from "@/lib/server/image-storage"

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("upload", (session.user as any).id)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("image")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No image file provided" }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)

    // Re-encodes through sharp, which drops EXIF and any embedded payload. This
    // has to happen server-side, which is why uploads are proxied here rather
    // than handed a presigned URL straight to the bucket.
    const validation = await sanitizeRasterUpload({
      buffer,
      declaredMime: file.type,
    })
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const extension = extensionForMime(validation.image.mime)
    if (!extension) {
      return NextResponse.json({ error: "Unsupported image type" }, { status: 400 })
    }

    if (!isImageStorageConfigured()) {
      // Never silently fall back to a base64 column in production - that is the
      // behaviour this endpoint exists to replace.
      if (process.env.NODE_ENV === "production") {
        console.error("Upload rejected: AWS_REGION/S3_UPLOADS_BUCKET are not configured")
        return NextResponse.json(
          { error: "Image storage is not configured" },
          { status: 503 },
        )
      }

      console.warn(
        "[upload] S3 is not configured; returning an inline data URL for local development only",
      )
      return NextResponse.json({
        url: `data:${validation.image.mime};base64,${validation.buffer.toString("base64")}`,
        fileName: validation.generatedFileName,
        size: validation.buffer.length,
        type: validation.image.mime,
        width: validation.image.width,
        height: validation.image.height,
      })
    }

    const key = buildImageKey(extension)
    await putImage({
      key,
      body: validation.buffer,
      contentType: validation.image.mime,
    })

    return NextResponse.json({
      url: imagePathForKey(key),
      fileName: validation.generatedFileName,
      size: validation.buffer.length,
      type: validation.image.mime,
      width: validation.image.width,
      height: validation.image.height,
    })

  } catch (error: any) {
    console.error("Critical Upload Error:", error)
    return NextResponse.json({
      error: "Internal Server Error",
      details: "Upload failed"
    }, { status: 500 })
  }
}

import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { canRaiseProductRequest } from "@/lib/product-request-access"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { withRateLimit } from "@/lib/rate-limiter"
import { db } from "@/lib/db"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"
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

    // Super Admin uploads catalogue images. Head Office uploads the picture on a
    // new-product request — through this path rather than one of its own,
    // because it is the one raster upload the production WAF lets through
    // (see `plans/OF-PRODUCT-REQUEST-head-office-new-product-requests.md`).
    // That grants Head Office no new reach: it already sets its catalogue's
    // `custom_image_url` through `PUT /api/v1/head-office/organization-inventory`.
    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN" && !canRaiseProductRequest(userRole)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
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

    // Recorded after the object lands, and a failure here propagates.
    //
    // There is no transaction to share with an S3 write, so the two cannot be
    // made atomic. Of the two failure modes, an orphaned object the caller
    // retries past is better than a file silently accepted with no record of
    // who put it there — and an orphan was already possible whenever a client
    // disconnects mid-upload.
    await recordAuditEvent(db, {
      action: "UPLOAD_IMAGE",
      entity: "image",
      entityId: key,
      actor: auditActorFromSession(session),
      after: {
        path: imagePathForKey(key),
        type: validation.image.mime,
        sizeBytes: validation.buffer.length,
        width: validation.image.width,
        height: validation.image.height,
      },
      // The name the browser sent, kept because it is the only clue to what the
      // file was meant to be; the stored key is deliberately not derived from it.
      context: { originalFileName: validation.generatedFileName },
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

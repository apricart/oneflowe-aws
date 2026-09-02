import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import {
  getImage,
  isImageStorageConfigured,
  isValidImageKey,
} from "@/lib/server/image-storage"

/**
 * Streams a product image out of the private uploads bucket.
 *
 * The bucket has no public access, so this route is the only way in. Every
 * signed-in role needs product images (ORDER_PORTAL users browse `/shop`), so
 * the check here is authentication, not authorisation - uploading is what is
 * restricted to SUPER_ADMIN, over in the upload route.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ key: string[] }> },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (!isImageStorageConfigured()) {
      return NextResponse.json(
        { error: "Image storage is not configured" },
        { status: 503 },
      )
    }

    const { key: segments } = await context.params
    const key = (segments ?? []).join("/")

    // Keys are UUIDs this application generated. Anything that does not match
    // that exact shape is a probe, and is refused without touching S3.
    if (!isValidImageKey(key)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const image = await getImage(key)
    if (!image?.body) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const headers = new Headers({
      "Content-Type": image.contentType,
      // Object names are random and never reused, so the bytes behind a URL
      // cannot change. `private` keeps it in the browser cache, not a shared one.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    })
    if (image.contentLength !== undefined) {
      headers.set("Content-Length", String(image.contentLength))
    }
    if (image.etag) {
      headers.set("ETag", image.etag)
    }

    return new NextResponse(image.body.transformToWebStream(), { headers })
  } catch (error) {
    console.error("Image fetch error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

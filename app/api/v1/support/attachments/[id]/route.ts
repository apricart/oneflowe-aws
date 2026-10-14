import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { isSupportParticipantRole } from "@/lib/support-access"
import {
  getImage,
  isImageStorageConfigured,
  isValidSupportAttachmentKey,
} from "@/lib/server/image-storage"
import { getSupportAttachmentForViewer } from "@/lib/server/support-threads"
import { supportReaderFromSession } from "@/lib/server/support-session"

/**
 * Streams one support attachment.
 *
 * This route exists because `GET /api/v1/images/[...key]` authenticates but
 * does not authorize — right for a catalogue picture, wrong for a screenshot of
 * somebody's invoice. Here the attachment is resolved to its thread and the
 * thread's own visibility rule is applied, so a signed-in user from another
 * tenant gets a 404 exactly as they would for the thread itself.
 *
 * The object is addressed by its **row id**, never by a key from the request:
 * the key is read out of the row and re-validated against the `support/` shape
 * before it reaches S3.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportReaderFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("api", viewer.userId)
    if (rateLimit) return rateLimit

    const attachmentId = Number((await context.params).id)
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    if (!isImageStorageConfigured()) {
      return NextResponse.json({ error: "Attachment storage is not configured" }, { status: 503 })
    }

    const attachment = await getSupportAttachmentForViewer(viewer, attachmentId)
    // One answer for "no such attachment" and "not yours".
    if (!attachment || !isValidSupportAttachmentKey(attachment.storageKey)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const object = await getImage(attachment.storageKey)
    if (!object?.body) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const headers = new Headers({
      "Content-Type": attachment.contentType,
      // `private` and `no-store`: unlike a product image, this is one tenant's
      // material and must never sit in a shared cache.
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      // Never inline. An attachment is arbitrary user-supplied content, and
      // rendering it in the application's own origin is how a stored image
      // turns into a stored attack.
      "Content-Disposition": `attachment; filename="${asciiFileName(attachment.fileName)}"`,
    })
    if (object.contentLength !== undefined) {
      headers.set("Content-Length", String(object.contentLength))
    }

    return new NextResponse(object.body.transformToWebStream(), { headers })
  } catch (error) {
    const handled = handleError(error, "GET /api/v1/support/attachments/[id]")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

/**
 * A filename safe to put inside a quoted header value.
 *
 * The stored name is already sanitised on upload; this is the second line of
 * defence, because a header is one place where a stray quote or newline is a
 * response-splitting bug rather than a cosmetic one.
 */
const HEADER_UNSAFE = /[^A-Za-z0-9._-]/g

function asciiFileName(name: string): string {
  const cleaned = name.replace(HEADER_UNSAFE, "_").slice(0, 120)
  return cleaned || "attachment"
}

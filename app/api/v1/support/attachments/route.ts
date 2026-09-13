import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"

import { supportAttachments } from "@/db/schema"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { handleError } from "@/lib/error-handler"
import { withRateLimit } from "@/lib/rate-limiter"
import { canRaiseSupportThread, isSupportParticipantRole, type SupportViewer } from "@/lib/support-access"
import {
  buildSupportAttachmentKey,
  extensionForMime,
  isImageStorageConfigured,
  putImage,
} from "@/lib/server/image-storage"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { getSupportThreadForViewer } from "@/lib/server/support-threads"
import { resolveSupportAuthor, supportViewerFromSession } from "@/lib/server/support-session"

/**
 * Uploading a screenshot to attach to a support message.
 *
 * The file is re-encoded through `sharp` before it is stored, exactly as a
 * product image is — that is what drops EXIF and anything embedded in the
 * bytes, and it is why uploads are proxied here rather than handed a presigned
 * URL straight to the bucket.
 *
 * The object lands under the `support/` prefix, which
 * `GET /api/v1/images/[...key]` does not serve. It comes back only through
 * `GET /api/v1/support/attachments/[id]`, which applies its thread's rule.
 *
 * The row is created unclaimed: it belongs to no thread and no message until
 * the message that carries it is posted, and until then only its uploader can
 * read it back.
 *
 * Which tenant the row is stamped with depends on where the upload comes from:
 *
 *  - **A reply** sends the `threadId` it is replying to. The uploader must be
 *    able to read that thread — the same rule as opening it, answered with the
 *    same 404 — and the row takes the thread's organization. This is what lets
 *    Apricart, which has no organization of its own, attach a screenshot to an
 *    answer: the claim on the reply checks the row against the thread's tenant.
 *  - **A new query** sends nothing, because there is no thread yet. The row
 *    takes the uploader's own organization, so a caller with none cannot
 *    upload here — Apricart answers threads, it does not raise them.
 *
 * Either way the tenant is read from the database, never from the request: a
 * `threadId` is an id the visibility rule is applied to, not a claim of scope.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const viewer = supportViewerFromSession(session)
    if (!viewer || !isSupportParticipantRole(viewer.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("upload", viewer.userId)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("file")
    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    const tenant = await resolveUploadTenant(viewer, formData.get("threadId"))
    if (!tenant.ok) {
      return NextResponse.json({ error: tenant.error }, { status: tenant.status })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const validation = await sanitizeRasterUpload({ buffer, declaredMime: file.type })
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const extension = extensionForMime(validation.image.mime)
    if (!extension) {
      return NextResponse.json({ error: "Unsupported image type" }, { status: 400 })
    }

    if (!isImageStorageConfigured()) {
      // There is no data-URL fallback here at any tier. A support attachment is
      // never written into a column, so an unconfigured bucket is an outage,
      // not a reason to change where the bytes live.
      return NextResponse.json(
        { error: "Attachment storage is not configured" },
        { status: 503 },
      )
    }

    const key = buildSupportAttachmentKey(extension)
    await putImage({ key, body: validation.buffer, contentType: validation.image.mime })

    const fileName = safeFileName(file.name, extension)
    const [attachment] = await db
      .insert(supportAttachments)
      .values({
        threadId: null,
        messageId: null,
        organizationId: tenant.organizationId,
        uploadedByUserId: viewer.userId,
        storageKey: key,
        // The client's filename is recorded for display only. It never builds a
        // key, a path, or a header.
        fileName,
        contentType: validation.image.mime,
        sizeBytes: validation.buffer.length,
      })
      .returning({ id: supportAttachments.id })

    return NextResponse.json(
      {
        id: attachment.id,
        fileName,
        contentType: validation.image.mime,
        sizeBytes: validation.buffer.length,
      },
      { status: 201 },
    )
  } catch (error) {
    const handled = handleError(error, "POST /api/v1/support/attachments")
    return NextResponse.json({ error: handled.message }, { status: handled.status })
  }
}

type UploadTenant =
  | { ok: true; organizationId: number }
  | { ok: false; error: string; status: 403 | 404 }

/**
 * The organization an upload belongs to. See the handler comment for the two
 * cases; the thread path answers 404 for an unreadable thread so an id cannot
 * be probed for existence, exactly as `GET /threads/[id]` does.
 */
async function resolveUploadTenant(
  viewer: SupportViewer,
  rawThreadId: FormDataEntryValue | null,
): Promise<UploadTenant> {
  if (rawThreadId !== null) {
    const threadId = typeof rawThreadId === "string" ? Number(rawThreadId) : NaN
    if (!Number.isInteger(threadId) || threadId <= 0) {
      return { ok: false, error: "Support request not found", status: 404 }
    }
    const thread = await getSupportThreadForViewer(viewer, threadId)
    if (!thread) {
      return { ok: false, error: "Support request not found", status: 404 }
    }
    return { ok: true, organizationId: thread.organizationId }
  }

  const author = await resolveSupportAuthor()
  if (!author || !canRaiseSupportThread(author.role)) {
    return { ok: false, error: "Forbidden", status: 403 }
  }
  return { ok: true, organizationId: author.organizationId }
}

/**
 * A display name that cannot be mistaken for a path.
 *
 * Only the last path segment survives, control characters and the characters
 * that mean something to a filesystem or a header are dropped, leading dots go,
 * and the extension is forced to whatever `sharp` actually produced rather than
 * whatever the client claimed.
 */
// Control characters, quotes, angle brackets, and the Windows-reserved set.
// Built from a string rather than a literal so the control range stays readable
// and does not put raw bytes in the source.
// eslint-disable-next-line no-control-regex -- removing control characters is the point
const UNSAFE_FILENAME_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f\"'<>|:*?\\\\/]", "g")

function safeFileName(name: unknown, extension: string): string {
  const base = typeof name === "string" ? name : ""
  const lastSegment = base.split(/[\\/]/).pop() ?? ""
  const cleaned = lastSegment
    .replace(UNSAFE_FILENAME_CHARACTERS, "")
    .replace(/^\.+/, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 120)

  return `${cleaned || "attachment"}.${extension}`
}

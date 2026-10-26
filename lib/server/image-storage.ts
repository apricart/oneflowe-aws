import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3"

import { parseImageStorageEnv } from "@/lib/server/env-validation"
import { ORDER_INTAKE_ATTACHMENT_PREFIX } from "@/lib/order-desk-access"

/**
 * Product images live in S3, not in the database.
 *
 * The column stores an application path (`/api/v1/images/<key>`) rather than a
 * bucket URL, so the bucket can stay private and the serving strategy can change
 * — a CDN in front, a different bucket, a different region — without rewriting
 * a single row. Rows written before this change still hold `data:` URLs; both
 * shapes render, and `isStoredImagePath`/`isDataUrl` tell them apart.
 */

export const IMAGE_PATH_PREFIX = "/api/v1/images"
const KEY_PREFIX = "products"

/**
 * Support attachments live under their own prefix, and that separation is a
 * security control rather than tidiness.
 *
 * `GET /api/v1/images/[...key]` authenticates but does not authorize — every
 * signed-in user may fetch any product image, which is right for a catalogue
 * picture and wrong for a screenshot of somebody's invoice. `isValidImageKey`
 * therefore stays pinned to `products/`, so that route can never serve one of
 * these objects. A support attachment comes back only through
 * `GET /api/v1/support/attachments/[id]`, which applies its thread's rule.
 */
const SUPPORT_KEY_PREFIX = "support"

export type StoredImageExtension = "jpg" | "png" | "gif" | "webp"

const EXTENSION_BY_MIME: Record<string, StoredImageExtension> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
}

const CONTENT_TYPE_BY_EXTENSION: Record<StoredImageExtension, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
}

/**
 * Keys are generated here and never derived from user input, so the serving
 * route can demand this exact shape. Anything else — a traversal attempt, a
 * probe for another prefix — is rejected before it reaches S3.
 */
const KEY_PATTERN =
  /^products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/

let s3Client: S3Client | null = null
let s3ClientRegion: string | null = null
let resolvedConfig: { region: string; bucket: string } | null = null

export class ImageStorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Image storage is not configured: set S3_UPLOADS_BUCKET and S3_UPLOADS_REGION (or AWS_REGION)",
    )
    this.name = "ImageStorageNotConfiguredError"
  }
}

/**
 * Local disk store for development when the machine has no AWS credentials
 * (POD / challan / product uploads). Set `S3_UPLOADS_LOCAL_DIR` (e.g. `.data/uploads`).
 */
function localUploadsRoot(): string | null {
  const dir = process.env.S3_UPLOADS_LOCAL_DIR?.trim()
  if (!dir) return null
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir)
}

function usesLocalUploads(): boolean {
  return localUploadsRoot() != null
}

function assertSafeStorageKey(key: string): void {
  if (!key || key.includes("..") || key.startsWith("/") || path.isAbsolute(key)) {
    throw new Error("Invalid image storage key")
  }
}

function localPathForKey(key: string): string {
  assertSafeStorageKey(key)
  return path.join(localUploadsRoot()!, key)
}

export function isImageStorageConfigured(): boolean {
  if (usesLocalUploads()) return true
  // S3_UPLOADS_REGION wins; AWS_REGION (which SES also uses) is the fallback.
  return Boolean(
    (process.env.S3_UPLOADS_REGION || process.env.AWS_REGION) &&
      process.env.S3_UPLOADS_BUCKET,
  )
}

function requireConfig(): { region: string; bucket: string } {
  if (resolvedConfig) return resolvedConfig

  if (!isImageStorageConfigured()) {
    throw new ImageStorageNotConfiguredError()
  }

  if (usesLocalUploads()) {
    resolvedConfig = { region: "local", bucket: "local" }
    return resolvedConfig
  }

  const parsed = parseImageStorageEnv(process.env)
  resolvedConfig = { region: parsed.region, bucket: parsed.bucket }
  return resolvedConfig
}

/**
 * Credentials come from the default provider chain — the EC2 instance profile in
 * production, a local profile in development. They are never read from
 * application config, matching `lib/email/ses.ts`.
 */
function getClient(region: string): S3Client {
  if (!s3Client || s3ClientRegion !== region) {
    s3Client = new S3Client({ region })
    s3ClientRegion = region
  }
  return s3Client
}

export function extensionForMime(mime: string): StoredImageExtension | null {
  return EXTENSION_BY_MIME[mime.toLowerCase()] ?? null
}

export function contentTypeForKey(key: string): string {
  const extension = key.slice(key.lastIndexOf(".") + 1) as StoredImageExtension
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/octet-stream"
}

export function buildImageKey(extension: StoredImageExtension): string {
  return `${KEY_PREFIX}/${randomUUID()}.${extension}`
}

export function isValidImageKey(key: string): boolean {
  return KEY_PATTERN.test(key)
}

/**
 * Keys for support attachments. Same shape, different prefix, and deliberately
 * a different validator — nothing that accepts one accepts the other.
 */
const SUPPORT_KEY_PATTERN =
  /^support\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/

export function buildSupportAttachmentKey(extension: StoredImageExtension): string {
  return `${SUPPORT_KEY_PREFIX}/${randomUUID()}.${extension}`
}

export function isValidSupportAttachmentKey(key: string): boolean {
  return SUPPORT_KEY_PATTERN.test(key)
}

/**
 * Keys for an Order Desk order's screenshot — the customer's WhatsApp message
 * or email, which carries their personal details. Like support attachments it
 * has a prefix of its own, so `GET /api/v1/images/[...key]` (pinned to
 * `products/`) can never serve one; it comes back only through
 * `GET /api/v1/order-desk/orders/[id]/attachment`, behind the desk's reach.
 * The shape rule is `isOrderIntakeAttachmentKey` in `lib/order-desk-access.ts`.
 */
export function buildOrderIntakeAttachmentKey(extension: StoredImageExtension): string {
  return `${ORDER_INTAKE_ATTACHMENT_PREFIX}/${randomUUID()}.${extension}`
}

export function imagePathForKey(key: string): string {
  return `${IMAGE_PATH_PREFIX}/${key}`
}

export function isDataUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith("data:")
}

export function isStoredImagePath(value: string | null | undefined): boolean {
  if (typeof value !== "string" || !value.startsWith(`${IMAGE_PATH_PREFIX}/`)) {
    return false
  }
  return isValidImageKey(value.slice(IMAGE_PATH_PREFIX.length + 1))
}

/** Parses a `data:` URL into its bytes. Returns null if it is not one we wrote. */
export function parseDataUrl(
  value: string,
): { buffer: Buffer; mime: string } | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(value)
  if (!match) return null

  const [, mime, base64] = match
  if (!extensionForMime(mime)) return null

  try {
    const buffer = Buffer.from(base64, "base64")
    return buffer.length > 0 ? { buffer, mime: mime.toLowerCase() } : null
  } catch {
    return null
  }
}

export async function putImage(input: {
  key: string
  body: Buffer
  contentType: string
}): Promise<void> {
  requireConfig()

  if (usesLocalUploads()) {
    const filePath = localPathForKey(input.key)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, input.body)
    return
  }

  const { bucket, region } = requireConfig()
  await getClient(region).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      // Filenames are random UUIDs, so an object never changes once written.
      CacheControl: "public, max-age=31536000, immutable",
      ServerSideEncryption: "AES256",
    }),
  )
}

export type FetchedImage = {
  body: GetObjectCommandOutput["Body"]
  contentType: string
  contentLength?: number
  etag?: string
}

function localFetchedBody(filePath: string): NonNullable<GetObjectCommandOutput["Body"]> {
  const nodeStream = createReadStream(filePath)
  return {
    transformToWebStream: () => Readable.toWeb(nodeStream) as ReadableStream,
    transformToByteArray: async () => {
      const chunks: Buffer[] = []
      for await (const chunk of createReadStream(filePath)) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return new Uint8Array(Buffer.concat(chunks))
    },
  } as NonNullable<GetObjectCommandOutput["Body"]>
}

export async function getImage(key: string): Promise<FetchedImage | null> {
  requireConfig()

  if (usesLocalUploads()) {
    const filePath = localPathForKey(key)
    try {
      const info = await stat(filePath)
      if (!info.isFile()) return null
      return {
        body: localFetchedBody(filePath),
        contentType: contentTypeForKey(key),
        contentLength: info.size,
      }
    } catch {
      return null
    }
  }

  const { bucket, region } = requireConfig()
  try {
    const result = await getClient(region).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    )

    return {
      body: result.Body,
      contentType: result.ContentType || contentTypeForKey(key),
      contentLength: result.ContentLength,
      etag: result.ETag,
    }
  } catch (error) {
    const name = (error as { name?: string })?.name
    if (name === "NoSuchKey" || name === "NotFound") return null
    throw error
  }
}

/** Test seam: forces the next call to build a fresh client. */
export function resetImageStorageClientForTests(): void {
  s3Client = null
  s3ClientRegion = null
  resolvedConfig = null
}

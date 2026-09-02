import { describe, expect, it } from 'vitest'

import { parseImageStorageEnv } from './env-validation'

import {
  buildImageKey,
  contentTypeForKey,
  extensionForMime,
  imagePathForKey,
  isDataUrl,
  isStoredImagePath,
  isValidImageKey,
  parseDataUrl,
} from './image-storage'

describe('image key generation', () => {
  it('produces keys that satisfy its own validator', () => {
    for (const extension of ['jpg', 'png', 'gif', 'webp'] as const) {
      const key = buildImageKey(extension)
      expect(isValidImageKey(key)).toBe(true)
      expect(key.startsWith('products/')).toBe(true)
      expect(key.endsWith(`.${extension}`)).toBe(true)
    }
  })

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 200 }, () => buildImageKey('png')))
    expect(keys.size).toBe(200)
  })
})

describe('image key validation', () => {
  it('rejects traversal and prefix escapes', () => {
    const hostile = [
      'products/../../etc/passwd',
      '../products/a.png',
      'products/..%2F..%2Fsecret.png',
      'other-prefix/11111111-1111-1111-1111-111111111111.png',
      'products/11111111-1111-1111-1111-111111111111.png/../../x',
      '/products/11111111-1111-1111-1111-111111111111.png',
      'products//11111111-1111-1111-1111-111111111111.png',
    ]
    for (const key of hostile) {
      expect(isValidImageKey(key), key).toBe(false)
    }
  })

  it('rejects unsupported extensions and malformed uuids', () => {
    expect(isValidImageKey('products/11111111-1111-1111-1111-111111111111.svg')).toBe(false)
    expect(isValidImageKey('products/11111111-1111-1111-1111-111111111111.html')).toBe(false)
    expect(isValidImageKey('products/not-a-uuid.png')).toBe(false)
    expect(isValidImageKey('products/11111111-1111-1111-1111-11111111111.png')).toBe(false)
    expect(isValidImageKey('products/ZZZZZZZZ-1111-1111-1111-111111111111.png')).toBe(false)
  })

  it('accepts a well formed key', () => {
    expect(isValidImageKey('products/11111111-1111-1111-1111-111111111111.png')).toBe(true)
  })
})

describe('stored value shapes', () => {
  const key = 'products/11111111-1111-1111-1111-111111111111.png'

  it('round-trips a key through its application path', () => {
    const path = imagePathForKey(key)
    expect(path).toBe(`/api/v1/images/${key}`)
    expect(isStoredImagePath(path)).toBe(true)
  })

  it('distinguishes legacy data URLs from stored paths', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    expect(isDataUrl(dataUrl)).toBe(true)
    expect(isStoredImagePath(dataUrl)).toBe(false)

    expect(isDataUrl(imagePathForKey(key))).toBe(false)
    expect(isStoredImagePath(imagePathForKey(key))).toBe(true)
  })

  it('does not treat an arbitrary path as stored', () => {
    expect(isStoredImagePath('/api/v1/images/products/../../secret')).toBe(false)
    expect(isStoredImagePath('/placeholder.jpg')).toBe(false)
    expect(isStoredImagePath('https://example.test/image.png')).toBe(false)
    expect(isStoredImagePath(null)).toBe(false)
    expect(isStoredImagePath(undefined)).toBe(false)
  })
})

describe('mime handling', () => {
  it('maps supported mimes to extensions', () => {
    expect(extensionForMime('image/jpeg')).toBe('jpg')
    expect(extensionForMime('IMAGE/PNG')).toBe('png')
    expect(extensionForMime('image/gif')).toBe('gif')
    expect(extensionForMime('image/webp')).toBe('webp')
  })

  it('refuses types the sanitizer does not produce', () => {
    expect(extensionForMime('image/svg+xml')).toBeNull()
    expect(extensionForMime('text/html')).toBeNull()
    expect(extensionForMime('application/octet-stream')).toBeNull()
  })

  it('derives a content type from a key', () => {
    expect(contentTypeForKey('products/11111111-1111-1111-1111-111111111111.jpg')).toBe('image/jpeg')
    expect(contentTypeForKey('products/11111111-1111-1111-1111-111111111111.webp')).toBe('image/webp')
  })
})

describe('parseDataUrl', () => {
  const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  it('extracts bytes and mime from a base64 data URL', () => {
    const parsed = parseDataUrl(`data:image/png;base64,${pngBytes.toString('base64')}`)
    expect(parsed).not.toBeNull()
    expect(parsed!.mime).toBe('image/png')
    expect(parsed!.buffer.equals(pngBytes)).toBe(true)
  })

  it('refuses non-image and non-base64 data URLs', () => {
    expect(parseDataUrl('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(parseDataUrl('data:image/png,notbase64')).toBeNull()
    expect(parseDataUrl('https://example.test/a.png')).toBeNull()
  })

  it('refuses an empty payload', () => {
    expect(parseDataUrl('data:image/png;base64,')).toBeNull()
  })
})

describe('region resolution', () => {
  const bucket = 'oneflowe-uploads-000000000000'

  it('prefers S3_UPLOADS_REGION over AWS_REGION', () => {
    // SES and S3 legitimately live in different regions.
    const parsed = parseImageStorageEnv({
      AWS_REGION: 'eu-central-1',
      S3_UPLOADS_REGION: 'ap-southeast-1',
      S3_UPLOADS_BUCKET: bucket,
    })
    expect(parsed.region).toBe('ap-southeast-1')
    expect(parsed.bucket).toBe(bucket)
  })

  it('falls back to AWS_REGION when no override is set', () => {
    const parsed = parseImageStorageEnv({
      AWS_REGION: 'ap-southeast-1',
      S3_UPLOADS_BUCKET: bucket,
    })
    expect(parsed.region).toBe('ap-southeast-1')
  })

  it('requires a region from one source or the other', () => {
    expect(() => parseImageStorageEnv({ S3_UPLOADS_BUCKET: bucket })).toThrow(
      /S3_UPLOADS_REGION/,
    )
  })

  it('rejects a malformed region', () => {
    expect(() =>
      parseImageStorageEnv({ S3_UPLOADS_REGION: 'not-a-region', S3_UPLOADS_BUCKET: bucket }),
    ).toThrow(/region/i)
  })

  it('requires a bucket', () => {
    expect(() => parseImageStorageEnv({ AWS_REGION: 'ap-southeast-1' })).toThrow(
      /S3_UPLOADS_BUCKET/,
    )
  })
})

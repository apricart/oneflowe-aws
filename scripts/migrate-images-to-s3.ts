/**
 * Moves base64 `data:` images out of the database and into S3.
 *
 * Each row is uploaded first and only then rewritten to point at the new
 * object, so an interrupted run leaves the row still rendering from its data
 * URL. Re-running skips whatever already moved, which makes the script safe to
 * run repeatedly and in batches against production.
 *
 *   npm run migrate:images-to-s3 -- --dry-run
 *   npm run migrate:images-to-s3 -- --limit=100
 *   npm run migrate:images-to-s3
 */
import { eq, like } from 'drizzle-orm'

import { globalProducts, organizationInventory, organizationProducts } from '@/db/schema'
import { closePool, db } from '@/lib/db-cli'
import {
  buildImageKey,
  extensionForMime,
  imagePathForKey,
  isImageStorageConfigured,
  parseDataUrl,
  putImage,
} from '@/lib/server/image-storage'

type Target = {
  label: string
  table: typeof globalProducts | typeof organizationProducts | typeof organizationInventory
  column: any
  idColumn: any
  field: 'imageUrl' | 'customImageUrl'
}

const TARGETS: Target[] = [
  {
    label: 'globalProducts.imageUrl',
    table: globalProducts,
    column: globalProducts.imageUrl,
    idColumn: globalProducts.id,
    field: 'imageUrl',
  },
  {
    label: 'organizationProducts.customImageUrl',
    table: organizationProducts,
    column: organizationProducts.customImageUrl,
    idColumn: organizationProducts.id,
    field: 'customImageUrl',
  },
  {
    label: 'organizationInventory.customImageUrl',
    table: organizationInventory,
    column: organizationInventory.customImageUrl,
    idColumn: organizationInventory.id,
    field: 'customImageUrl',
  },
]

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run')
  const limitArg = argv.find((arg) => arg.startsWith('--limit='))
  const limit = limitArg ? Number.parseInt(limitArg.slice('--limit='.length), 10) : undefined

  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('--limit must be a positive integer')
  }

  return { dryRun, limit }
}

async function migrateTarget(target: Target, options: { dryRun: boolean; limit?: number }) {
  const rows = await db
    .select({ id: target.idColumn, value: target.column })
    .from(target.table as any)
    .where(like(target.column, 'data:%'))
    .limit(options.limit ?? 1_000_000)

  let migrated = 0
  let skipped = 0
  let bytesFreed = 0

  for (const row of rows) {
    const value = row.value as string | null
    if (!value) continue

    const parsed = parseDataUrl(value)
    if (!parsed) {
      console.warn(`  ! ${target.label} id=${row.id}: unrecognised data URL, left as is`)
      skipped += 1
      continue
    }

    const extension = extensionForMime(parsed.mime)
    if (!extension) {
      console.warn(`  ! ${target.label} id=${row.id}: unsupported type ${parsed.mime}, left as is`)
      skipped += 1
      continue
    }

    const key = buildImageKey(extension)

    if (options.dryRun) {
      console.log(`  · ${target.label} id=${row.id} -> ${key} (${parsed.buffer.length} bytes)`)
      migrated += 1
      bytesFreed += value.length
      continue
    }

    // Upload before the update: if this throws, the row still has its data URL.
    await putImage({ key, body: parsed.buffer, contentType: parsed.mime })

    await db
      .update(target.table as any)
      .set({ [target.field]: imagePathForKey(key) })
      .where(eq(target.idColumn, row.id))

    migrated += 1
    bytesFreed += value.length
    console.log(`  ✓ ${target.label} id=${row.id} -> ${imagePathForKey(key)}`)
  }

  return { migrated, skipped, bytesFreed, total: rows.length }
}

async function main() {
  const { dryRun, limit } = parseArgs(process.argv.slice(2))

  if (!isImageStorageConfigured()) {
    throw new Error(
      'Set S3_UPLOADS_BUCKET and S3_UPLOADS_REGION (or AWS_REGION) before running this migration',
    )
  }

  console.log(dryRun ? 'DRY RUN - nothing will be written\n' : 'Migrating base64 images to S3\n')

  let totalMigrated = 0
  let totalSkipped = 0
  let totalBytes = 0

  for (const target of TARGETS) {
    console.log(`${target.label}:`)
    const result = await migrateTarget(target, { dryRun, limit })
    if (result.total === 0) {
      console.log('  (no data URLs found)')
    }
    totalMigrated += result.migrated
    totalSkipped += result.skipped
    totalBytes += result.bytesFreed
    console.log('')
  }

  const megabytes = (totalBytes / 1024 / 1024).toFixed(2)
  console.log(`${dryRun ? 'Would migrate' : 'Migrated'}: ${totalMigrated} image(s)`)
  if (totalSkipped > 0) console.log(`Skipped: ${totalSkipped} row(s) - see warnings above`)
  console.log(`Database text reclaimed: ~${megabytes} MB`)
  if (!dryRun && totalMigrated > 0) {
    console.log('\nRun VACUUM FULL on the affected tables to return the space to disk.')
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })

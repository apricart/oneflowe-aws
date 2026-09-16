/**
 * What the item-list scripts (`assign:ke-group-catalogue`,
 * `restrict:ke-catalogue`) read and check in common: the list itself, the
 * organization the run is aimed at, the person it is attributed to, and the
 * organization's mapped catalogue and branch rows in the shapes the planners
 * take. Plain `pg` queries against `lib/db-cli`, as the sync uses.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import * as XLSX from "xlsx"

import type { CurrentBranchAssignment } from "../../lib/legacy-import/ke-branch-catalogue"
import type { MappedProduct, WantedProduct } from "../../lib/legacy-import/ke-group-catalogue"
import { KE_SYNC_SOURCE as SOURCE_SYSTEM } from "../../lib/legacy-import/ke-sync"

export type Row = Record<string, unknown>

export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>
}

export interface TargetOrganization {
  id: number
  code: string
  name: string
}

const LIST_COLUMN = "Item"

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

export function argument(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

export async function rows<T extends Row = Row>(client: QueryClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export function organizationConfirmation(organization: TargetOrganization): string {
  return `${organization.id}:${organization.code}:${organization.name}`
}

function normalizeOrgName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

export function writeReport(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
}

/** The list, one line per row of the first worksheet's `Item` column. */
export function loadList(path: string): { lines: WantedProduct[]; sha256: string } {
  assert(existsSync(path), `List not found: ${path}`)
  const buffer = readFileSync(path)
  const workbook = XLSX.read(buffer, { type: "buffer" })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  assert(sheet, "The list has no worksheet")
  const sheetRows = XLSX.utils.sheet_to_json<Row>(sheet, { defval: "" })
  assert(sheetRows.length > 0 && LIST_COLUMN in sheetRows[0], `The list has no "${LIST_COLUMN}" column`)
  const lines = sheetRows
    .map((row) => String(row[LIST_COLUMN] ?? "").trim())
    .filter(Boolean)
    .map((sourceName): WantedProduct => ({ sourceName }))
  assert(lines.length > 0, "The list is empty")
  return { lines, sha256: sha256(buffer) }
}

/** The organization the code names, refused if it is not the tenant expected. */
export async function resolveOrganization(
  client: QueryClient,
  options: { organizationCode: string; organizationName: string },
): Promise<TargetOrganization> {
  const [existing] = await rows(client,
    `select id, code, name from organizations where code = $1`, [options.organizationCode])
  assert(existing, `No organization with code "${options.organizationCode}"`)
  const organization = { id: Number(existing.id), code: String(existing.code), name: String(existing.name) }
  assert(
    normalizeOrgName(organization.name) === normalizeOrgName(options.organizationName),
    `Organization code ${options.organizationCode} belongs to "${organization.name}", not `
      + `"${options.organizationName}". Refusing to write K-Electric data into another tenant.`,
  )
  return organization
}

/** The organization exactly as a report names it, or nothing. */
export async function assertOrganization(client: QueryClient, expected: TargetOrganization): Promise<void> {
  const [organization] = await rows(client,
    `select id, code, name from organizations where id = $1`, [expected.id])
  assert(organization, `organization ${expected.id} does not exist in this database`)
  assert(
    String(organization.code) === expected.code && String(organization.name) === expected.name,
    `organization ${expected.id} is ${String(organization.code)}:${String(organization.name)}, `
      + `not ${expected.code}:${expected.name} as the report says; refusing`,
  )
}

export async function assertActor(client: QueryClient, actorUserId: string | undefined): Promise<string> {
  assert(actorUserId, "Commit requires --actor-user-id=<active-super-admin-uuid>")
  const [actor] = await rows(client,
    `select u.id from users u join roles r on r.id = u.role_id
      where u.id = $1 and r.name = 'SUPER_ADMIN' and u.is_active = true and u.deleted_at is null`,
    [actorUserId])
  assert(actor, "--actor-user-id must be an active SUPER_ADMIN")
  return actorUserId
}

/** The legacy-mapped catalogue, with the state the shop listing checks. */
export async function readMappedProducts(client: QueryClient, organizationId: number): Promise<MappedProduct[]> {
  return (await rows(client,
    `select lpm.normalized_name, lpm.global_product_id, lpm.organization_inventory_id, gp.name,
            (oi.is_active and oi.deleted_at is null) as organization_inventory_active,
            (gp.status = 'active' and gp.deleted_at is null) as product_active,
            gp.stock_quantity
       from legacy_product_mappings lpm
       join organization_inventory oi on oi.id = lpm.organization_inventory_id and oi.organization_id = lpm.organization_id
       join global_products gp on gp.id = lpm.global_product_id
      where lpm.organization_id = $1 and lpm.source_system = $2
      order by lpm.normalized_name`, [organizationId, SOURCE_SYSTEM]))
    .map((row): MappedProduct => ({
      normalizedName: String(row.normalized_name),
      globalProductId: Number(row.global_product_id),
      productName: String(row.name),
      organizationInventoryId: Number(row.organization_inventory_id),
      organizationInventoryActive: Boolean(row.organization_inventory_active),
      productActive: Boolean(row.product_active),
      stockQuantity: Number(row.stock_quantity ?? 0),
    }))
}

/** Every branch row of the organization, whatever its state. */
export async function readBranchAssignments(client: QueryClient, organizationId: number): Promise<CurrentBranchAssignment[]> {
  return (await rows(client,
    `select branch_id, organization_inventory_id, is_visible, is_active, deleted_at
       from branch_inventory where organization_id = $1
      order by branch_id, organization_inventory_id`, [organizationId]))
    .map((row): CurrentBranchAssignment => ({
      branchId: Number(row.branch_id),
      organizationInventoryId: Number(row.organization_inventory_id),
      isVisible: Boolean(row.is_visible),
      isActive: Boolean(row.is_active),
      deleted: row.deleted_at !== null && row.deleted_at !== undefined,
    }))
}

import "server-only"

import { and, asc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm"

import {
  apricartExecutiveAssignments,
  emailOutbox,
  notifications,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import { sendPriceContractReminderEmail } from "@/lib/email/price-contract"
import { APRICART_EXECUTIVE_ROLE } from "@/lib/apricart-executive-access"
import {
  PRICE_CONTRACT_EXPIRING_TEMPLATE,
  karachiCalendarDay,
  parsePriceContractReminderPayload,
  priceContractDaysLeft,
  priceContractReminderCopy,
  priceContractReminderEventKey,
  priceContractReminderHorizon,
  type PriceContractReminderPayload,
} from "@/lib/price-contract-validity"
import { isValidEmailAddress } from "@/lib/validation/email"
import { loadExecutiveApprovalReach } from "@/lib/server/apricart-executive-scope"
import {
  markFailedAttempt,
  markSent,
  markSkipped,
  type ClaimedOutboxRow,
  type DeliveryOutcome,
} from "@/lib/server/email-outbox-runtime"

/**
 * Reminding Apricart that an organization's price contract is running out
 * (plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
 *
 * A reminder only. Nothing here, and nothing that reads
 * `organizations.price_contract_valid_until`, changes what a customer may
 * order or is charged.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

const SUPER_ADMIN_ROLE = "SUPER_ADMIN"

/** Bounds on one sweep and one alert read. Real tenants number in the dozens. */
const MAX_ORGANIZATIONS = 200

/** A row without its contract date, for every reader but Super Admin. */
export function withoutPriceContractValidity<T extends { priceContractValidUntil?: unknown }>(
  row: T,
): Omit<T, "priceContractValidUntil"> {
  const { priceContractValidUntil: _withheld, ...rest } = row
  return rest
}

type ContractOrganization = {
  id: number
  name: string
  code: string | null
  validUntil: string
}

/** Active organizations whose contract's last day is on or before `horizon` (and on or after `from`, when given). */
async function loadDatedOrganizations(
  client: DbClient,
  input: { from?: string; horizon: string; organizationIds?: readonly number[] },
): Promise<ContractOrganization[]> {
  if (input.organizationIds?.length === 0) return []
  const rows = await client
    .select({
      id: organizations.id,
      name: organizations.name,
      code: organizations.code,
      validUntil: organizations.priceContractValidUntil,
    })
    .from(organizations)
    .where(and(
      eq(organizations.status, "active"),
      isNotNull(organizations.priceContractValidUntil),
      lte(organizations.priceContractValidUntil, input.horizon),
      input.from === undefined ? undefined : gte(organizations.priceContractValidUntil, input.from),
      input.organizationIds === undefined ? undefined : inArray(organizations.id, [...input.organizationIds]),
    ))
    .orderBy(asc(organizations.priceContractValidUntil), asc(organizations.name))
    .limit(MAX_ORGANIZATIONS)
  return rows.flatMap((row) => (row.validUntil ? [{ ...row, validUntil: row.validUntil }] : []))
}

/** Contracts in their reminder window today: from today through `PRICE_CONTRACT_REMINDER_DAYS` ahead. */
export async function findDuePriceContractOrganizations(client: DbClient, now: Date): Promise<ContractOrganization[]> {
  const today = karachiCalendarDay(now)
  return loadDatedOrganizations(client, { from: today, horizon: priceContractReminderHorizon(today) })
}

type Recipient = { id: string; email: string; role: typeof SUPER_ADMIN_ROLE | typeof APRICART_EXECUTIVE_ROLE }

async function loadSuperAdminRecipients(client: DbClient): Promise<Recipient[]> {
  const rows = await client
    .select({ id: users.id, email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(roles.name, SUPER_ADMIN_ROLE), eq(users.isActive, true), isNull(users.deletedAt)))
  return rows.map((row) => ({ ...row, role: SUPER_ADMIN_ROLE }))
}

/** Active executives assigned to each organization, keyed by organization. */
async function loadAssignedExecutives(
  client: DbClient,
  organizationIds: readonly number[],
): Promise<Map<number, Recipient[]>> {
  const byOrganization = new Map<number, Recipient[]>()
  if (organizationIds.length === 0) return byOrganization
  const rows = await client
    .select({ organizationId: apricartExecutiveAssignments.organizationId, id: users.id, email: users.email })
    .from(apricartExecutiveAssignments)
    .innerJoin(users, eq(apricartExecutiveAssignments.userId, users.id))
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      inArray(apricartExecutiveAssignments.organizationId, [...organizationIds]),
      eq(roles.name, APRICART_EXECUTIVE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
  for (const row of rows) {
    const list = byOrganization.get(row.organizationId) ?? []
    list.push({ id: row.id, email: row.email, role: APRICART_EXECUTIVE_ROLE })
    byOrganization.set(row.organizationId, list)
  }
  return byOrganization
}

export type QueuedPriceContractReminders = {
  organizationCount: number
  /** Outbox keys inserted by this call — the ones still to send. */
  eventKeys: string[]
}

/**
 * Queue the reminder for every contract in its window: a bell notice for each
 * Super Admin, and an email for each Super Admin and each executive assigned
 * to the organization. One event per organization, date and recipient, all
 * `ON CONFLICT DO NOTHING`, so this is safe to call any number of times — the
 * daily sweep and every alert read do — and a changed date re-arms it.
 */
export async function queueDuePriceContractReminders(client: DbClient, now: Date): Promise<QueuedPriceContractReminders> {
  const due = await findDuePriceContractOrganizations(client, now)
  if (due.length === 0) return { organizationCount: 0, eventKeys: [] }

  const today = karachiCalendarDay(now)
  const superAdmins = await loadSuperAdminRecipients(client)
  const executives = await loadAssignedExecutives(client, due.map((organization) => organization.id))
  const eventKeys: string[] = []

  for (const organization of due) {
    const payload: PriceContractReminderPayload = {
      organizationId: organization.id,
      organizationName: organization.name,
      organizationCode: organization.code,
      validUntil: organization.validUntil,
    }
    const { message } = priceContractReminderCopy(payload, priceContractDaysLeft(organization.validUntil, today))
    const recipients = [...superAdmins, ...(executives.get(organization.id) ?? [])]
    const keyed = recipients.map((recipient) => ({
      recipient,
      eventKey: priceContractReminderEventKey({
        organizationId: organization.id,
        validUntil: organization.validUntil,
        recipientUserId: recipient.id,
      }),
    }))

    // Only Super Admin has a bell; an executive's in-app notice is the alert on its workspace.
    const bellRows = keyed.filter(({ recipient }) => recipient.role === SUPER_ADMIN_ROLE)
    if (bellRows.length > 0) {
      await client.insert(notifications).values(bellRows.map(({ recipient, eventKey }) => ({
        userId: recipient.id,
        organizationId: organization.id,
        eventKey,
        type: PRICE_CONTRACT_EXPIRING_TEMPLATE,
        targetRole: recipient.role,
        message,
      }))).onConflictDoNothing()
    }

    const mailRows = keyed.filter(({ recipient }) => isValidEmailAddress(recipient.email))
    if (mailRows.length > 0) {
      const inserted = await client.insert(emailOutbox).values(mailRows.map(({ recipient, eventKey }) => ({
        eventKey,
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        organizationId: organization.id,
        template: PRICE_CONTRACT_EXPIRING_TEMPLATE,
        payload,
      }))).onConflictDoNothing().returning({ eventKey: emailOutbox.eventKey })
      eventKeys.push(...inserted.map((row) => row.eventKey))
    }
  }

  return { organizationCount: due.length, eventKeys }
}

// ---------------------------------------------------------------------------
// The dashboard alert
// ---------------------------------------------------------------------------

export type PriceContractAlertViewer = { role: string; userId: string }

export type PriceContractAlertItem = {
  organizationId: number
  name: string
  code: string | null
  validUntil: string
  daysLeft: number
  status: "expiring" | "expired"
}

/**
 * Contracts expired or in their last `PRICE_CONTRACT_REMINDER_DAYS`, in the
 * viewer's reach: every organization for Super Admin, the organizations it is
 * assigned for an executive (re-read, active account only). Expired first,
 * then soonest. Null for any other role.
 */
export async function loadPriceContractAlerts(
  client: DbClient,
  viewer: PriceContractAlertViewer,
  now: Date,
): Promise<PriceContractAlertItem[] | null> {
  let organizationIds: number[] | undefined
  if (viewer.role === APRICART_EXECUTIVE_ROLE) {
    organizationIds = await loadExecutiveApprovalReach(client, viewer.userId)
  } else if (viewer.role !== SUPER_ADMIN_ROLE) {
    return null
  }

  const today = karachiCalendarDay(now)
  const rows = await loadDatedOrganizations(client, { horizon: priceContractReminderHorizon(today), organizationIds })
  return rows.map((row) => {
    const daysLeft = priceContractDaysLeft(row.validUntil, today)
    return {
      organizationId: row.id,
      name: row.name,
      code: row.code,
      validUntil: row.validUntil,
      daysLeft,
      status: daysLeft < 0 ? "expired" : "expiring",
    }
  })
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export function isPriceContractEmailTemplate(template: string): boolean {
  return template === PRICE_CONTRACT_EXPIRING_TEMPLATE
}

/** Whether the recipient is still an active account of the role it was queued for, and an executive still assigned. */
async function recipientStillReminded(row: ClaimedOutboxRow): Promise<string | null> {
  const [account] = await db
    .select({ email: users.email })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, row.recipientUserId),
      eq(roles.name, row.recipientRole),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)
  if (!account) return null
  if (row.recipientRole === SUPER_ADMIN_ROLE) return account.email
  if (row.recipientRole !== APRICART_EXECUTIVE_ROLE) return null
  const reach = await loadExecutiveApprovalReach(db, row.recipientUserId, { organizationId: row.organizationId })
  return reach.includes(row.organizationId) ? account.email : null
}

/**
 * Send one claimed reminder, or retire it when it no longer applies: the
 * recipient is no longer reminded, the organization is no longer active, its
 * contract date changed since it was queued, or that date has passed.
 */
export async function deliverClaimedPriceContractEmail(row: ClaimedOutboxRow, now: Date = new Date()): Promise<DeliveryOutcome> {
  const payload = parsePriceContractReminderPayload(row.payload)
  if (!isPriceContractEmailTemplate(row.template) || !payload || payload.organizationId !== row.organizationId) {
    await markSkipped(row.id, "Invalid price contract email template or payload")
    return "skipped"
  }

  const [organization] = await db
    .select({ status: organizations.status, validUntil: organizations.priceContractValidUntil })
    .from(organizations)
    .where(eq(organizations.id, row.organizationId))
    .limit(1)
  const daysLeft = priceContractDaysLeft(payload.validUntil, karachiCalendarDay(now))
  if (organization?.status !== "active" || organization.validUntil !== payload.validUntil || daysLeft < 0) {
    await markSkipped(row.id, "Price contract reminder no longer applies")
    return "skipped"
  }

  const email = await recipientStillReminded(row)
  if (!email || !isValidEmailAddress(email)) {
    await markSkipped(row.id, "Recipient is no longer reminded about this organization")
    return "skipped"
  }

  try {
    const providerMessageId = await sendPriceContractReminderEmail({ to: email, payload, daysLeft })
    await markSent(row.id, { recipientEmail: email, providerMessageId })
    return "sent"
  } catch (error) {
    return markFailedAttempt(row, error)
  }
}

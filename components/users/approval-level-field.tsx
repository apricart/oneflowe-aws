"use client"

import useSWR from "swr"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { jsonFetcher } from "@/lib/fetcher"
import {
  canHoldApprovalLevel,
  formatApprovalLevelAmount,
  type ApprovalLevel,
} from "@/lib/order-approval-levels"

/**
 * "Approval level" on Create / Edit User
 * (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
 *
 * Offered only to a role that decides the organization's orders, and only while
 * the organization requires order approval and has approval levels on —
 * `canHoldApprovalLevel`, the rule the server applies to every write. Hiding it
 * is presentation: `PUT /api/v1/users/[id]/approval-level` and user creation
 * refuse a level the role or organization does not admit.
 */

/** The roles that can ever hold a level; anything else is not even looked up. */
const ROLES_THAT_MAY_HOLD_A_LEVEL = new Set(["GROUP_USER", "BRANCH_ADMIN", "HEAD_OFFICE"])

const NO_LEVEL = "none"

type ApprovalLevelsResponse = {
  enabled: boolean
  orderApprovalRequired: boolean
  orderApproverRole: string | null
  levels: ApprovalLevel[]
}

export type ApprovalLevelChoice = {
  /** Whether a level may be chosen for this role in this organization. */
  applicable: boolean
  levels: ApprovalLevel[]
}

/** What the field may offer for `role` in `organizationId` (form values, as strings). */
export function useApprovalLevelChoice(organizationId: string, role: string): ApprovalLevelChoice {
  const lookUp = Boolean(organizationId) && ROLES_THAT_MAY_HOLD_A_LEVEL.has(role)
  const { data } = useSWR<ApprovalLevelsResponse>(
    lookUp ? `/api/v1/organizations/${organizationId}/approval-levels` : null,
    jsonFetcher,
  )
  if (!lookUp || !data || !Array.isArray(data.levels)) return { applicable: false, levels: [] }

  const applicable = data.levels.length > 0 && canHoldApprovalLevel(role, {
    orderApprovalRequired: data.orderApprovalRequired === true,
    orderApprovalLevelsEnabled: data.enabled === true,
    orderApproverRole: data.orderApproverRole ?? null,
  })
  return { applicable, levels: applicable ? data.levels : [] }
}

/** The form value ("" = no level) as the request sends it. */
export function approvalLevelPayload(value: string): number | null {
  return value ? Number(value) : null
}

export function ApprovalLevelField({
  id,
  choice,
  value,
  onChange,
  disabled = false,
}: Readonly<{
  id: string
  choice: ApprovalLevelChoice
  /** "" for no level, otherwise the level number as text. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}>) {
  if (!choice.applicable) return null

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Approval level (optional)</Label>
      <Select
        value={value || NO_LEVEL}
        onValueChange={(next) => onChange(next === NO_LEVEL ? "" : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder="No level" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_LEVEL}>No level</SelectItem>
          {choice.levels.map((level) => (
            <SelectItem key={level.level} value={String(level.level)}>
              Level {level.level} — orders from {formatApprovalLevelAmount(level.maxAmountCents)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Level 1 is the highest. Users are assigned now; orders start following these levels in a later step.
      </p>
    </div>
  )
}

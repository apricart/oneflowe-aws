"use client"

import { Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_OPERATIONS,
  ACTIVITY_SEARCH_MAX_LENGTH,
  ACTIVITY_SOURCES,
  type ActivityActorRole,
  type ActivityCategory,
  type ActivityOperation,
  type ActivitySource,
} from "@/lib/activity-log"
import {
  ACTOR_ROLE_LABEL,
  OPERATION_LABEL,
  WINDOW_PRESETS,
  actorRoleOptions,
  type WindowPresetId,
} from "@/lib/activity-log-view"

/**
 * The filter bar.
 *
 * Every control is labelled, and the active filters are repeated below as
 * removable chips: on a screen whose whole purpose is "what am I not seeing",
 * a filter left on by accident is the failure mode worth designing against.
 */

export type ActivityFilterState = {
  preset: WindowPresetId
  /** `yyyy-MM-dd`, only read when `preset` is `custom`. */
  customFrom: string
  customTo: string
  source: ActivitySource | "all"
  operation: ActivityOperation | "all"
  category: ActivityCategory | "all"
  role: ActivityActorRole | "all"
  outcome: "all" | "success" | "failure"
  search: string
}

export const EMPTY_FILTERS: ActivityFilterState = {
  preset: "7d",
  customFrom: "",
  customTo: "",
  source: "all",
  operation: "all",
  category: "all",
  role: "all",
  outcome: "all",
  search: "",
}

const SOURCE_LABEL: Readonly<Record<ActivitySource, string>> = {
  audit: "Business changes",
  system: "Sign-ins & system",
  group: "Group operations",
}

/** The chips shown beneath the controls. Pure, so the screen's test can assert on it. */
export function activeFilterChips(
  filters: ActivityFilterState,
): { key: keyof ActivityFilterState; label: string }[] {
  const chips: { key: keyof ActivityFilterState; label: string }[] = []
  if (filters.source !== "all") chips.push({ key: "source", label: `Source: ${SOURCE_LABEL[filters.source]}` })
  if (filters.operation !== "all") {
    chips.push({ key: "operation", label: `Operation: ${OPERATION_LABEL[filters.operation]}` })
  }
  if (filters.category !== "all") chips.push({ key: "category", label: `Area: ${filters.category}` })
  if (filters.role !== "all") {
    chips.push({ key: "role", label: `Role: ${ACTOR_ROLE_LABEL[filters.role]}` })
  }
  if (filters.outcome !== "all") chips.push({ key: "outcome", label: `Outcome: ${filters.outcome}` })
  if (filters.search.trim().length > 0) chips.push({ key: "search", label: `Search: ${filters.search.trim()}` })
  return chips
}

type Props = Readonly<{
  filters: ActivityFilterState
  onChange: (next: ActivityFilterState) => void
  disabled?: boolean
  /** Which role options to offer. Presentation only — the endpoint fences the rows. */
  platformWide?: boolean
}>

export function ActivityLogFilters({ filters, onChange, disabled, platformWide = false }: Props) {
  const set = <K extends keyof ActivityFilterState>(key: K, value: ActivityFilterState[K]) =>
    onChange({ ...filters, [key]: value })

  const chips = activeFilterChips(filters)

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <div className="space-y-1.5">
          <Label htmlFor="activity-window" className="text-xs font-semibold">
            Period
          </Label>
          <Select
            value={filters.preset}
            onValueChange={(value) => set("preset", value as WindowPresetId)}
            disabled={disabled}
          >
            <SelectTrigger id="activity-window" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_PRESETS.map((preset) => (
                <SelectItem key={preset.id} value={preset.id}>
                  {preset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filters.preset === "custom" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="activity-from" className="text-xs font-semibold">
                From
              </Label>
              <Input
                id="activity-from"
                type="date"
                className="h-9"
                value={filters.customFrom}
                onChange={(event) => set("customFrom", event.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="activity-to" className="text-xs font-semibold">
                To
              </Label>
              <Input
                id="activity-to"
                type="date"
                className="h-9"
                value={filters.customTo}
                onChange={(event) => set("customTo", event.target.value)}
                disabled={disabled}
              />
            </div>
          </>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="activity-source" className="text-xs font-semibold">
            Source
          </Label>
          <Select
            value={filters.source}
            onValueChange={(value) => set("source", value as ActivitySource | "all")}
            disabled={disabled}
          >
            <SelectTrigger id="activity-source" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {ACTIVITY_SOURCES.map((source) => (
                <SelectItem key={source} value={source}>
                  {SOURCE_LABEL[source]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="activity-operation" className="text-xs font-semibold">
            Operation
          </Label>
          <Select
            value={filters.operation}
            onValueChange={(value) => set("operation", value as ActivityOperation | "all")}
            disabled={disabled}
          >
            <SelectTrigger id="activity-operation" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All operations</SelectItem>
              {ACTIVITY_OPERATIONS.map((operation) => (
                <SelectItem key={operation} value={operation}>
                  {OPERATION_LABEL[operation]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="activity-category" className="text-xs font-semibold">
            Area
          </Label>
          <Select
            value={filters.category}
            onValueChange={(value) => set("category", value as ActivityCategory | "all")}
            disabled={disabled}
          >
            <SelectTrigger id="activity-category" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {ACTIVITY_CATEGORIES.map((category) => (
                <SelectItem key={category} value={category} className="capitalize">
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="activity-role" className="text-xs font-semibold">
            Role
          </Label>
          <Select
            value={filters.role}
            onValueChange={(value) => set("role", value as ActivityActorRole | "all")}
            disabled={disabled}
          >
            <SelectTrigger id="activity-role" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {actorRoleOptions(platformWide).map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="activity-outcome" className="text-xs font-semibold">
            Outcome
          </Label>
          <Select
            value={filters.outcome}
            onValueChange={(value) => set("outcome", value as ActivityFilterState["outcome"])}
            disabled={disabled}
          >
            <SelectTrigger id="activity-outcome" className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any outcome</SelectItem>
              <SelectItem value="success">Succeeded</SelectItem>
              <SelectItem value="failure">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
          <Label htmlFor="activity-search" className="text-xs font-semibold">
            Search
          </Label>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="activity-search"
              className="h-9 pl-9"
              placeholder="Person, action, or record id"
              maxLength={ACTIVITY_SEARCH_MAX_LENGTH}
              value={filters.search}
              onChange={(event) => set("search", event.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Filtering by</span>
          {chips.map((chip) => (
            <Badge key={chip.key} variant="outline" className="gap-1 py-1 pl-2.5 pr-1 font-medium">
              {chip.label}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-4 w-4 rounded-full p-0 hover:bg-destructive/10"
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => set(chip.key, EMPTY_FILTERS[chip.key])}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </Button>
            </Badge>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => onChange({ ...EMPTY_FILTERS, preset: filters.preset })}
          >
            Clear all
          </Button>
        </div>
      ) : null}
    </div>
  )
}

"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  MAX_ALLOWLIST_ENTRIES,
  parseAllowlistEntry,
} from "@/lib/security/ip-allowlist"
import { Plus, Trash2 } from "lucide-react"

export type PrivateNetworkEntryDraft = {
  key: string
  value: string
  label: string
}

let draftSequence = 0

export function createNetworkEntryDraft(
  value = "",
  label = "",
): PrivateNetworkEntryDraft {
  draftSequence += 1
  return { key: `network-entry-${draftSequence}`, value, label }
}

/**
 * The same parser the API and the login check use, so the dialog can never
 * accept an address the server would reject or read differently.
 */
export function isValidNetworkEntryValue(value: string): boolean {
  return parseAllowlistEntry(value) !== null
}

/**
 * Why the current draft cannot be saved, or null when it is valid. Enabling
 * with no usable address would lock every member out of the organization.
 */
export function privateNetworkDraftError(
  enabled: boolean,
  entries: readonly PrivateNetworkEntryDraft[],
): string | null {
  if (!enabled) return null

  const filled = entries.filter((entry) => entry.value.trim().length > 0)
  if (filled.length === 0) {
    return "Add at least one IP address before enabling private network login."
  }
  if (filled.some((entry) => !isValidNetworkEntryValue(entry.value))) {
    return "Every entry must be a valid IP address or CIDR range."
  }
  if (filled.length > MAX_ALLOWLIST_ENTRIES) {
    return `A company can allow at most ${MAX_ALLOWLIST_ENTRIES} addresses.`
  }
  return null
}

/** Request payload. Blank rows are dropped so a stray empty field is harmless. */
export function toPrivateNetworkLoginPayload(
  enabled: boolean,
  entries: readonly PrivateNetworkEntryDraft[],
) {
  return {
    enabled,
    entries: entries
      .filter((entry) => entry.value.trim().length > 0)
      .map((entry) => ({
        value: entry.value.trim(),
        label: entry.label.trim() || null,
      })),
  }
}

export function PrivateNetworkLoginFields({
  idPrefix,
  enabled,
  entries,
  disabled = false,
  onEnabledChange,
  onEntriesChange,
}: Readonly<{
  idPrefix: string
  enabled: boolean
  entries: PrivateNetworkEntryDraft[]
  disabled?: boolean
  onEnabledChange: (enabled: boolean) => void
  onEntriesChange: (entries: PrivateNetworkEntryDraft[]) => void
}>) {
  const handleToggle = (nextEnabled: boolean) => {
    onEnabledChange(nextEnabled)
    // Turning the restriction on with no rows would leave nothing to fill in.
    if (nextEnabled && entries.length === 0) {
      onEntriesChange([createNetworkEntryDraft()])
    }
  }

  const updateEntry = (key: string, patch: Partial<PrivateNetworkEntryDraft>) => {
    onEntriesChange(
      entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)),
    )
  }

  const removeEntry = (key: string) => {
    onEntriesChange(entries.filter((entry) => entry.key !== key))
  }

  const canAddEntry = entries.length < MAX_ALLOWLIST_ENTRIES
  const draftError = privateNetworkDraftError(enabled, entries)

  return (
    <div className="space-y-3 rounded-md border bg-background px-3 py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={`${idPrefix}-private-network-login`}>Private network login</Label>
          <p className="text-xs text-muted-foreground">
            Restrict this company&apos;s users to signing in from the addresses below.
          </p>
        </div>
        <Switch
          id={`${idPrefix}-private-network-login`}
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
        />
      </div>

      {enabled && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Enter a single address (<code>203.0.113.7</code>) or a range in CIDR notation
            (<code>203.0.113.0/24</code>). IPv6 is supported. Add as many as you need.
          </p>

          <div className="space-y-2">
            {entries.map((entry, index) => {
              const trimmed = entry.value.trim()
              const isInvalid = trimmed.length > 0 && !isValidNetworkEntryValue(trimmed)

              return (
                <div key={entry.key} className="space-y-1">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-1">
                      <Input
                        aria-label={`Allowed IP address ${index + 1}`}
                        value={entry.value}
                        onChange={(e) => updateEntry(entry.key, { value: e.target.value })}
                        placeholder="203.0.113.7"
                        disabled={disabled}
                        className={cn(isInvalid && "border-rose-500 focus-visible:ring-rose-500/20")}
                      />
                      {isInvalid && (
                        <p className="text-xs font-medium text-rose-600">
                          Not a valid IP address or CIDR range.
                        </p>
                      )}
                    </div>
                    <Input
                      aria-label={`Label for allowed IP address ${index + 1}`}
                      value={entry.label}
                      onChange={(e) => updateEntry(entry.key, { label: e.target.value })}
                      placeholder="Head office (optional)"
                      disabled={disabled}
                      maxLength={120}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove allowed IP address ${index + 1}`}
                      onClick={() => removeEntry(entry.key)}
                      disabled={disabled}
                      className="mt-0.5 shrink-0 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10"
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => onEntriesChange([...entries, createNetworkEntryDraft()])}
            disabled={disabled || !canAddEntry}
          >
            <Plus className="h-4 w-4" />
            Add IP address
          </Button>

          {draftError && (
            <p className="text-xs font-medium text-rose-600">{draftError}</p>
          )}
        </div>
      )}
    </div>
  )
}

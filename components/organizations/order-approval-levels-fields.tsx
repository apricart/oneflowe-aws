"use client"

import { Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  MAX_APPROVAL_LEVELS,
  approvalLevelBandText,
  approvalLevelBands,
  approvalLevelDraftErrors,
  approvalLevelDraftsError,
  parseApprovalLevelAmountDraft,
} from "@/lib/order-approval-levels"
import { cn } from "@/lib/utils"

/**
 * The "Order approval levels" section of Create / Edit Organization
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md). Super Admin only;
 * the endpoints refuse everyone else.
 *
 * `levels` holds the text of each amount field, Level 1 first. Levels are
 * positional, so only the last one can be removed — removing one in the middle
 * would renumber every level after it. That also makes the level number a
 * stable key for each row.
 *
 * Every rule comes from `lib/order-approval-levels.ts`, the same module the
 * server's schema uses, so the form cannot accept a list the server refuses.
 */
export function OrderApprovalLevelsFields({
  idPrefix,
  enabled,
  levels,
  disabled = false,
  onEnabledChange,
  onLevelsChange,
}: Readonly<{
  idPrefix: string
  enabled: boolean
  levels: string[]
  disabled?: boolean
  onEnabledChange: (enabled: boolean) => void
  onLevelsChange: (levels: string[]) => void
}>) {
  const switchId = `${idPrefix}-order-approval-levels`
  const levelErrors = approvalLevelDraftErrors(levels)
  const sectionError = enabled && levels.length === 0 ? approvalLevelDraftsError(enabled, levels) : null
  const canAddLevel = levels.length < MAX_APPROVAL_LEVELS
  // Each level's band, shown beside it once every amount is valid — a band
  // depends on its neighbours, so a half-entered list has none to show.
  const bands = levels.length > 0 && levelErrors.every((problem) => problem === null)
    ? approvalLevelBands(levels.map((text) => {
      const draft = parseApprovalLevelAmountDraft(text)
      return draft.ok ? draft.cents : 0
    }))
    : null

  const handleToggle = (nextEnabled: boolean) => {
    onEnabledChange(nextEnabled)
    // Switching on shows Level 1 straight away, ready for its amount.
    if (nextEnabled && levels.length === 0) onLevelsChange([""])
  }

  const updateLevel = (index: number, text: string) => {
    onLevelsChange(levels.map((current, position) => (position === index ? text : current)))
  }

  return (
    <div className="space-y-3 rounded-md border bg-background px-3 py-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor={switchId}>Order approval levels</Label>
          <p className="text-xs text-muted-foreground">
            Give this company&apos;s orders approval levels, each approving its own band of order amounts.
          </p>
        </div>
        <Switch
          id={switchId}
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
        />
      </div>

      {enabled && (
        <div className="space-y-3 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Level 1 is the highest level and approves orders equal to or above its amount. Each later
            level approves orders equal to or above its own amount and below the level before it, so each
            amount must be lower than the one before. The lowest level also approves every order below
            its own amount.
          </p>

          <ol className="space-y-2">
            {levels.map((text, index) => {
              const level = index + 1
              const inputId = `${idPrefix}-approval-level-${level}`
              const errorId = `${inputId}-error`
              // An empty field is not an error yet — Save stays disabled until
              // it is filled, as for the company's other required fields.
              const problem = text.trim().length > 0 ? levelErrors[index] : null
              const band = bands?.[index] ?? null
              const bandId = `${inputId}-band`
              const isLast = index === levels.length - 1

              return (
                <li key={level} className="space-y-1">
                  <Label htmlFor={inputId} className="text-xs font-semibold">
                    Level {level} approver
                  </Label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs text-muted-foreground">
                        PKR
                      </span>
                      <Input
                        id={inputId}
                        inputMode="decimal"
                        autoComplete="off"
                        value={text}
                        onChange={(event) => updateLevel(index, event.target.value)}
                        placeholder="Approves orders from, e.g. 40000"
                        disabled={disabled}
                        aria-invalid={problem ? true : undefined}
                        aria-describedby={problem ? errorId : (band ? bandId : undefined)}
                        className={cn("pl-11", problem && "border-rose-500 focus-visible:ring-rose-500/20")}
                      />
                    </div>
                    {isLast && levels.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove level ${level}`}
                        onClick={() => onLevelsChange(levels.slice(0, -1))}
                        disabled={disabled}
                        className="shrink-0 text-slate-400 hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-500/10"
                      >
                        <Trash2 size={16} />
                      </Button>
                    ) : (
                      // Keeps every amount field the same width as the last one.
                      <span className="w-9 shrink-0" aria-hidden="true" />
                    )}
                  </div>
                  {problem ? (
                    <p id={errorId} role="alert" className="text-xs font-medium text-rose-600">{problem}</p>
                  ) : null}
                  {!problem && band ? (
                    <p id={bandId} className="text-xs text-muted-foreground">
                      Approves orders: {approvalLevelBandText(band)}
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ol>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => onLevelsChange([...levels, ""])}
            disabled={disabled || !canAddLevel}
          >
            <Plus className="h-4 w-4" />
            Add approver level
          </Button>
          {!canAddLevel ? (
            <p className="text-xs text-muted-foreground">
              A company can have at most {MAX_APPROVAL_LEVELS} approval levels.
            </p>
          ) : null}

          {sectionError ? (
            <p role="alert" className="text-xs font-medium text-rose-600">{sectionError}</p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Users are assigned to these levels in a later step. Until then, this company&apos;s orders
            are approved exactly as they are today.
          </p>
        </div>
      )}
    </div>
  )
}

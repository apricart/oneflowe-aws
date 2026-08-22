"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { ArrowLeft, ArrowRight, Check, Loader2, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

import { BranchStep } from "./branch-step"
import { GroupStep } from "./group-step"
import { coveredBranchIds, mergeEntriesIntoBranchPlans, toRequestEntries } from "./group-order-plan"
import { ItemsStep } from "./items-step"
import { OrderSummaryPanel } from "./order-summary-panel"
import { ReviewStep } from "./review-step"
import { SubmissionResult } from "./submission-result"
import type {
  GroupOrderEntry,
  GroupOrderSubmission,
  ScopedGroup,
  SelectedLine,
  WizardStep,
} from "./types"

const DRAFT_SAVE_DEBOUNCE_MS = 1200

type GroupsResponse = { items: ScopedGroup[]; autoSelectGroupId?: number | null }

type DraftResponse = {
  item: {
    groupId: number | null
    payload: {
      groupId?: number | null
      entries?: Array<{ branchIds: number[]; items: Array<{ organizationInventoryId: number; quantity: number }> }>
      notes?: string
      draftBranchIds?: number[]
      draftItems?: Array<{ organizationInventoryId: number; quantity: number }>
    }
  } | null
}

type PricesResponse = {
  items: Array<{ organizationInventoryId: number; name: string; unit: string; priceCents: number }>
}

/** Stable id for a saved entry. Client-only; never sent to the server. */
function newEntryKey(): string {
  return `entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * An idempotency key that survives a retry. `crypto.randomUUID` is unavailable
 * on insecure origins, so a random fallback keeps the header well-formed.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

const STEP_LABELS: Array<{ step: WizardStep; label: string }> = [
  { step: "group", label: "Group" },
  { step: "branches", label: "Locations" },
  { step: "items", label: "Items" },
  { step: "review", label: "Review" },
]

/**
 * The multi-branch ordering workspace.
 *
 * The user builds a group order in repeatable steps — pick locations, pick
 * items, save — and the running order updates as they go. On submit the server
 * records one ordinary order per branch under one shared reference, which is
 * what the review step states plainly before anything is created.
 *
 * Nothing here is trusted by the server: branch scope, availability, and prices
 * are all re-resolved server-side at submission. This component's job is to
 * make what will happen legible, not to decide it.
 */
export function GroupOrderWorkspace() {
  const { toast } = useToast()

  const { data: groupsData, error: groupsError, isLoading: groupsLoading } =
    useSWR<GroupsResponse>("/api/v1/group-portal/groups", fetcher, { revalidateOnFocus: false })
  const { data: draftData, isLoading: draftLoading } =
    useSWR<DraftResponse>("/api/v1/group-portal/draft", fetcher, { revalidateOnFocus: false })

  const [step, setStep] = useState<WizardStep>("group")
  const [groupId, setGroupId] = useState<number | null | undefined>(undefined)
  const [entries, setEntries] = useState<GroupOrderEntry[]>([])
  const [draftBranchIds, setDraftBranchIds] = useState<number[]>([])
  const [draftLines, setDraftLines] = useState<SelectedLine[]>([])
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [submission, setSubmission] = useState<GroupOrderSubmission | null>(null)
  const [draftRestored, setDraftRestored] = useState(false)

  const idempotencyKeyRef = useRef<string | null>(null)
  const hydratedRef = useRef(false)

  const groups = useMemo(() => groupsData?.items ?? [], [groupsData])
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === groupId),
    [groups, groupId],
  )
  const branchesById = useMemo(
    () => new Map((selectedGroup?.branches ?? []).map((branch) => [branch.id, branch])),
    [selectedGroup],
  )
  const branchPlans = useMemo(
    () => mergeEntriesIntoBranchPlans(entries, branchesById),
    [entries, branchesById],
  )

  /**
   * Restore a saved draft once, then fill in the display fields the draft does
   * not carry. Quantities come from the draft; names and prices are re-read from
   * the server so a resumed order never previews a stale price.
   */
  useEffect(() => {
    if (hydratedRef.current || groupsLoading || draftLoading) return
    hydratedRef.current = true

    const payload = draftData?.item?.payload
    const savedEntries = payload?.entries ?? []
    const savedDraftItems = payload?.draftItems ?? []
    if (savedEntries.length === 0 && savedDraftItems.length === 0) {
      const autoSelect = groupsData?.autoSelectGroupId
      if (autoSelect !== undefined) {
        setGroupId(autoSelect)
        setStep("branches")
      }
      return
    }

    const restore = async () => {
      const inventoryIds = [...new Set([
        ...savedEntries.flatMap((entry) => entry.items.map((item) => item.organizationInventoryId)),
        ...savedDraftItems.map((item) => item.organizationInventoryId),
      ])]
      let priceByInventoryId = new Map<number, { name: string; unit: string; priceCents: number }>()
      try {
        const prices = await fetcher<PricesResponse>(
          `/api/v1/group-portal/prices?organizationInventoryIds=${inventoryIds.join(",")}`,
        )
        priceByInventoryId = new Map(prices.items.map((item) => [item.organizationInventoryId, item]))
      } catch {
        // A failed refresh must not lose the user's work; the lines below fall
        // back to placeholders and the server still prices the real order.
        toast({
          title: "Draft restored without current prices",
          description: "Totals will be confirmed when you submit.",
        })
      }

      // Products withdrawn since the draft was saved are dropped rather than
      // carried forward into a submission that would fail for every branch.
      const toSelectedLine = (item: { organizationInventoryId: number; quantity: number }): SelectedLine[] => {
        const product = priceByInventoryId.get(item.organizationInventoryId)
        if (!product) return []
        return [{
          organizationInventoryId: item.organizationInventoryId,
          quantity: item.quantity,
          name: product.name,
          unit: product.unit,
          priceCents: product.priceCents,
        }]
      }

      const restoredEntries = savedEntries.flatMap((entry): GroupOrderEntry[] => {
        const lines = entry.items.flatMap(toSelectedLine)
        return lines.length > 0 ? [{ key: newEntryKey(), branchIds: entry.branchIds, lines }] : []
      })

      setGroupId(payload?.groupId ?? null)
      setEntries(restoredEntries)
      setDraftBranchIds(payload?.draftBranchIds ?? [])
      setDraftLines(savedDraftItems.flatMap(toSelectedLine))
      setNotes(payload?.notes ?? "")
      setStep(restoredEntries.length > 0 || savedDraftItems.length > 0 ? "branches" : "group")
      setDraftRestored(true)
    }

    void restore()
  }, [draftData, draftLoading, groupsData, groupsLoading, toast])

  /** Persist selections as they change, so a refresh or another device resumes. */
  useEffect(() => {
    if (!hydratedRef.current || groupId === undefined || submission) return

    const timer = setTimeout(() => {
      void fetch("/api/v1/group-portal/draft", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupId,
          entries: toRequestEntries(entries),
          notes: notes.trim() || undefined,
          draftBranchIds,
          draftItems: draftLines.map((line) => ({
            organizationInventoryId: line.organizationInventoryId,
            quantity: line.quantity,
          })),
        }),
      }).catch((saveError) => console.warn("[GroupOrder] Draft save failed", saveError))
    }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [groupId, entries, notes, draftBranchIds, draftLines, submission])

  // Any change to what is being ordered starts a new submission identity, so a
  // retry only ever replays the exact payload it was created for.
  useEffect(() => {
    idempotencyKeyRef.current = null
  }, [entries, notes])

  const selectGroup = (nextGroupId: number | null) => {
    setGroupId(nextGroupId)
    setEntries([])
    setDraftBranchIds([])
    setDraftLines([])
    setStep("branches")
  }

  const saveEntry = () => {
    if (draftBranchIds.length === 0 || draftLines.length === 0) return
    setEntries((current) => [...current, {
      key: newEntryKey(),
      branchIds: [...draftBranchIds],
      lines: draftLines,
    }])
    setDraftBranchIds([])
    setDraftLines([])
    setStep("branches")
    toast({ title: "Added to group order", description: "Add another set of locations, or review and submit." })
  }

  const removeEntry = (key: string) => {
    setEntries((current) => current.filter((entry) => entry.key !== key))
  }

  const resetWorkspace = useCallback(() => {
    setSubmission(null)
    setEntries([])
    setDraftBranchIds([])
    setDraftLines([])
    setNotes("")
    setStep(groups.length === 1 ? "branches" : "group")
    if (groups.length === 1) setGroupId(groups[0].id)
  }, [groups])

  const submit = async () => {
    if (branchPlans.length === 0 || groupId === undefined) return
    setSubmitting(true)
    idempotencyKeyRef.current ??= newIdempotencyKey()

    try {
      const res = await fetch("/api/v1/group-portal/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          groupId,
          entries: toRequestEntries(entries),
          notes: notes.trim() || undefined,
        }),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        toast({
          title: "Group order not submitted",
          description: body?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      setSubmission(body.item as GroupOrderSubmission)
      idempotencyKeyRef.current = null
      // The submission is recorded; the saved draft would otherwise reappear.
      void fetch("/api/v1/group-portal/draft", { method: "DELETE" }).catch(() => undefined)
    } catch {
      toast({
        title: "Group order not submitted",
        description: "The request could not be completed. Check your connection and try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (groupsLoading || draftLoading) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="p-6"><ListSkeleton rows={5} /></CardContent>
      </Card>
    )
  }

  if (groupsError) {
    return (
      <Card role="alert" className="rounded-2xl border-rose-200 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20">
        <CardContent className="p-5 text-sm text-slate-700 dark:text-slate-300">
          Your assigned groups could not be loaded. Please try again, or contact your administrator
          if this continues.
        </CardContent>
      </Card>
    )
  }

  if (submission) {
    return <SubmissionResult submission={submission} onStartAnother={resetWorkspace} />
  }

  return (
    <div className="space-y-5">
      <StepIndicator current={step} hasGroupChoice={groups.length > 1} />

      {draftRestored && (
        <Card className="rounded-xl border-sky-200 bg-sky-50/60 dark:border-sky-900/60 dark:bg-sky-950/20">
          <CardContent className="flex items-center gap-2 p-3 text-xs text-slate-700 dark:text-slate-300">
            <Save className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
            Your unfinished group order was restored.
          </CardContent>
        </Card>
      )}

      <div className={cn("grid gap-5", step !== "review" && "lg:grid-cols-[minmax(0,1fr)_20rem]")}>
        <div className="min-w-0 space-y-5">
          {step === "group" && (
            <GroupStep groups={groups} selectedGroupId={groupId} onSelect={selectGroup} />
          )}

          {step === "branches" && selectedGroup && (
            <>
              <BranchStep
                branches={selectedGroup.branches}
                selectedBranchIds={draftBranchIds}
                coveredBranchIds={coveredBranchIds(entries)}
                onChange={setDraftBranchIds}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                {groups.length > 1 ? (
                  <Button type="button" variant="outline" className="gap-2" onClick={() => setStep("group")}>
                    <ArrowLeft className="h-4 w-4" />
                    Change group
                  </Button>
                ) : <span />}
                <Button
                  type="button"
                  className="gap-2"
                  disabled={draftBranchIds.length === 0}
                  onClick={() => setStep("items")}
                >
                  Choose items
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}

          {step === "items" && (
            <>
              <ItemsStep
                groupId={groupId ?? null}
                branchIds={draftBranchIds}
                branchCount={draftBranchIds.length}
                lines={draftLines}
                onChange={setDraftLines}
              />
              <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
                <Button type="button" variant="outline" className="gap-2" onClick={() => setStep("branches")}>
                  <ArrowLeft className="h-4 w-4" />
                  Back to locations
                </Button>
                <Button type="button" className="gap-2" disabled={draftLines.length === 0} onClick={saveEntry}>
                  <Check className="h-4 w-4" />
                  Add to group order ({draftLines.length})
                </Button>
              </div>
            </>
          )}

          {step === "review" && (
            <ReviewStep
              groupName={selectedGroup?.name ?? "Selected group"}
              branchPlans={branchPlans}
              notes={notes}
              submitting={submitting}
              onNotesChange={setNotes}
              onBack={() => setStep("branches")}
              onSubmit={submit}
            />
          )}
        </div>

        {step !== "review" && (
          <aside className="lg:sticky lg:top-4 lg:self-start">
            <OrderSummaryPanel
              entries={entries}
              branchPlans={branchPlans}
              branchesById={branchesById}
              onRemoveEntry={removeEntry}
              onReview={() => setStep("review")}
            />
          </aside>
        )}
      </div>

      {submitting && (
        <p className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Creating one order per branch. This can take a moment for a large group.
        </p>
      )}
    </div>
  )
}

function StepIndicator({
  current,
  hasGroupChoice,
}: Readonly<{ current: WizardStep; hasGroupChoice: boolean }>) {
  const steps = hasGroupChoice ? STEP_LABELS : STEP_LABELS.filter((entry) => entry.step !== "group")
  const currentIndex = steps.findIndex((entry) => entry.step === current)

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {steps.map((entry, index) => (
        <li key={entry.step} className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium transition",
              index === currentIndex && "bg-indigo-600 text-white",
              index < currentIndex && "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
              index > currentIndex && "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
            )}
          >
            <span className="tabular-nums">{index + 1}</span>
            {entry.label}
          </span>
          {index < steps.length - 1 && <span className="text-slate-300 dark:text-slate-700">›</span>}
        </li>
      ))}
    </ol>
  )
}

"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import useSWR from "swr"
import { AlertTriangle, Grid, History, Loader2, Package, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { PendingInvoiceAlert } from "@/components/orders/pending-invoice-alert"
import { UnpaidInvoicesDialog } from "@/components/payment-control/unpaid-invoices-dialog"
import { UnacknowledgedDeliveriesDialog } from "@/components/orders/unacknowledged-deliveries-dialog"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { usePendingInvoiceGuard } from "@/lib/hooks/use-pending-invoice-guard"
import { formatQuantity } from "@/lib/quantity"
import {
  blockedBranchesOf,
  noticeForBlockedBranches,
  type UnpaidInvoicesNotice,
} from "@/lib/unpaid-invoice-block"
import {
  noticeForGroupResults,
  type UnacknowledgedDeliveriesNotice,
} from "@/lib/unacknowledged-delivery-block"

import { GroupOrderHistory } from "../group-order-history"
import { GroupRefundHistory } from "../group-refund-history"
import { OtherBranchOrders } from "../other-branch-orders"
import {
  MAX_ENTRIES,
  applyQuantityToBranchPlans,
  branchPlansToEntries,
  entryTotalCents,
  replaceBranchPlanLines,
  withoutBranchPlan,
} from "../group-order-plan"
import { ReviewStep } from "../review-step"
import { SubmissionResult } from "../submission-result"
import type {
  BranchBudgetResponse,
  BranchPlan,
  CatalogItem,
  GroupOrderSubmission,
  ScopedGroup,
  SelectedLine,
} from "../types"
import { GroupSidebar, groupKey } from "./group-sidebar"
import { StorefrontCart } from "./storefront-cart"
import { StorefrontCatalog } from "./storefront-catalog"
import { StorefrontHeader } from "./storefront-header"
import {
  applyGroupLocations,
  applyLocationToggle,
  cartSignature,
  cartToBranchPlans,
  selectedBranches,
  setCartLineQuantity,
  setCartQuantity,
  type LocationSelection,
} from "./storefront-plan"
import { useStorefrontDraft, type StorefrontDraft } from "./use-storefront-draft"

type GroupsResponse = { items: ScopedGroup[]; autoSelectGroupId?: number | null }
type ScopeResponse = { item?: { organization: { id: number; name: string } | null } }

type StorefrontTab = "shop" | "orders" | "other" | "refunds"

/** Stable id for a submitted entry. Client-only; never sent to the server. */
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

/**
 * The Group Order Portal storefront.
 *
 * The side menu is the whole model made visible: one group at a time, because a
 * group scopes the order the server will accept, and any number of that group's
 * locations, because one cart is raised for each of them. The main column is an
 * ordinary shop — search, categories, product cards, a cart — so the only thing
 * a requester has to learn is what the menu on the left means.
 *
 * The review screen before submission is where the group order stops being a
 * single cart: it shows the per-location orders that will actually be created
 * and lets any of them be corrected. Nothing on this screen is authoritative.
 * Branch scope, availability, and prices are all re-resolved server-side at
 * submission, and a location the server refuses is skipped with its own reason
 * rather than failing the rest.
 */
export function GroupStorefront() {
  const { data: session } = useSession()
  const { toast } = useToast()

  const { data: groupsData, error: groupsError, isLoading: groupsLoading } =
    useSWR<GroupsResponse>("/api/v1/group-portal/groups", fetcher, { revalidateOnFocus: false })
  const { data: scopeData } = useSWR<ScopeResponse>(
    "/api/v1/group-portal/scope",
    fetcher,
    { revalidateOnFocus: false },
  )
  /**
   * This month's budget per location, for the sidebar.
   *
   * Unlike the group list this one does revalidate on focus: holds are placed
   * the moment any requester submits, so a figure left over from an hour ago
   * would be the wrong number to plan against. A failure here is left to
   * resolve itself on the next revalidation — the sidebar simply shows no
   * figure, and ordering is unaffected because the server checks the real
   * budget at submission regardless.
   */
  const { data: budgetData, isLoading: budgetsLoading, mutate: mutateBudgets } =
    useSWR<BranchBudgetResponse>("/api/v1/group-portal/budgets", fetcher)

  const [groupId, setGroupId] = useState<number | null | undefined>(undefined)
  const [branchIds, setBranchIds] = useState<number[]>([])
  const [lines, setLines] = useState<SelectedLine[]>([])
  const [notes, setNotes] = useState("")
  /** The buyer's own purchase order reference for this submission. Optional. */
  const [poNumber, setPoNumber] = useState("")
  const [tab, setTab] = useState<StorefrontTab>("shop")
  const [cartOpen, setCartOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [reviewPlans, setReviewPlans] = useState<BranchPlan[] | null>(null)
  const [reviewing, setReviewing] = useState(false)
  /** The cart the plans above were built from, so a return trip can reuse them. */
  const [reviewedSignature, setReviewedSignature] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [unpaidInvoicesNotice, setUnpaidInvoicesNotice] = useState<UnpaidInvoicesNotice | null>(null)
  const [unacknowledgedDeliveriesNotice, setUnacknowledgedDeliveriesNotice] = useState<UnacknowledgedDeliveriesNotice | null>(null)
  const [submission, setSubmission] = useState<GroupOrderSubmission | null>(null)
  /** Which group's locations are on show. Disclosure only — never a selection. */
  const [expandedGroupKey, setExpandedGroupKey] = useState<string | null>(null)
  /** A group move waiting on the user, because applying it would discard a cart. */
  const [pendingSelection, setPendingSelection] = useState<LocationSelection | null>(null)

  const idempotencyKeyRef = useRef<string | null>(null)
  const autoSelectedRef = useRef(false)

  const groups = useMemo(() => groupsData?.items ?? [], [groupsData])
  const budgetByBranchId = useMemo(
    () => new Map((budgetData?.items ?? []).map((item) => [item.branchId, item])),
    [budgetData],
  )
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === groupId),
    [groups, groupId],
  )
  const branches = useMemo(
    () => selectedBranches(selectedGroup?.branches ?? [], branchIds),
    [selectedGroup, branchIds],
  )

  const draft = useMemo<StorefrontDraft>(
    () => ({ groupId: groupId ?? null, branchIds, lines, notes, poNumber }),
    [groupId, branchIds, lines, notes, poNumber],
  )

  const restoreFromDraft = useCallback((restored: StorefrontDraft) => {
    setGroupId(restored.groupId)
    setBranchIds(restored.branchIds)
    setLines(restored.lines)
    setNotes(restored.notes)
    setPoNumber(restored.poNumber)
  }, [])

  const {
    status: draftStatus,
    saveState,
    restoreFailed,
    retrying,
    retryDraftRestore,
    forgetDraft,
  } = useStorefrontDraft({
    draft,
    suspended: submission !== null,
    onRestore: restoreFromDraft,
  })

  /**
   * Move the selection to a set of locations, dropping whatever another group
   * had ticked. Also opens that group in the menu so the result is visible.
   */
  const applySelection = useCallback((selection: LocationSelection) => {
    setGroupId(selection.groupId)
    setBranchIds(selection.branchIds)
    setExpandedGroupKey(groupKey(selection.groupId))
    if (!selection.switchedGroup) return

    // A cart belongs to the group it was built in, so a group change empties it.
    // Reaching here with a cart is only possible once the user has confirmed.
    setLines([])
    setReviewPlans(null)
    setReviewedSignature(null)
    setReviewing(false)
  }, [])

  /**
   * Apply a selection, asking first when it would discard a cart.
   *
   * Clearing the other group's locations is automatic and never asked about —
   * a selection spanning two groups is not one the server would accept. Losing
   * a cart is a different question, and it is the only one put to the user.
   */
  const requestSelection = (selection: LocationSelection) => {
    autoSelectedRef.current = true
    if (selection.switchedGroup && lines.length > 0) {
      setPendingSelection(selection)
      return
    }
    applySelection(selection)
  }

  /**
   * A user with a single group has nothing to decide, so the group and its
   * locations are chosen for them. Held until the draft has settled: choosing on
   * the user's behalf while their saved order is still arriving would overwrite
   * it, which is why this waits on the hook's status rather than on loading
   * alone.
   */
  useEffect(() => {
    if (autoSelectedRef.current || draftStatus !== "ready" || groupsLoading) return
    if (groupId !== undefined || groups.length !== 1) return

    autoSelectedRef.current = true
    const [only] = groups
    applySelection({
      groupId: only.id,
      branchIds: only.branches.map((branch) => branch.id),
      switchedGroup: false,
    })
  }, [applySelection, draftStatus, groupId, groups, groupsLoading])

  /** A restored draft opens its own group, so the menu matches the cart. */
  useEffect(() => {
    if (groupId === undefined || expandedGroupKey !== null) return
    setExpandedGroupKey(groupKey(groupId))
  }, [groupId, expandedGroupKey])

  const perLocationCents = entryTotalCents(lines)
  const combinedCents = perLocationCents * branches.length

  const toggleBranch = (targetGroupId: number | null, branchId: number) => {
    requestSelection(applyLocationToggle({ groupId, branchIds }, { groupId: targetGroupId, branchId }))
  }

  const setGroupBranches = (targetGroupId: number | null, nextBranchIds: number[]) => {
    requestSelection(applyGroupLocations({ groupId, branchIds }, { groupId: targetGroupId, branchIds: nextBranchIds }))
  }

  const changeQuantity = (item: CatalogItem, quantity: number) => {
    setLines((current) => setCartQuantity(current, item, quantity))
    toast({
      title: quantity > 0 ? `${item.name} in cart` : `${item.name} removed`,
      description: quantity > 0
        ? `${formatQuantity(quantity)} ${item.unit} for each of ${branches.length} ${branches.length === 1 ? "location" : "locations"}.`
        : "It is no longer part of this group order.",
    })
  }

  /**
   * Open the review screen.
   *
   * Per-location corrections made there survive a trip back to the storefront,
   * because "keep adding" is not a request to undo them. They are rebuilt from
   * the cart only once the cart or the ticked locations have actually changed,
   * at which point the old plans no longer describe the order.
   */
  const openReview = () => {
    const signature = cartSignature(lines, branches)
    if (reviewPlans && signature === reviewedSignature) {
      setReviewing(true)
      setCartOpen(false)
      return
    }

    const plans = cartToBranchPlans(lines, branches)
    if (plans.length === 0) return
    setReviewPlans(plans)
    setReviewedSignature(signature)
    setReviewing(true)
    setCartOpen(false)
  }

  /**
   * Accept an edited set of per-location plans, unless it would build a payload
   * the server refuses outright. Diverging every location produces one entry per
   * location, so a large group can cross the submission limit through ordinary
   * editing — saying so here is better than a rejected submission later.
   */
  const commitReviewPlans = (next: BranchPlan[]): boolean => {
    if (branchPlansToEntries(next, newEntryKey).length > MAX_ENTRIES) {
      toast({
        title: "Too many different location orders",
        description: `A group order can carry at most ${MAX_ENTRIES} distinct item sets. Give more locations the same quantities, or submit them as two group orders.`,
        variant: "destructive",
      })
      return false
    }
    setReviewPlans(next)
    return true
  }

  const submit = async () => {
    if (!reviewPlans || reviewPlans.length === 0 || groupId === undefined) return

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
          entries: branchPlansToEntries(reviewPlans, newEntryKey).map((entry) => ({
            branchIds: entry.branchIds,
            items: entry.lines.map((line) => ({
              organizationInventoryId: line.organizationInventoryId,
              quantity: line.quantity,
            })),
          })),
          notes: notes.trim() || undefined,
          poNumber: poNumber.trim() || undefined,
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
      // Each location commits on its own, so the others may have gone through;
      // the ones refused for unpaid invoices are called out on top of the result.
      setUnpaidInvoicesNotice(noticeForBlockedBranches(blockedBranchesOf(body.item?.results)))
      // Likewise the ones refused for delivered orders awaiting acknowledgement;
      // shown once the unpaid-invoices popup, if any, is closed.
      setUnacknowledgedDeliveriesNotice(noticeForGroupResults(body.item?.results))
      // The orders just created hold budget at every location they covered, so
      // the sidebar's figures are stale the instant this returns.
      void mutateBudgets()
      setReviewPlans(null)
      setReviewedSignature(null)
      setReviewing(false)
      // The order exists now, so the cart that produced it is spent. Leaving it
      // filled would offer to submit the same group order a second time.
      setLines([])
      setNotes("")
      setPoNumber("")
      idempotencyKeyRef.current = null
      forgetDraft()
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

  const pendingInvoiceGuard = usePendingInvoiceGuard({
    onConfirmed: submit,
    onCheckFailed: (message) => {
      toast({
        title: "Unable to check pending invoices",
        description: message,
        variant: "destructive",
      })
    },
  })

  const startAnother = () => {
    setSubmission(null)
    setTab("shop")
  }

  /**
   * The cart is closed to editing once the review screen is open.
   *
   * Review holds per-location quantities the cart cannot express, so a cart
   * edit made behind it would either be ignored or would silently throw those
   * corrections away. Going back to the storefront is the way out.
   */
  const openCart = () => { if (!reviewing) setCartOpen(true) }

  const sidebar = (
    <GroupSidebar
      groups={groups}
      loading={groupsLoading}
      failed={Boolean(groupsError)}
      selectedGroupId={groupId}
      selectedBranchIds={branchIds}
      expandedGroupKey={expandedGroupKey}
      budgets={budgetByBranchId}
      budgetsLoading={budgetsLoading}
      disabled={reviewing || submitting}
      onToggleExpand={(key) => setExpandedGroupKey((current) => current === key ? null : key)}
      onToggleBranch={toggleBranch}
      onSetGroupBranches={setGroupBranches}
    />
  )

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-50 dark:bg-slate-950">
      <div
        className="pointer-events-none absolute inset-0 -z-10 dark:hidden"
        style={{
          backgroundImage:
            "radial-gradient(48rem 48rem at 0% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 75%), transparent 60%), radial-gradient(48rem 48rem at 100% 0%, color-mix(in oklab, var(--color-primary), transparent 78%), transparent 60%)",
          backgroundColor: "oklch(0.97 0 0)",
        }}
      />

      <StorefrontHeader
        userName={(session?.user as any)?.fullName ?? session?.user?.name ?? "Account"}
        userEmail={session?.user?.email ?? null}
        userRole={(session?.user as any)?.role ?? "GROUP_ORDER_PORTAL"}
        organizationName={scopeData?.item?.organization?.name ?? "Your organization"}
        groupName={selectedGroup?.name ?? null}
        locationCount={branches.length}
        cartCount={lines.length}
        combinedCents={combinedCents}
        saveState={saveState}
        cartDisabled={reviewing}
        onOpenCart={openCart}
        onOpenMenu={() => setMenuOpen(true)}
      />

      <div className="mx-auto flex max-w-[1600px] gap-6 p-4 md:p-6">
        <aside className="hidden w-72 shrink-0 lg:block">
          <div className="sticky top-24">{sidebar}</div>
        </aside>

        <main className="min-w-0 flex-1 space-y-5">
          {restoreFailed && (
            <RestoreFailedNotice retrying={retrying} onRetry={() => { void retryDraftRestore() }} />
          )}

          <StorefrontBody
            tab={tab}
            submission={submission}
            reviewPlans={reviewing ? reviewPlans : null}
            groupId={groupId}
            branchIds={branchIds}
            lines={lines}
            notes={notes}
            poNumber={poNumber}
            groupName={selectedGroup?.name ?? ""}
            submitting={submitting}
            checkingInvoices={pendingInvoiceGuard.checking}
            onTabChange={setTab}
            onSetQuantity={changeQuantity}
            onOpenCart={openCart}
            onNotesChange={setNotes}
            onPoNumberChange={setPoNumber}
            onCommitPlans={commitReviewPlans}
            onLeaveReview={() => setReviewing(false)}
            onSubmit={() => { void pendingInvoiceGuard.attempt() }}
            onStartAnother={startAnother}
          />
        </main>
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-80 overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Groups and locations</SheetTitle>
          </SheetHeader>
          <div className="mt-4">{sidebar}</div>
        </SheetContent>
      </Sheet>

      <StorefrontCart
        open={cartOpen}
        lines={lines}
        branches={branches}
        onOpenChange={setCartOpen}
        onQuantityChange={(id, quantity) => setLines((current) => setCartLineQuantity(current, id, quantity))}
        onRemove={(id) => setLines((current) => setCartLineQuantity(current, id, 0))}
        onClear={() => setLines([])}
        onCheckout={openReview}
      />

      <ConfirmDialog
        open={pendingSelection !== null}
        title="Order for a different group?"
        description="Locations belong to one group at a time, so this clears the locations you had ticked — and your cart with them, because a cart belongs to the group it was built in."
        confirmText="Switch and clear cart"
        cancelText="Keep my cart"
        onOpenChange={(open) => { if (!open) setPendingSelection(null) }}
        onConfirm={() => {
          if (pendingSelection) applySelection(pendingSelection)
          setPendingSelection(null)
        }}
      />

      <PendingInvoiceAlert
        invoice={pendingInvoiceGuard.pendingInvoice}
        continuing={submitting}
        onCancel={pendingInvoiceGuard.dismiss}
        onContinue={() => { void pendingInvoiceGuard.continueAfterNotice() }}
      />

      <UnpaidInvoicesDialog
        notice={unpaidInvoicesNotice}
        onClose={() => setUnpaidInvoicesNotice(null)}
      />

      <UnacknowledgedDeliveriesDialog
        notice={unpaidInvoicesNotice ? null : unacknowledgedDeliveriesNotice}
        onClose={() => setUnacknowledgedDeliveriesNotice(null)}
      />
    </div>
  )
}

/**
 * What the main column shows right now.
 *
 * Kept apart from the storefront's state so each of the four surfaces —
 * the result of a submission, the review screen, the shop, and the two history
 * tabs — is reached by exactly one condition.
 */
function StorefrontBody({
  tab,
  submission,
  reviewPlans,
  groupId,
  branchIds,
  lines,
  notes,
  poNumber,
  groupName,
  submitting,
  checkingInvoices,
  onTabChange,
  onSetQuantity,
  onOpenCart,
  onNotesChange,
  onPoNumberChange,
  onCommitPlans,
  onLeaveReview,
  onSubmit,
  onStartAnother,
}: Readonly<{
  tab: StorefrontTab
  submission: GroupOrderSubmission | null
  reviewPlans: BranchPlan[] | null
  groupId: number | null | undefined
  branchIds: number[]
  lines: SelectedLine[]
  notes: string
  poNumber: string
  groupName: string
  submitting: boolean
  checkingInvoices: boolean
  onTabChange: (tab: StorefrontTab) => void
  onSetQuantity: (item: CatalogItem, quantity: number) => void
  onOpenCart: () => void
  onNotesChange: (notes: string) => void
  onPoNumberChange: (poNumber: string) => void
  onCommitPlans: (plans: BranchPlan[]) => boolean
  onLeaveReview: () => void
  onSubmit: () => void
  onStartAnother: () => void
}>) {
  if (submission) {
    return (
      <SubmissionResult
        submission={submission}
        onStartAnother={onStartAnother}
        onViewOrders={() => {
          onStartAnother()
          onTabChange("orders")
        }}
      />
    )
  }

  if (reviewPlans) {
    return (
      <ReviewStep
        groupId={groupId ?? null}
        groupName={groupName}
        branchPlans={reviewPlans}
        notes={notes}
        poNumber={poNumber}
        submitting={submitting}
        checkingInvoices={checkingInvoices}
        onNotesChange={onNotesChange}
        onPoNumberChange={onPoNumberChange}
        onQuantityChange={(inventoryId, quantity, branchId) => {
          onCommitPlans(applyQuantityToBranchPlans(reviewPlans, inventoryId, quantity, branchId))
        }}
        onApplyQuantityToAll={(inventoryId, sourceBranchId) => {
          const source = reviewPlans
            .find((plan) => plan.branch.id === sourceBranchId)
            ?.lines.find((line) => line.organizationInventoryId === inventoryId)
          if (!source) return
          onCommitPlans(applyQuantityToBranchPlans(reviewPlans, inventoryId, source.quantity))
        }}
        onReplaceBranchLines={(branchId, lines) =>
          onCommitPlans(replaceBranchPlanLines(reviewPlans, branchId, lines))}
        onRemoveBranch={(branchId) => {
          onCommitPlans(withoutBranchPlan(reviewPlans, branchId))
        }}
        onBack={onLeaveReview}
        onSubmit={onSubmit}
      />
    )
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 rounded-2xl bg-white/80 p-1 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-900/80">
        <Button
          type="button"
          onClick={() => onTabChange("shop")}
          variant={tab === "shop" ? "default" : "outline"}
          className="gap-2"
        >
          <Grid className="h-4 w-4" />
          Shop
        </Button>
        <Button
          type="button"
          onClick={() => onTabChange("orders")}
          variant={tab === "orders" ? "default" : "outline"}
          className="gap-2"
        >
          <History className="h-4 w-4" />
          My group orders
        </Button>
        <Button
          type="button"
          onClick={() => onTabChange("other")}
          variant={tab === "other" ? "default" : "outline"}
          className="gap-2"
        >
          <Package className="h-4 w-4" />
          Other orders
        </Button>
        <Button
          type="button"
          onClick={() => onTabChange("refunds")}
          variant={tab === "refunds" ? "default" : "outline"}
          className="gap-2"
        >
          <RotateCcw className="h-4 w-4" />
          Refunds
        </Button>
      </div>

      {tab === "shop" && (
        <StorefrontCatalog
          groupId={groupId}
          branchIds={branchIds}
          lines={lines}
          onSetQuantity={onSetQuantity}
          onOpenCart={onOpenCart}
        />
      )}
      {tab === "orders" && <GroupOrderHistory />}
      {/* What the assigned branches raised for themselves. Read-only: every
          write on such an order stays with the person who placed it. */}
      {tab === "other" && <OtherBranchOrders />}
      {tab === "refunds" && <GroupRefundHistory />}
    </>
  )
}

/**
 * Shown when a saved order could not be read back. The autosave is off while
 * this is on screen, so the stored draft is still intact and a retry is the
 * only action that can recover it.
 */
function RestoreFailedNotice({
  retrying,
  onRetry,
}: Readonly<{ retrying: boolean; onRetry: () => void }>) {
  return (
    <Card role="alert" className="rounded-2xl border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20">
      <CardContent className="flex flex-col gap-3 p-4 text-sm text-slate-700 dark:text-slate-300 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span>
            Your saved group order could not be restored, so it has been left untouched on the
            server. Nothing you had is lost.
          </span>
        </span>
        <Button type="button" size="sm" className="shrink-0 gap-2" disabled={retrying} onClick={onRetry}>
          {retrying && <Loader2 className="h-4 w-4 animate-spin" />}
          Try again
        </Button>
      </CardContent>
    </Card>
  )
}

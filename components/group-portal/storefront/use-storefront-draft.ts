"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import useSWR from "swr"

import { useToast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { sanitizeQuantityStep, snapQuantityToStep } from "@/lib/quantity"

import type { SelectedLine } from "../types"

const DRAFT_SAVE_DEBOUNCE_MS = 1200

/**
 * Mirrors `MAX_REQUESTED_IDS` on the price endpoint.
 *
 * A saved draft may reference more products than one request may carry, and an
 * oversized request is refused outright — which the restore below would have
 * read as "every one of these products is gone".
 */
const PRICE_LOOKUP_CHUNK_SIZE = 500

/** What the autosave is doing, so the user never has to guess if work is safe. */
export type DraftSaveState = "idle" | "saving" | "saved" | "error"

/** The storefront state the server holds on the user's behalf. */
export type StorefrontDraft = {
  groupId: number | null
  branchIds: number[]
  lines: SelectedLine[]
  notes: string
  poNumber: string
}

type PricedProduct = {
  name: string
  unit: string
  priceCents: number
  allowDecimalQuantity?: boolean
  quantityStep?: number | null
}

type PricesResponse = {
  items: Array<PricedProduct & { organizationInventoryId: number }>
}

type StoredPayload = {
  groupId?: number | null
  notes?: string
  poNumber?: string
  draftBranchIds?: number[]
  draftItems?: Array<{ organizationInventoryId: number; quantity: number }>
}

type DraftResponse = { item: { groupId: number | null; payload: StoredPayload } | null }

/**
 * Current name, unit, and price for every product a draft references.
 *
 * Throws if any chunk fails, so the caller can tell "the catalogue says these
 * products are withdrawn" apart from "the catalogue could not be reached" —
 * two situations that must not lead to the same outcome.
 */
async function loadPricedProducts(
  inventoryIds: number[],
  groupId: number | null,
): Promise<Map<number, PricedProduct>> {
  const priced = new Map<number, PricedProduct>()
  // Always sent, including as an empty value for the ungrouped bucket: a
  // product can be priced differently per group, so the endpoint refuses to
  // answer without knowing which group the draft belongs to.
  const groupParam = groupId === null ? "" : String(groupId)

  for (let index = 0; index < inventoryIds.length; index += PRICE_LOOKUP_CHUNK_SIZE) {
    const chunk = inventoryIds.slice(index, index + PRICE_LOOKUP_CHUNK_SIZE)
    const prices = await fetcher<PricesResponse>(
      `/api/v1/group-portal/prices?groupId=${groupParam}&organizationInventoryIds=${chunk.join(",")}`,
    )
    for (const item of prices.items) priced.set(item.organizationInventoryId, item)
  }

  return priced
}

/** The exact body the draft endpoint accepts — selections only, no display fields. */
function buildDraftPayload(draft: StorefrontDraft) {
  return {
    groupId: draft.groupId,
    // The storefront keeps one cart for one set of locations, so it never
    // builds the saved sets the endpoint's schema also accepts. The field stays
    // in the payload because that schema rejects unknown shapes outright.
    entries: [],
    notes: draft.notes.trim() || undefined,
    poNumber: draft.poNumber.trim() || undefined,
    draftBranchIds: draft.branchIds,
    draftItems: draft.lines.map((line) => ({
      organizationInventoryId: line.organizationInventoryId,
      quantity: line.quantity,
    })),
  }
}

/**
 * Rebuild one display line from a stored selection and the catalogue's answer.
 *
 * Products withdrawn since the draft was saved are dropped rather than carried
 * forward into a submission that would fail for every branch.
 */
function toSelectedLine(
  item: { organizationInventoryId: number; quantity: number },
  priced: Map<number, PricedProduct>,
): SelectedLine[] {
  const product = priced.get(item.organizationInventoryId)
  if (!product) return []

  // A draft saved before the step was enforced, or one whose product has been
  // reconfigured since, can hold a quantity that is no longer on the grid.
  // Correcting it here means the resumed order submits rather than failing that
  // branch for a value the user cannot see is wrong.
  const quantity = snapQuantityToStep(
    item.quantity,
    sanitizeQuantityStep(Boolean(product.allowDecimalQuantity), product.quantityStep ?? 1),
  )
  if (quantity <= 0) return []

  return [{
    organizationInventoryId: item.organizationInventoryId,
    quantity,
    name: product.name,
    unit: product.unit,
    priceCents: product.priceCents,
    allowDecimalQuantity: product.allowDecimalQuantity,
    quantityStep: product.quantityStep,
  }]
}

/**
 * Server-side persistence for the storefront's working order.
 *
 * The hook owns the saving and resuming; the storefront owns the state. Keeping
 * them apart is what lets the autosave stay off while a restore is outstanding:
 * until the screen represents the stored draft, writing it would replace real
 * work with an empty order.
 *
 * Nothing here is authoritative. Quantities come from the draft, but names and
 * prices are always re-read from the server, so a resumed order never previews
 * a stale price — and the server re-prices every line again at submission.
 */
export function useStorefrontDraft({
  draft,
  suspended,
  onRestore,
}: Readonly<{
  draft: StorefrontDraft
  /** Set once an order is submitted, so the finished cart is not written back. */
  suspended: boolean
  onRestore: (restored: StorefrontDraft) => void
}>) {
  const { toast } = useToast()
  const { data, isLoading } = useSWR<DraftResponse>(
    "/api/v1/group-portal/draft",
    fetcher,
    { revalidateOnFocus: false },
  )

  const [saveState, setSaveState] = useState<DraftSaveState>("idle")
  /**
   * Set when a saved draft could not be restored. While it is set the autosave
   * stays off, so the stored draft is never overwritten by a cart that does not
   * represent it.
   */
  const [restoreFailed, setRestoreFailed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [resumed, setResumed] = useState(false)
  /**
   * True from the moment a stored draft is found until it has been applied or
   * abandoned. The caller waits on it before deciding anything for the user,
   * and the autosave below stays off for the same reason.
   */
  const [restoring, setRestoring] = useState(false)

  const hydratedRef = useRef(false)
  const lastSavedSignatureRef = useRef<string | null>(null)
  // Held in a ref so a new callback identity on every render cannot restart the
  // restore effect, which would re-apply the draft over the user's edits.
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore

  /**
   * Write the draft, skipping a write that would change nothing.
   */
  const saveDraft = useCallback(async (payload: ReturnType<typeof buildDraftPayload>) => {
    const signature = JSON.stringify(payload)
    if (signature === lastSavedSignatureRef.current) return

    setSaveState("saving")
    try {
      const res = await fetch("/api/v1/group-portal/draft", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: signature,
      })
      if (!res.ok) throw new Error(`Draft save failed with ${res.status}`)
      lastSavedSignatureRef.current = signature
      setSaveState("saved")
    } catch (saveError) {
      console.warn("[GroupStorefront] Draft save failed", saveError)
      setSaveState("error")
    }
  }, [])

  /**
   * Restore a saved draft, filling in the display fields the draft does not
   * carry.
   *
   * If the price re-read fails the restore is abandoned rather than applied.
   * Applying it without prices would drop every line — a draft holds selections
   * only, so a line the price lookup cannot describe cannot be rendered — and
   * the autosave that followed would then write the emptied cart back over the
   * stored draft. Leaving the draft untouched and offering a retry is the only
   * outcome here that cannot destroy the user's work.
   */
  const restoreDraft = useCallback(async (payload: StoredPayload | undefined) => {
    const savedItems = payload?.draftItems ?? []
    setRestoring(true)

    let priced: Map<number, PricedProduct>
    try {
      priced = await loadPricedProducts(
        savedItems.map((item) => item.organizationInventoryId),
        payload?.groupId ?? null,
      )
    } catch (restoreError) {
      console.warn("[GroupStorefront] Draft restore failed", restoreError)
      setRestoreFailed(true)
      toast({
        title: "Saved group order could not be restored",
        description: "Your draft is safe on the server. Try again to carry on where you left off.",
        variant: "destructive",
      })
      return
    } finally {
      setRestoring(false)
    }

    setRestoreFailed(false)
    onRestoreRef.current({
      groupId: payload?.groupId ?? null,
      branchIds: payload?.draftBranchIds ?? [],
      lines: savedItems.flatMap((item) => toSelectedLine(item, priced)),
      notes: payload?.notes ?? "",
      poNumber: payload?.poNumber ?? "",
    })
    setResumed(true)
  }, [toast])

  useEffect(() => {
    if (hydratedRef.current || isLoading) return
    hydratedRef.current = true

    const payload = data?.item?.payload
    const savedItems = payload?.draftItems ?? []
    const savedBranchIds = payload?.draftBranchIds ?? []

    if (savedItems.length === 0 && savedBranchIds.length === 0) {
      // Nothing to resume. Record what the server already holds so the first
      // render does not fire an autosave that would change nothing.
      lastSavedSignatureRef.current = JSON.stringify(buildDraftPayload({
        groupId: null,
        branchIds: [],
        lines: [],
        notes: "",
        poNumber: "",
      }))
      return
    }

    void restoreDraft(payload)
  }, [data, isLoading, restoreDraft])

  /** Try the restore again after a failed catalogue read. */
  const retryDraftRestore = useCallback(async () => {
    setRetrying(true)
    try {
      await restoreDraft(data?.item?.payload)
    } finally {
      setRetrying(false)
    }
  }, [data, restoreDraft])

  /**
   * Persist selections as they change, so a refresh or another device resumes.
   *
   * Held back while a restore is outstanding, and once an order has been
   * submitted: in both cases the screen does not represent a draft worth
   * keeping, and writing it would replace real work with an empty order.
   */
  useEffect(() => {
    if (!hydratedRef.current || restoring || restoreFailed || suspended) return

    const payload = buildDraftPayload(draft)
    const timer = setTimeout(() => { void saveDraft(payload) }, DRAFT_SAVE_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [draft, restoring, restoreFailed, suspended, saveDraft])

  /**
   * Drop the stored draft once its order exists. Without this the submitted
   * cart reappears the next time the storefront opens.
   */
  const forgetDraft = useCallback(() => {
    lastSavedSignatureRef.current = null
    setSaveState("idle")
    setResumed(false)
    void fetch("/api/v1/group-portal/draft", { method: "DELETE" }).catch(() => undefined)
  }, [])

  const dismissResumed = useCallback(() => setResumed(false), [])

  /**
   * "ready" is the caller's cue that nothing further will arrive from the
   * server, so it may safely pick a default group for a first-time user without
   * that choice landing on top of a draft still being restored.
   */
  const resolveStatus = (): "loading" | "restoring" | "ready" => {
    if (isLoading) return "loading"
    return restoring ? "restoring" : "ready"
  }

  return {
    status: resolveStatus(),
    saveState,
    restoreFailed,
    retrying,
    resumed,
    dismissResumed,
    retryDraftRestore,
    forgetDraft,
  }
}

"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2, Search, Tag } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import {
  formatPriceInput,
  hasPriceChanged,
  isPriceInputInvalid,
  parsePriceInput,
} from "@/lib/group-price-input"
import { canMutatePrices } from "@/lib/pricing-access"
import { formatPKR } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

const PAGE_SIZE = 50

type PricedItem = {
  organizationInventoryId: number
  globalProductId: number
  productCode: string | null
  name: string
  unit: string
  basePriceCents: number
  organizationPriceCents: number | null
  groupPriceCents: number | null
  effectivePriceCents: number | null
}

type PricesResponse = {
  items?: PricedItem[]
  total?: number
  error?: string
}

export type PricedGroup = { id: number; name: string }

/** Which tier the price a branch pays came from. */
function priceSourceBadge(item: PricedItem) {
  if (item.groupPriceCents !== null) {
    return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 border-none">Group</Badge>
  }
  if (item.organizationPriceCents !== null) {
    return <Badge variant="outline" className="text-slate-600 dark:text-slate-300">Organization</Badge>
  }
  return <Badge variant="outline" className="text-slate-500">Global</Badge>
}

/**
 * Set the prices one group pays.
 *
 * Editing a row overrides the organization price for every branch of this group
 * and nothing else — the organization price itself is never written here.
 * Emptying a row clears the override, which returns the product to the
 * organization price. Only the rows actually changed are sent.
 *
 * **Only a Super Admin may change a price.** Every other role that can open
 * this screen sees it read-only: the inputs become plain text and the save
 * control is gone. The endpoint refuses the write regardless — this only keeps
 * the screen from offering an action it would reject.
 */
export function GroupPriceManager({
  group,
  role,
  open,
  onOpenChange,
}: Readonly<{
  group: PricedGroup | null
  /** The viewer's role; only a Super Admin gets editable fields. */
  role: string
  open: boolean
  onOpenChange: (open: boolean) => void
}>) {
  const { toast } = useToast()
  const canEdit = canMutatePrices(role)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [isSaving, setIsSaving] = useState(false)

  const key = group && open
    ? `/api/v1/groups/${group.id}/prices?search=${encodeURIComponent(search)}&page=${page}&limit=${PAGE_SIZE}`
    : null
  const { data, isLoading, mutate: reload } = useSWR<PricesResponse>(key, fetcher, {
    revalidateOnFocus: false,
  })

  // A different group, or a closed dialog, must never carry edits over.
  useEffect(() => {
    setDrafts({})
    setSearch("")
    setPage(1)
  }, [group?.id, open])

  const items = useMemo(() => data?.items ?? [], [data])

  const changed = useMemo(() => {
    return items.filter((item) => {
      const draft = drafts[item.organizationInventoryId]
      if (draft === undefined) return false
      return hasPriceChanged(draft, item.groupPriceCents)
    })
  }, [items, drafts])

  const invalid = changed.filter(
    (item) => isPriceInputInvalid(drafts[item.organizationInventoryId]),
  )

  const save = async () => {
    if (!group || changed.length === 0 || !canEdit) return
    if (invalid.length > 0) {
      toast({
        title: "Check the highlighted prices",
        description: "Enter an amount like 1250 or 1250.50, or leave the box empty to use the organization price.",
        variant: "destructive",
      })
      return
    }

    setIsSaving(true)
    try {
      const response = await fetch(`/api/v1/groups/${group.id}/prices`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prices: changed.map((item) => {
            const parsed = parsePriceInput(drafts[item.organizationInventoryId])
            return {
              organizationInventoryId: item.organizationInventoryId,
              // Guarded by the `invalid` check above, so this is always a
              // usable amount or a deliberate clear.
              customPriceCents: parsed.ok ? parsed.cents : null,
            }
          }),
        }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error || "Failed to update group prices")

      toast({ title: "Group prices updated", description: body.message })
      setDrafts({})
      await reload()
    } catch (saveError) {
      toast({
        title: "Could not update group prices",
        description: saveError instanceof Error ? saveError.message : "Request failed",
        variant: "destructive",
      })
    } finally {
      setIsSaving(false)
    }
  }

  const total = data?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-blue-600" />
            Group Prices{group ? ` — ${group.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            {canEdit
              ? "A price set here applies to every branch in this group. Leave a box empty to use the organization price. The organization price itself is never changed here."
              : "What this group's branches pay for each product. Only a Super Admin can change a price."}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(1)
            }}
            placeholder="Search by product name or code"
            className="pl-9"
          />
        </div>

        <ScrollArea className="h-[420px] rounded-xl border border-slate-100 dark:border-slate-800">
          <Table>
            <TableHeader className="bg-slate-50 dark:bg-slate-800/50">
              <TableRow>
                <TableHead className="font-bold">Product</TableHead>
                <TableHead className="font-bold">Global</TableHead>
                <TableHead className="font-bold">Organization</TableHead>
                <TableHead className="font-bold w-[170px]">Group Price (PKR)</TableHead>
                <TableHead className="font-bold">Branches pay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-slate-500">
                    <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                    Loading catalogue…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-32 text-center text-slate-500 italic">
                    No products found for this organization.
                  </TableCell>
                </TableRow>
              )}
              {items.map((item) => {
                const draft = drafts[item.organizationInventoryId]
                const value = draft ?? formatPriceInput(item.groupPriceCents)
                const isInvalid = isPriceInputInvalid(value)
                return (
                  <TableRow key={item.organizationInventoryId}>
                    <TableCell>
                      <div className="font-medium text-slate-900 dark:text-white">{item.name}</div>
                      <div className="text-xs text-slate-500">
                        {item.productCode || "—"} · per {item.unit}
                      </div>
                    </TableCell>
                    <TableCell className="text-slate-500">{formatPKR(item.basePriceCents / 100)}</TableCell>
                    <TableCell className="text-slate-500">
                      {item.organizationPriceCents === null ? "—" : formatPKR(item.organizationPriceCents / 100)}
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <Input
                          inputMode="decimal"
                          value={value}
                          aria-label={`Group price for ${item.name}`}
                          aria-invalid={isInvalid}
                          className={isInvalid ? "border-rose-400 focus-visible:ring-rose-400" : ""}
                          placeholder="Inherit"
                          onChange={(event) => setDrafts((current) => ({
                            ...current,
                            [item.organizationInventoryId]: event.target.value,
                          }))}
                        />
                      ) : (
                        <span className="text-slate-500">
                          {item.groupPriceCents === null
                            ? "Inherited"
                            : formatPKR(item.groupPriceCents / 100)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {item.effectivePriceCents === null ? "—" : formatPKR(item.effectivePriceCents / 100)}
                        </span>
                        {priceSourceBadge(item)}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </ScrollArea>

        <DialogFooter className="flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <span>Page {page} of {pageCount}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
          {canEdit ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500">
                {changed.length === 0 ? "No changes" : `${changed.length} price(s) to save`}
              </span>
              <Button onClick={save} disabled={isSaving || changed.length === 0}>
                {isSaving && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Save prices
              </Button>
            </div>
          ) : (
            <span className="text-sm text-slate-500">Read-only — Super Admin sets prices</span>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

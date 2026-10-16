"use client"

import type { ReactNode } from "react"
import Image from "next/image"
import useSWR from "swr"
import { Eye, Loader2, Package } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { fetcher } from "@/lib/fetcher"
import { formatPKR } from "@/lib/utils"

/**
 * Pieces shared by the warehouse's read-only catalogue views
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md). Nothing here writes: there is
 * no form, no create, edit or delete control, and the endpoints behind every
 * view export GET alone.
 */

export function CatalogHeader({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Badge variant="outline" className="gap-1 self-start text-xs">
        <Eye className="h-3 w-3" aria-hidden="true" /> View only
      </Badge>
    </div>
  )
}

export function ProductCell({ name, code, imageUrl }: Readonly<{ name: string | null; code: string | null; imageUrl: string | null }>) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {imageUrl ? (
        <Image src={imageUrl} alt="" width={40} height={40} unoptimized className="h-10 w-10 shrink-0 rounded-md border object-cover" />
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        <p className="truncate font-medium" title={name ?? undefined}>{name ?? "—"}</p>
        {code && <p className="truncate font-mono text-xs text-muted-foreground" title={code}>{code}</p>}
      </div>
    </div>
  )
}

export function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "—" : formatPKR(cents / 100)
}

export function day(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

export function ActiveBadge({ active }: Readonly<{ active: boolean }>) {
  return <Badge variant={active ? "default" : "secondary"}>{active ? "active" : "inactive"}</Badge>
}

/** Loading, error and empty states around a table, so each view handles all three. */
export function LoadState({
  error,
  loading,
  empty,
  emptyText,
  errorText,
  children,
}: Readonly<{ error: unknown; loading: boolean; empty: boolean; emptyText: string; errorText: string; children: ReactNode }>) {
  if (error) return <p role="alert" className="p-6 text-sm text-destructive">{errorText}</p>
  if (loading) {
    return <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
  }
  if (empty) return <p className="p-6 text-center text-sm text-muted-foreground">{emptyText}</p>
  return <>{children}</>
}

export function Pager({
  page,
  limit,
  total,
  noun,
  onPage,
}: Readonly<{ page: number; limit: number; total: number; noun: string; onPage: (page: number) => void }>) {
  if (total === 0) return null
  const pageCount = Math.max(1, Math.ceil(total / limit))
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        Showing {(page - 1) * limit + 1}–{Math.min(total, page * limit)} of {total} {noun}
      </span>
      {total > limit && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Page {page} of {pageCount}</span>
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
          <Button size="sm" variant="outline" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}

export type CatalogOrganization = { id: number; name: string }

/** The organizations the warehouse's catalogue covers — those whose branches it serves. */
export function useCatalogOrganizations() {
  const { data, error, isLoading } = useSWR<{ organizations: CatalogOrganization[] }>(
    "/api/v1/warehouse/catalog/organizations",
    fetcher,
    { revalidateOnFocus: false },
  )
  return { organizations: data?.organizations ?? [], error, isLoading }
}

export const ALL = "__all"

export function PickerSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
  allLabel,
  disabled,
}: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
  allLabel?: string
  disabled?: boolean
}>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || (allLabel ? ALL : "")} onValueChange={(next) => onChange(next === ALL ? "" : next)} disabled={disabled}>
        <SelectTrigger id={id} className="w-56 bg-background">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

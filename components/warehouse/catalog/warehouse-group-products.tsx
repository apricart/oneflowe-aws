"use client"

import { useState } from "react"
import useSWR from "swr"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  ActiveBadge,
  CatalogHeader,
  LoadState,
  Pager,
  PickerSelect,
  ProductCell,
  day,
  money,
  useCatalogOrganizations,
} from "@/components/warehouse/catalog/catalog-parts"
import { fetcher } from "@/lib/fetcher"

/**
 * Group Products, view only: an organization's groups and, for a chosen group,
 * the products its branches carry at the price the group pays — group price,
 * else organization price, else base — as Super Admin's Group Products shows
 * them. No assign, remove, activate or price control
 * (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */

type Group = { id: number; name: string; branches: string[] }

type GroupProduct = {
  id: number
  productCode: string
  name: string
  imageUrl: string | null
  unit: string
  basePriceCents: number
  overridePriceCents: number | null
  effectivePriceCents: number
  active: boolean
  branchCount: number
  assignedAt: string | null
}

type GroupProductsResponse = {
  groups: Group[]
  group: Group | null
  items: GroupProduct[]
  total: number
  page: number
  limit: number
}

export function WarehouseGroupProducts() {
  const { organizations, error: organizationsError } = useCatalogOrganizations()
  const [chosenOrganizationId, setOrganizationId] = useState("")
  const organizationId = chosenOrganizationId || (organizations[0] ? String(organizations[0].id) : "")
  const [groupId, setGroupId] = useState("")
  const [page, setPage] = useState(1)

  const params = new URLSearchParams({ organizationId, page: String(page) })
  if (groupId) params.set("groupId", groupId)
  const { data, error, isLoading } = useSWR<GroupProductsResponse>(
    organizationId ? `/api/v1/warehouse/catalog/group-products?${params.toString()}` : null,
    fetcher,
    { keepPreviousData: true },
  )
  const groups = data?.groups ?? []

  return (
    <div className="space-y-4">
      <CatalogHeader title="Group Products" description="What each group's branches carry, and the price the group pays." />
      {organizationsError && <p role="alert" className="text-sm text-destructive">Your organizations could not be loaded.</p>}
      {!organizationsError && organizations.length === 0 && (
        <p className="text-sm text-muted-foreground">No organization is in your reach yet. Super Admin assigns branches on Warehouse Team.</p>
      )}
      {organizations.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-4">
            <PickerSelect
              id="group-products-organization"
              label="Organization"
              value={organizationId}
              onChange={(value) => { setOrganizationId(value); setGroupId(""); setPage(1) }}
              options={organizations.map((organization) => ({ value: String(organization.id), label: organization.name }))}
            />
            <PickerSelect
              id="group-products-group"
              label="Group"
              value={groupId}
              placeholder={groups.length === 0 ? "No groups" : "Select a group"}
              disabled={groups.length === 0}
              onChange={(value) => { setGroupId(value); setPage(1) }}
              options={groups.map((group) => ({ value: String(group.id), label: group.name }))}
            />
          </div>

          {error && <p role="alert" className="text-sm text-destructive">The group's products could not be loaded.</p>}
          {!error && !groupId && data && (
            <p className="text-sm text-muted-foreground">
              {groups.length === 0 ? "This organization has no groups." : "Choose a group to see its products."}
            </p>
          )}

          {groupId && (
            <>
              {data?.group && (
                <Card>
                  <CardContent className="space-y-2 p-4">
                    <p className="text-sm font-medium">Branches in {data.group.name}</p>
                    <div className="flex flex-wrap gap-2">
                      {data.group.branches.length === 0
                        ? <span className="text-sm text-muted-foreground">No branches in this group.</span>
                        : data.group.branches.map((branch) => <Badge key={branch} variant="secondary">{branch}</Badge>)}
                    </div>
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardContent className="p-0">
                  <LoadState
                    error={error}
                    loading={isLoading && !data?.group}
                    empty={Boolean(data && data.items.length === 0)}
                    emptyText="No products are assigned to this group's branches."
                    errorText="The group's products could not be loaded."
                  >
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[860px] text-sm">
                        <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                          <tr>
                            <th className="px-3 py-2">Product</th>
                            <th className="px-3 py-2">Unit</th>
                            <th className="px-3 py-2 text-right">Base price</th>
                            <th className="px-3 py-2 text-right">Group price</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2 text-right">Branches</th>
                            <th className="px-3 py-2">Assigned</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data?.items ?? []).map((item) => (
                            <tr key={item.id} className="border-t">
                              <td className="max-w-[320px] px-3 py-2"><ProductCell name={item.name} code={item.productCode} imageUrl={item.imageUrl} /></td>
                              <td className="px-3 py-2">{item.unit}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{money(item.basePriceCents)}</td>
                              <td className="px-3 py-2 text-right tabular-nums">
                                {item.overridePriceCents === null
                                  ? <span className="text-muted-foreground" title="Inherits the base price">Base</span>
                                  : <Badge variant="outline">{money(item.effectivePriceCents)}</Badge>}
                              </td>
                              <td className="px-3 py-2"><ActiveBadge active={item.active} /></td>
                              <td className="px-3 py-2 text-right tabular-nums">{item.branchCount}</td>
                              <td className="px-3 py-2 text-muted-foreground">{day(item.assignedAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </LoadState>
                </CardContent>
              </Card>
              {data && <Pager page={page} limit={data.limit} total={data.total} noun="products" onPage={setPage} />}
            </>
          )}
        </>
      )}
    </div>
  )
}

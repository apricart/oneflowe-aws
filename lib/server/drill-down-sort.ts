import { orders } from "@/db/schema"

const allowedSortColumns = {
  date: orders.createdAt,
  value: orders.totalCents,
} as const

export function resolveDrillDownSortColumn(input: string | null | undefined) {
  const sortKey = input?.toLowerCase() as keyof typeof allowedSortColumns | undefined
  return (sortKey && allowedSortColumns[sortKey]) || allowedSortColumns.date
}

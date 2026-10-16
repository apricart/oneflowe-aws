"use client"

import { useState } from "react"

import useSWR from "swr"
import { AlertTriangle, CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fetcher } from "@/lib/fetcher"
import { type ApprovalLevelBand, approvalLevelBandText } from "@/lib/order-approval-levels"
import { cn } from "@/lib/utils"

/**
 * Who can approve what, branch by branch, for an organization that uses
 * approval levels (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md, R11).
 *
 * An order is refused when nobody at its branch holds its level, so a branch
 * with a missing level is shown first. Draws nothing for an organization that
 * does not use levels. Counts only; the Users table below names the people.
 */

type Coverage = {
  active: boolean
  levels: ApprovalLevelBand[]
  branches: Array<{ id: number; name: string; holders: Record<string, number>; missingLevels: number[] }>
}

/** The endpoint answers these two only; nobody else is asked. Presentation, not the control. */
const COVERAGE_READER_ROLES = new Set(["SUPER_ADMIN", "HEAD_OFFICE"])

export function ApprovalLevelCoverage({
  organizationId,
  role,
}: Readonly<{ organizationId: number | null; role: string | null | undefined }>) {
  const [showAll, setShowAll] = useState(false)
  const reads = Boolean(organizationId) && COVERAGE_READER_ROLES.has(role ?? "")
  const { data, error } = useSWR<Coverage>(
    reads ? `/api/v1/approval-levels/coverage?organizationId=${organizationId}` : null,
    fetcher,
  )

  if (!organizationId || error || !data?.active) return null

  const gaps = data.branches.filter((branch) => branch.missingLevels.length > 0)
  const shown = showAll ? data.branches : gaps

  return (
    <Card className="rounded-2xl border-slate-200 dark:border-slate-800">
      <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
        <div>
          <CardTitle className="text-base">Approval level coverage</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each pending order goes to the holders of its level at its branch. A branch missing a level cannot
            place orders in that level&apos;s range.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show gaps only" : "Show all branches"}
        </Button>
      </CardHeader>
      <CardContent>
        {gaps.length === 0 && !showAll ? (
          <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Every branch has someone at every level.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Branch</th>
                  {data.levels.map((band) => (
                    <th key={band.level} className="px-2 py-2 text-center font-medium" title={approvalLevelBandText(band)}>
                      Level {band.level}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((branch) => (
                  <tr key={branch.id} className="border-b last:border-0">
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-1.5">
                        {branch.missingLevels.length > 0 && (
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-label="Missing a level" />
                        )}
                        {branch.name}
                      </span>
                    </td>
                    {data.levels.map((band) => {
                      const count = branch.holders[String(band.level)] ?? 0
                      return (
                        <td
                          key={band.level}
                          className={cn(
                            "px-2 py-2 text-center tabular-nums",
                            count === 0 ? "font-semibold text-rose-600" : "text-slate-700 dark:text-slate-300",
                          )}
                        >
                          {count === 0 ? "None" : count}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

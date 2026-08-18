"use client"

import { AlertTriangle, CheckCircle2, Copy, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { formatPKR } from "@/lib/utils"

import type { GroupOrderSubmission } from "./types"

/**
 * What happened, branch by branch.
 *
 * Branches are created independently, so a submission can partly succeed. The
 * failures carry the reason the server gave — an insufficient budget, an item
 * withdrawn from that branch — because that is what the user needs in order to
 * correct it on the next group order.
 */
export function SubmissionResult({
  submission,
  onStartAnother,
}: Readonly<{
  submission: GroupOrderSubmission
  onStartAnother: () => void
}>) {
  const { toast } = useToast()

  const created = submission.results.filter((result) => result.status === "created")
  const failed = submission.results.filter((result) => result.status === "failed")
  const totalCents = created.reduce(
    (sum, result) => sum + (result.status === "created" ? result.totalCents : 0),
    0,
  )

  const copyReference = async () => {
    try {
      await navigator.clipboard.writeText(submission.reference)
      toast({ title: "Reference copied", description: submission.reference })
    } catch {
      toast({
        title: "Could not copy",
        description: `Your reference is ${submission.reference}`,
        variant: "destructive",
      })
    }
  }

  return (
    <div className="space-y-5">
      <Card
        className={failed.length === 0
          ? "rounded-2xl border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20"
          : "rounded-2xl border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20"}
      >
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            {failed.length === 0
              ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-amber-600 dark:text-amber-400" />}
            <div>
              <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {failed.length === 0
                  ? "Group order submitted"
                  : `Group order submitted — ${failed.length} branch${failed.length === 1 ? "" : "es"} skipped`}
              </h2>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                {created.length} order{created.length === 1 ? "" : "s"} created
                {created.length > 0 && <> · {formatPKR(totalCents / 100)} combined</>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Group order ID
              </p>
              <p className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                {submission.reference}
              </p>
            </div>
            <Button type="button" variant="outline" size="icon" aria-label="Copy group order ID" onClick={copyReference}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {failed.length > 0 && (
        <Card className="rounded-2xl border-rose-200 dark:border-rose-900/60">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-rose-700 dark:text-rose-400">
              Not ordered — correct these and submit a new group order
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {failed.map((result) => (
                <li
                  key={result.branchId}
                  className="rounded-xl border border-rose-100 bg-rose-50/50 p-3 text-sm dark:border-rose-900/50 dark:bg-rose-950/20"
                >
                  <p className="font-medium text-slate-900 dark:text-slate-100">{result.branchName}</p>
                  <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
                    {result.status === "failed" ? result.reason : null}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {created.length > 0 && (
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Orders created</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    <th scope="col" className="pb-2 font-medium">Branch</th>
                    <th scope="col" className="pb-2 font-medium">Order</th>
                    <th scope="col" className="pb-2 text-right font-medium">Items</th>
                    <th scope="col" className="pb-2 text-right font-medium">Total</th>
                    <th scope="col" className="pb-2 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {created.map((result) => (
                    <tr key={result.branchId} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                      <td className="py-2 pr-3 text-slate-800 dark:text-slate-200">{result.branchName}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-slate-600 dark:text-slate-300">
                        {result.status === "created" ? result.tid : null}
                      </td>
                      <td className="py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                        {result.status === "created" ? result.itemCount : null}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
                        {result.status === "created" ? formatPKR(result.totalCents / 100) : null}
                      </td>
                      <td className="py-2 text-right">
                        <Badge variant="secondary">Pending approval</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Button type="button" className="gap-2" onClick={onStartAnother}>
        <Plus className="h-4 w-4" />
        Start another group order
      </Button>
    </div>
  )
}

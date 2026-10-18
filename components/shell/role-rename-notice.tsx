"use client"

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { ArrowRight, CheckCircle2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  clearRoleRenameNoticeDue,
  isRoleRenameNoticeDue,
  roleRenamesToAnnounce,
} from "@/lib/role-rename-notice"

/**
 * Tells a person, once after they sign in, that four roles have new names and
 * that nothing else has changed. Mounted by every landing area; the login page
 * marks it due (`lib/role-rename-notice.ts`).
 */
export function RoleRenameNotice() {
  const { data: session, status } = useSession()
  const [open, setOpen] = useState(false)

  // Read after mount so the server-rendered markup and the first client render
  // agree; the mark lives in this tab's sessionStorage.
  useEffect(() => {
    if (status === "authenticated" && isRoleRenameNoticeDue()) setOpen(true)
  }, [status])

  const close = () => {
    clearRoleRenameNoticeDue()
    setOpen(false)
  }

  const renames = roleRenamesToAnnounce((session?.user as { role?: string } | undefined)?.role)

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-xl">Some role names have changed</DialogTitle>
          <DialogDescription className="text-base text-slate-700 dark:text-slate-300">
            This is only a name change.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            Nothing else is affected. Your work stays exactly the same as before: you sign in,
            order, approve and see everything just as you did.
          </p>
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Old name → New name
          </p>
          <ul className="space-y-2">
            {renames.map((rename) => (
              <li
                key={rename.role}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-slate-50 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-900"
              >
                <span className="font-semibold text-slate-600 dark:text-slate-400">{rename.previousName}</span>
                <ArrowRight className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" strokeWidth={2.75} aria-hidden="true" />
                <span className="sr-only">is now called</span>
                <span className="rounded-md bg-indigo-100 px-2 py-0.5 font-bold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">
                  {rename.newName}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <Button type="button" onClick={close} className="w-full sm:w-auto">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

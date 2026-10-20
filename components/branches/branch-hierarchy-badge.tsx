import { Badge } from "@/components/ui/badge"
import { describeBranchHierarchy, normalizeBranchHierarchyRole } from "@/lib/branch-hierarchy"
import { cn } from "@/lib/utils"

const TONES = {
  PARENT: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300",
  CHILD: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300",
  STANDALONE: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300",
} as const

/**
 * A branch's parent / child label as a badge: "Parent branch", "Child of X"
 * or "Standalone" (plans/OF-BRANCH-parent-child-label.md). The text carries
 * the meaning; the colour only repeats it.
 */
export function BranchHierarchyBadge({
  branch,
  className,
}: Readonly<{
  branch: { hierarchyRole?: unknown; parentBranchName?: string | null }
  className?: string
}>) {
  const role = normalizeBranchHierarchyRole(branch.hierarchyRole)
  const text = describeBranchHierarchy(branch)
  return (
    <Badge variant="outline" className={cn("max-w-full truncate text-[10px] font-semibold", TONES[role], className)} title={text}>
      {text}
    </Badge>
  )
}

import type { ComponentProps } from "react"

import { cn } from "@/lib/utils"

/**
 * Bounded scroll box for a report table, matching the Orders page.
 *
 * Rows scroll inside the box rather than the page, so the horizontal scrollbar
 * sits in the viewport instead of below the last row, and the header row sticks
 * to the top of the box. The `.report-table-scroll` rules in `app/globals.css`
 * also set the compact row and column spacing, and apply only to the table that
 * is a direct child — a table nested in an expanded row keeps its own layout.
 *
 * Wrap a `<Table>` from `components/ui/table` directly; its own overflow
 * container is neutralised so this box is the single scroll container (sticky
 * cells stick to their nearest scrolling ancestor).
 */
export function ReportTableScroll({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="report-table-scroll"
      className={cn(
        "report-table-scroll max-h-[max(24rem,calc(100dvh-14rem))] w-full min-w-0 max-w-full",
        className,
      )}
      {...props}
    />
  )
}

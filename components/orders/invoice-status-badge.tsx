import { Badge } from "@/components/ui/badge"
import { INVOICE_STATUS_LABELS, toInvoiceStatus, type InvoiceStatus } from "@/lib/invoice-status"
import { cn } from "@/lib/utils"

const BADGE_CLASSES: Record<InvoiceStatus, string> = {
  NOT_ISSUED: "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400",
  PROFORMA_AVAILABLE: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  ISSUED: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  PARTIALLY_CREDITED: "border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300",
  CREDITED: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
  CANCELLED: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300",
}

/**
 * The invoice's stage as the server computed it (lib/invoice-status.ts).
 * Renders a dash for a value outside the known set rather than guessing.
 */
export function InvoiceStatusBadge({ status, className }: Readonly<{ status: unknown; className?: string }>) {
  const invoiceStatus = toInvoiceStatus(status)
  if (!invoiceStatus) return <span className="text-slate-300 dark:text-slate-600">—</span>
  return (
    <Badge
      variant="outline"
      className={cn("whitespace-nowrap rounded-lg border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider", BADGE_CLASSES[invoiceStatus], className)}
    >
      {INVOICE_STATUS_LABELS[invoiceStatus]}
    </Badge>
  )
}
